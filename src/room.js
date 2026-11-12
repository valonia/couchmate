// The shared room: what is playing, play/pause and position, kept in sync on every device over WebSocket.
// Also runs the things that act on the whole room: "next episode", reminders that switch channel,
// new-episode checks for favourites, and live chat relayed from the playing plugin.
//
// Media always comes from a plugin. The room only knows "plugin X has item Y that can be played";
// the plugin's resolve() decides where the stream is.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { clean, str, ITEM_ID, SAFE_ID, JsonFile } from './util.js';
import { Translator, T } from './i18n.js';

const PREPARE_AHEAD_S = 30; // music: the next item is prepared this long before "next" shows
const START_DELAY_MS = 800; // everyone starts this long after "go", so they start together
const EMPTY_PAUSE_MS = 60 * 1000; // nobody connected this long: pause (a short drop-out or an app restart does not)

const now = () => Date.now();

export class Room {
  constructor({ settings, plugins, streams, history, favorites, favoriteGroupOrder = null, reminders, translator, roomFile, log = console.log }) {
    this.favoriteGroupOrder = favoriteGroupOrder;
    Object.assign(this, { settings, plugins, streams, history, favorites, reminders, translator, roomFile, log });
    this.state = {
      media: null,
      paused: true,
      waiting: false, // paused until every viewer has buffered
      position: 0, // seconds into the media at refTime (server clock, ms)
      refTime: now(),
      version: 0,
      changedBy: null,
      action: null,
      upNext: null, // { item, startsAt, early?, media? } – the next one starts automatically at startsAt
      preparedNext: null, // { item, media } – music: what follows, sent early so the apps can start buffering it
      reminder: null, // { key, title, start, channel, switchAt } – switches everyone at switchAt
    };
    this.clients = new Map(); // ws → client
    // Names the admin gave: "<name the app sends>|<device>" → the name everyone sees (the apps need no update).
    this.aliases = new JsonFile(path.join(path.dirname(roomFile), 'aliases.json'), {});
    this.waitTimer = null;
    this.upNextTimer = null;
    this.checkingNext = false;
    this.saveTimer = null;
    this.chatRelay = null;
    this.timers = [
      setInterval(() => this.checkEnded(), 1000),
      setInterval(() => this.checkStatus(), 2 * 60 * 1000), // e.g. which favourite channels are live
      setInterval(() => this.checkReminders(), 1000),
      setInterval(() => this.checkEmpty(), 5000),
      setInterval(() => this.flushChat(), 800),
      setInterval(() => this.heartbeat(), 20000),
      setInterval(() => { if (this.state.media && !this.state.paused) { this.history.progress(this.state.media, this.position()); this.writeRoom(); } }, 15000),
    ];
    this.timers.forEach((t) => t.unref?.());
    this.scheduleEpisodeChecks();
    settings.onChange((changed) => { if (changed.includes('newEpisodeCheckMinutes')) this.scheduleEpisodeChecks(); });
  }

  // ------------------------------------------------------------ helpers

  position() {
    const s = this.state;
    if (s.paused) return s.position;
    return s.position + Math.max(0, now() - s.refTime) / 1000;
  }

  /** Sends to one client, in that device's language. */
  send(c, msg) {
    if (c.ws.readyState !== 1) return;
    c.ws.send(JSON.stringify(this.translator.localize(msg, c.lang)));
  }

  /** Sends to everyone (translated once per language). */
  broadcast(msg) {
    const byLang = new Map();
    for (const c of this.clients.values()) {
      if (c.ws.readyState !== 1) continue;
      if (!byLang.has(c.lang)) byLang.set(c.lang, JSON.stringify(this.translator.localize(msg, c.lang)));
      c.ws.send(byLang.get(c.lang));
    }
  }

  stateMsg() { return { type: 'state', state: this.state, serverTime: now() }; }
  broadcastState() { this.broadcast(this.stateMsg()); }

  members() {
    return [...this.clients.values()].filter((c) => c.name).map((c) => ({
      id: c.id, name: c.name, device: c.device, watching: c.watching, lang: c.lang || 'en',
      ownName: c.sentName && c.sentName !== c.name ? c.sentName : null, // the name the app itself uses, when renamed
      // Last report from the device: position and drift (s) against where it should be.
      position: c.position ?? null, drift: c.drift ?? null, status: c.status ?? null,
      reportAge: c.reportedAt ? Math.round((now() - c.reportedAt) / 1000) : null,
    }));
  }
  broadcastMembers() { this.broadcast({ type: 'members', members: this.members().map(({ id, name, device, watching }) => ({ id, name, device, watching })) }); }
  broadcastFavorites() { this.broadcast(this.favoritesMsg()); }
  /** The favourites, each with the group it shows under (named by its plugin, or the usual one for its kind). */
  favoritesMsg() {
    // The order of the groups is the admin's (favoriteGroupOrder), else what the plugins suggest.
    const pos = this.favoriteGroupOrder?.positions(this.plugins.favoriteGroupList());
    return {
      type: 'favorites',
      favorites: this.favorites.list().map((f) => {
        const group = this.plugins.favoriteGroup(f.plugin, f.kind);
        return { ...f, group: { ...group, order: pos?.get(group.id) ?? group.order } };
      }),
    };
  }
  broadcastReminders() { this.broadcast({ type: 'reminders', reminders: this.reminders.list() }); }
  broadcastHistory() { this.broadcast({ type: 'history_changed' }); }

  everyoneWatches() { for (const o of this.clients.values()) if (o.name) o.watching = true; }

  // ------------------------------------------------------------ state changes

  mutate(by, action, fn) {
    this.clearUpNext(); // every change (load, pause, seek, stop) cancels "next episode"
    clearTimeout(this.waitTimer);
    this.waitTimer = null;
    const s = this.state;
    if (s.media) this.history.progress(s.media, this.position()); // remember where we were (resume)
    fn();
    if (action === 'load' && s.media) {
      this.history.touch(s.media, by, s.position);
      if (this.favorites.markEpisodeSeen(s.media.plugin, s.media.id)) this.broadcastFavorites();
      this.broadcastHistory();
    }
    this.dropStale();
    s.version++;
    s.changedBy = by;
    s.action = action;
    if (s.waiting) this.waitTimer = setTimeout(() => this.startPlayback('timeout'), Number(this.settings.get('startTimeoutMs')));
    this.broadcastState();
    this.checkReady();
    this.saveRoom();
    this.updateChat();
    this.plugins.emit(action, { by, media: s.media, state: { ...s } });
    this.plugins.emit('state', { by, action, state: { ...s } });
  }

  startPlayback(reason) {
    const s = this.state;
    if (!s.waiting) return;
    clearTimeout(this.waitTimer);
    this.waitTimer = null;
    s.waiting = false;
    s.paused = false;
    s.refTime = now() + START_DELAY_MS;
    s.version++;
    s.action = 'start';
    if (reason === 'timeout') this.log('[room] not everyone was ready in time – starting anyway');
    this.broadcastState();
    this.saveRoom();
  }

  checkReady() {
    if (!this.state.waiting) return;
    const required = [...this.clients.values()].filter((c) => c.name && c.watching);
    if (required.every((c) => c.readyVersion === this.state.version)) this.startPlayback('ready');
  }

  /** Let the plugins' stream caches know what is no longer playing. */
  dropStale() { this.streams.playing(this.state.media); }

  /**
   * Asks the plugin where the item's stream is and builds the room's media.
   * meta = what the app already knows (title, image …) – used where the plugin's answer has nothing.
   */
  async buildMedia(plugin, id, meta = {}) {
    if (!SAFE_ID.test(str(plugin)) || !ITEM_ID.test(str(id))) throw new Error('Invalid item');
    if (!this.plugins.has(plugin, 'resolve')) throw new Error(`The plugin "${plugin}" is not available`);
    const r = await this.streams.resolve(plugin, id, this.plugins.playerOptions(plugin, new URLSearchParams()));
    const item = this.plugins.item(plugin, { ...meta, ...Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined && v !== null)), id });
    const live = r.live !== undefined ? Boolean(r.live) : Boolean(meta.live);
    const media = {
      plugin,
      id,
      kind: item.kind,
      title: item.title,
      subtitle: item.subtitle,
      image: item.image,
      live,
      url: `/stream/${plugin}/${encodeURIComponent(id)}`,
      // 'hls' or 'file' – so players know what they get (the address has no file extension).
      type: r.type,
      // The video has a separate audio file: the apps fetch it from the same address with ?part=audio.
      audio: Boolean(r.audio),
      // The plugin has captions for it: apps with CC on fetch them from the same address with ?part=captions.
      captions: Boolean(r.captions),
      chat: live && this.plugins.has(plugin, 'chat'),
      // The plugin decides the player's keys and settings; the apps draw them.
      player: this.plugins.playerSpec(plugin, r.player),
    };
    // The plugin's own player description, kept to rebuild `player` – not sent to the apps.
    Object.defineProperty(media, 'playerRaw', { value: r.player && typeof r.player === 'object' ? r.player : null, enumerable: false });
    // The length the plugin knows (if any) – used until the apps report it.
    Object.defineProperty(media, 'knownDuration', { value: Number(r.duration) > 0 ? Number(r.duration) : null, enumerable: false });
    return media;
  }

  /**
   * seamless: start right away without waiting for everyone to be ready – used when the next item follows
   * straight on (the apps have buffered it in advance). `media` = already built (skips asking the plugin).
   */
  async load(by, { plugin, id, position = 0, meta = {}, media: prebuilt = null, seamless = false }) {
    const media = prebuilt || await this.buildMedia(plugin, id, meta);
    const pos = Math.max(0, Number(position) || 0);
    this.everyoneWatches(); // everyone jumps into the player when something new is loaded
    this.upNextDismissed = null;
    this.prepared = null;
    for (const o of this.clients.values()) o.nextReady = null;
    this.mutate(by, 'load', () => {
      const s = this.state;
      s.preparedNext = null;
      s.media = media;
      s.refTime = now();
      if (media.live || seamless) {
        s.position = media.live ? 0 : pos; s.paused = false; s.waiting = false;
      } else {
        s.position = pos; s.paused = true; s.waiting = true;
      }
    });
    if (media.knownDuration && !this.history.durationOf(media)) this.history.setDuration(media, media.knownDuration);
    this.broadcastMembers();
    this.log(`[room] ${by || 'Couchmate'} started "${typeof media.title === 'object' ? media.title[T] : media.title}" (${plugin})`);
    return media;
  }

  play(by) {
    const s = this.state;
    if (!s.media) return;
    if (s.media.live) {
      if (s.paused) this.mutate(by, 'play', () => { s.paused = false; s.refTime = now(); });
    } else if (s.paused && !s.waiting) {
      this.mutate(by, 'play', () => { s.waiting = true; });
    }
  }

  /** Nobody has had an app open for a minute: pause where it is, so nothing plays on (or moves on to the next
   *  episode or song) for an empty room, and everyone comes back to where they stopped. Live TV is left alone –
   *  there is nothing to come back to there. */
  checkEmpty() {
    if ([...this.clients.values()].some((c) => c.name)) { this.emptySince = null; this.emptyNoticed = false; return; }
    this.emptySince ??= now();
    if (now() - this.emptySince < EMPTY_PAUSE_MS) return;
    // Empty for a minute: things that wait until nobody is in (e.g. plugin updates) may go ahead now.
    if (!this.emptyNoticed) { this.emptyNoticed = true; this.onEmpty?.(); }
    const s = this.state;
    if (!s.media || s.media.live || (s.paused && !s.waiting)) return;
    this.log('[room] nobody is watching – paused');
    this.pause(null);
  }

  /** Whether any app is connected (updates wait until nobody is). */
  occupied() { return [...this.clients.values()].some((c) => c.name); }

  pause(by) {
    const s = this.state;
    if (!s.media || (s.paused && !s.waiting)) return;
    this.mutate(by, 'pause', () => { s.position = this.position(); s.paused = true; s.waiting = false; });
  }

  seek(by, position) {
    const s = this.state;
    if (!s.media || s.media.live) return;
    const p = Math.max(0, Number(position) || 0);
    const wasPlaying = !s.paused || s.waiting;
    this.mutate(by, 'seek', () => { s.position = p; s.paused = true; s.waiting = wasPlaying; });
  }

  stop(by) {
    const s = this.state;
    if (!s.media) return;
    this.mutate(by, 'stop', () => { s.media = null; s.paused = true; s.waiting = false; s.position = 0; });
    this.log(`[room] ${by || 'Couchmate'} stopped playback`);
  }

  // ------------------------------------------------------------ messages from the apps

  handle(c, msg) {
    const s = this.state;
    switch (msg.type) {
      case 'hello':
        c.sentName = clean(msg.name, 40) || 'Guest';
        c.device = clean(msg.device, 40);
        // Newer apps send a fixed id of their own; older ones are known by name and device.
        c.deviceId = /^[A-Za-z0-9-]{8,64}$/.test(str(msg.deviceId)) ? str(msg.deviceId) : null;
        c.aliasKey = c.deviceId ? `id:${c.deviceId}` : `${c.sentName}|${c.device}`;
        // Renamed while it still had an older app: the name moves over to its id.
        const legacy = `${c.sentName}|${c.device}`;
        if (c.deviceId && !this.aliases.data[c.aliasKey] && this.aliases.data[legacy]) {
          this.aliases.data[c.aliasKey] = this.aliases.data[legacy];
          delete this.aliases.data[legacy];
          this.aliases.save();
        }
        c.name = this.aliases.data[c.aliasKey] || c.sentName;
        // Renamed by the admin: newer apps take the name over in their own settings (older ones just keep theirs).
        if (c.name !== c.sentName) this.send(c, { type: 'name', name: c.name });
        c.lang = Translator.normalize(msg.lang);
        this.translator.prepare(c.lang);
        this.send(c, { type: 'translations_version', lang: c.lang, version: this.translator.version(c.lang) });
        this.send(c, this.stateMsg());
        this.send(c, this.favoritesMsg());
        this.send(c, { type: 'reminders', reminders: this.reminders.list() });
        this.broadcastMembers();
        this.log(`[room] ${c.name} (${c.device || 'unknown device'}) connected`);
        this.plugins.emit('member_join', { id: c.id, name: c.name, device: c.device });
        break;

      case 'lang':
        c.lang = Translator.normalize(msg.lang);
        this.send(c, { type: 'translations_version', lang: c.lang, version: this.translator.version(c.lang) });
        this.send(c, this.stateMsg());
        break;

      case 'ping':
        this.send(c, { type: 'pong', t: msg.t, s: now() });
        break;

      case 'watching':
        c.watching = Boolean(msg.value);
        this.broadcastMembers();
        this.checkReady();
        break;

      case 'ready':
        if (Number(msg.duration) > 0) this.history.setDuration(s.media, Number(msg.duration));
        if (msg.version === s.version) { c.readyVersion = msg.version; this.checkReady(); }
        break;

      case 'duration':
        if (Number(msg.value) > 0) this.history.setDuration(s.media, Number(msg.value));
        break;

      case 'load': {
        const plugin = str(msg.plugin);
        const id = str(msg.id);
        this.load(c.name, { plugin, id, position: msg.position, meta: msg.meta && typeof msg.meta === 'object' ? msg.meta : {} })
          .catch((e) => { this.log(`[room] ${plugin}:${id} – ${e.message}`); this.send(c, { type: 'error', text: e.message }); });
        break;
      }

      case 'toggle':
        if (s.media) (s.paused && !s.waiting ? this.play(c.name) : this.pause(c.name));
        break;
      case 'play': this.play(c.name); break;
      case 'pause': this.pause(c.name); break;
      case 'seek': this.seek(c.name, msg.position); break;
      case 'stop': this.stop(c.name); break;

      case 'report': {
        const pos = Number(msg.position);
        const at = Number(msg.at) || now();
        if (!Number.isFinite(pos)) return;
        c.position = pos;
        c.status = clean(msg.status, 60) || null;
        c.reportedAt = now();
        if (s.media && !s.media.live && !s.waiting) {
          const expected = s.paused || at < s.refTime ? s.position : s.position + (at - s.refTime) / 1000;
          c.drift = Math.round((pos - expected) * 1000) / 1000;
        } else c.drift = null;
        break;
      }

      case 'player_action': {
        // A button in the player's settings (type 'actions') – the plugin decides what happens.
        const m = s.media;
        const action = clean(msg.action, 32);
        if (!m || !m.player?.settings.some((x) => x.type === 'actions' && x.options.some((o) => o.id === action))) break;
        this.plugins.call(m.plugin, 'action', [m.id, action, { by: c.name }], 15000)
          .catch((e) => this.log(`[${m.plugin}] button ${action}: ${e.message}`));
        break;
      }

      case 'chat_sub':
        c.chat = Boolean(msg.on);
        if (c.chat) this.send(c, { type: 'chat', key: this.chatRelay?.key || null, reset: true, messages: this.chatRelay?.buf || [] });
        this.updateChat();
        break;

      case 'next_ready':
        // The app has buffered the next one (shown before the end) – see playUpNext.
        c.nextReady = [s.upNext?.early ? s.upNext.item.id : null, s.preparedNext?.item.id].includes(str(msg.id)) ? str(msg.id) : null;
        break;

      case 'next_now':
        if (s.upNext) this.playUpNext(c.name);
        break;

      case 'next_cancel':
        if (s.upNext?.early) {
          // Shown before the end: this one plays to the end and then stops.
          this.clearUpNext();
          this.upNextDismissed = s.media;
          s.preparedNext = null;
          s.version++;
          s.action = 'upnext_cancel';
          this.broadcastState();
          this.log(`[room] ${c.name} cancelled what plays next`);
        } else if (s.upNext) {
          this.mutate(c.name, 'pause', () => { s.position = this.position(); s.paused = true; s.waiting = false; });
          this.log(`[room] ${c.name} cancelled the next episode`);
        }
        break;

      case 'fav_add':
        this.addFavorite(c, msg.item).catch((e) => this.log(`[favorites] could not add: ${e.message}`));
        break;
      case 'fav_remove':
        if (this.favorites.remove(str(msg.key))) this.broadcastFavorites();
        break;
      case 'fav_seen':
        if (this.favorites.markSeen(str(msg.key))) this.broadcastFavorites();
        break;

      case 'reminder_add': {
        const plugin = str(msg.plugin);
        const ch = msg.channel || {};
        const pr = msg.program || {};
        const id = str(ch.id);
        const start = Math.floor(Number(pr.start));
        const end = Math.floor(Number(pr.end));
        if (!SAFE_ID.test(plugin) || !ITEM_ID.test(id) || !(start > 0) || !(end > start) || end <= now() / 1000) return;
        const added = this.reminders.add({
          plugin,
          channel: { id, title: clean(ch.title, 200) || id, image: this.plugins.imageUrl(plugin, ch.image) },
          title: clean(pr.title, 200) || '?',
          desc: clean(pr.description, 1000) || null,
          start,
          end,
        }, c.name);
        if (added) { this.broadcastReminders(); this.checkReminders(); }
        break;
      }
      case 'reminder_remove': {
        const key = str(msg.key);
        if (this.reminders.remove(key)) this.broadcastReminders();
        if (s.reminder?.key === key) this.clearReminder(true);
        break;
      }
      case 'reminder_now':
        if (s.reminder) this.playReminder(c.name);
        break;
      case 'reminder_cancel':
        if (s.reminder) {
          this.log(`[reminders] ${c.name} cancelled "${s.reminder.title}"`);
          this.reminders.remove(s.reminder.key);
          this.clearReminder(true);
          this.broadcastReminders();
        }
        break;

      case 'history_remove':
        this.history.remove(str(msg.key));
        this.broadcastHistory();
        break;
      case 'history_clear':
        this.history.clear();
        this.broadcastHistory();
        this.log(`[room] ${c.name} cleared the history`);
        break;
    }
  }

  // ------------------------------------------------------------ connections

  attach(ws) {
    const c = { id: randomUUID().slice(0, 8), ws, name: null, device: '', lang: null, watching: false, readyVersion: -1, alive: true };
    this.clients.set(ws, c);
    ws.on('pong', () => { c.alive = true; });
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      try { this.handle(c, msg); } catch (e) { this.log('[ws]', e); }
    });
    ws.on('close', () => {
      this.clients.delete(ws);
      this.updateChat();
      if (c.name) {
        this.log(`[room] ${c.name} left`);
        this.plugins.emit('member_leave', { id: c.id, name: c.name, device: c.device });
      }
      this.broadcastMembers();
      this.checkReady();
    });
  }

  heartbeat() {
    for (const [ws, c] of this.clients) {
      if (!c.alive) { ws.terminate(); continue; }
      c.alive = false;
      ws.ping();
    }
  }

  /** The admin renames a device: everyone sees the new name, also after it reconnects. Empty = its own name again. */
  rename(id, name) {
    const c = [...this.clients.values()].find((x) => x.id === id && x.name);
    if (!c) return false;
    const key = c.aliasKey;
    const to = clean(name, 40);
    if (!to || to === c.sentName) delete this.aliases.data[key];
    else this.aliases.data[key] = to;
    this.aliases.save();
    const before = c.name;
    c.name = to || c.sentName;
    this.log(`[admin] renamed ${before} to ${c.name}`);
    this.send(c, { type: 'name', name: c.name }); // the app shows it in its settings too
    this.broadcastMembers();
    return true;
  }

  kick(id) {
    for (const [ws, c] of this.clients) {
      if (c.id === id) { this.log(`[admin] disconnected ${c.name}`); ws.close(4000, 'Disconnected by the admin'); return true; }
    }
    return false;
  }

  /**
   * New translations are ready for [lang]: the devices with that language get the room's state again and are
   * told to fetch their menu and open view again (all of it was sent in English while it was being translated).
   */
  textsTranslated(lang) {
    clearTimeout(this.textsTimers?.[lang]);
    (this.textsTimers ||= {})[lang] = setTimeout(() => {
      for (const c of this.clients.values()) {
        if (c.lang !== lang) continue;
        this.send(c, this.stateMsg());
        this.send(c, { type: 'texts_changed' });
      }
    }, 700);
  }

  /** Every app disconnects (e.g. the PIN changed) and has to log in again. */
  disconnectAll(code, reason) {
    for (const ws of this.clients.keys()) ws.close(code, reason);
  }

  // ------------------------------------------------------------ next episode

  clearUpNext() {
    clearTimeout(this.upNextTimer);
    this.upNextTimer = null;
    this.state.upNext = null;
  }

  playUpNext(by) {
    const up = this.state.upNext;
    if (!up?.item) return;
    this.clearUpNext();
    const next = up.item;
    // Shown before the end, prepared, and every app watching has buffered it: it follows straight on. Otherwise
    // (an app without buffering, a slow connection) everyone waits for each other as usual, so nobody misses the start.
    const watching = [...this.clients.values()].filter((c) => c.name && c.watching);
    const seamless = Boolean(up.early && up.media) && watching.every((c) => c.nextReady === next.id);
    if (up.early && !seamless) this.log('[room] not every app had buffered the next one – waiting for everyone');
    this.load(by, { plugin: next.plugin, id: next.id, meta: next, media: seamless ? up.media : null, seamless })
      .catch((e) => this.log(`[room] next: ${e.message}`));
  }

  /**
   * Runs every second: when something has ended, "next" is shown and starts after a while. Plugins with
   * player.upNextBefore (music) show it that many seconds before the end instead, and the next item follows
   * straight on when this one ends. The next one is prepared a little earlier still (asking the plugin can take
   * several seconds), so the card shows on time – and the apps are told at once, so they get those seconds to buffer it.
   */
  async checkEnded() {
    const s = this.state;
    const cur = s.media;
    if (this.checkingNext || !cur || cur.live || s.paused || s.waiting || s.upNext) return;
    const dur = this.history.durationOf(cur);
    if (!(dur > 0)) return;
    const before = Number(cur.player?.upNextBefore) || 0;
    const left = dur - this.position();
    if (left > (before > 0 ? before + PREPARE_AHEAD_S : 1)) return;
    // Cancelled: play to the end, then stop there.
    if (this.upNextDismissed === cur) {
      if (left <= 1) this.mutate(null, 'ended', () => { s.position = dur; s.paused = true; });
      return;
    }
    let p = this.prepared?.cur === cur ? this.prepared : null;
    if (!p) {
      this.checkingNext = true;
      try {
        let next = null;
        if (this.plugins.has(cur.plugin, 'next')) {
          next = this.plugins.item(cur.plugin, await this.plugins.call(cur.plugin, 'next', [cur.id], 15000).catch(() => null));
        }
        // Early: get the next one's stream now, so the apps can buffer it.
        const media = next && before > 0
          ? await this.buildMedia(next.plugin, next.id, next).catch((e) => { this.log(`[room] preparing the next one: ${e.message}`); return null; })
          : null;
        if (s.media !== cur) return;
        p = this.prepared = { cur, next, media };
      } finally {
        this.checkingNext = false;
      }
    }
    // Music: tell the apps what follows right away – they buffer it from now on, the card comes later.
    if (before > 0 && p.next && p.media && s.media === cur && this.upNextDismissed !== cur && s.preparedNext?.item.id !== p.next.id) {
      s.preparedNext = { item: p.next, media: p.media };
      this.broadcastState();
    }
    if (s.paused || s.waiting || s.upNext || this.upNextDismissed === cur) return;
    const leftNow = dur - this.position();
    if (!p.next) {
      // Nothing comes after this – stay at the end.
      if (leftNow <= 1) this.mutate(null, 'ended', () => { s.position = dur; s.paused = true; });
      return;
    }
    if (before > 0) {
      if (leftNow > before) return; // prepared – the card comes later
      const wait = Math.max(0, leftNow * 1000);
      s.upNext = { item: p.next, startsAt: now() + wait, early: true, media: p.media };
      s.version++;
      s.action = 'upnext';
      this.broadcastState();
      this.upNextTimer = setTimeout(() => this.playUpNext(null), wait);
      return;
    }
    const wait = Number(this.settings.get('upnextSeconds')) * 1000;
    s.upNext = { item: p.next, startsAt: now() + wait };
    s.version++;
    s.action = 'upnext';
    this.broadcastState();
    this.upNextTimer = setTimeout(() => this.playUpNext(null), wait);
  }

  // ------------------------------------------------------------ reminders

  clearReminder(announce) {
    if (!this.state.reminder) return;
    this.state.reminder = null;
    if (announce) {
      this.state.version++;
      this.state.action = 'reminder_clear';
      this.broadcastState();
    }
  }

  playReminder(by) {
    const pending = this.state.reminder;
    const r = (pending && this.reminders.get(pending.key)) || pending;
    if (!r) return;
    this.reminders.remove(r.key);
    this.state.reminder = null;
    this.broadcastReminders();
    this.load(by, { plugin: r.plugin, id: r.channel.id, meta: { title: r.channel.title, image: r.channel.image, live: true } })
      .then(() => {
        this.log(`[reminders] switched to ${r.channel.title} for "${r.title}"`);
        this.plugins.emit('reminder', { title: r.title, plugin: r.plugin, channel: r.channel, start: r.start, by });
      })
      .catch((e) => this.log(`[reminders] could not switch to ${r.channel.title}: ${e.message}`));
  }

  /** Runs every second: shows the card when it is getting close and switches channel on time. */
  checkReminders() {
    const s = this.state;
    const nowMs = now();
    const nowSec = nowMs / 1000;
    if (this.reminders.prune(nowSec)) this.broadcastReminders();
    if (s.reminder) {
      if (nowMs >= s.reminder.switchAt) this.playReminder(null);
      return;
    }
    const switchBefore = Number(this.settings.get('reminderSwitchSeconds'));
    const warn = Number(this.settings.get('reminderWarnSeconds')) * 1000;
    for (const r of this.reminders.list()) {
      const switchAt = (r.start - switchBefore) * 1000;
      if (nowMs < switchAt - warn) break; // sorted – the rest are further ahead
      if (r.end <= nowSec) continue;
      // Already watching that channel: nothing to switch.
      if (s.media?.plugin === r.plugin && s.media.id === r.channel.id) {
        this.reminders.remove(r.key);
        this.broadcastReminders();
        continue;
      }
      s.reminder = {
        key: r.key, title: r.title, start: r.start, addedBy: r.addedBy,
        channel: { plugin: r.plugin, id: r.channel.id, title: r.channel.title, image: r.channel.image },
        // If the server was down and the time has passed: switch in a few seconds.
        switchAt: Math.max(switchAt, nowMs + 5000),
      };
      s.version++;
      s.action = 'reminder';
      this.broadcastState();
      this.log(`[reminders] "${r.title}" starts soon – switching to ${r.channel.title}`);
      return;
    }
  }

  // ------------------------------------------------------------ favourites: new episodes

  /**
   * Adds a favourite. The plugin may decide what is saved (source.favorite) – e.g. Twitch saves the channel,
   * not the stream that is on right now.
   */
  async addFavorite(c, raw) {
    const plugin = str(raw?.plugin);
    let it = this.plugins.item(plugin, raw || {});
    if (!it || !SAFE_ID.test(it.plugin) || !it.favorite) return;
    if (this.plugins.has(plugin, 'favorite')) {
      const own = await this.plugins.call(plugin, 'favorite', [it], 10000).catch(() => undefined);
      if (own === null) return; // the plugin said no
      if (own) it = this.plugins.item(plugin, own) || it;
    }
    const added = this.favorites.add({ ...it, title: plainText(it.title), subtitle: plainText(it.subtitle) }, c.name);
    if (added) {
      this.log(`[favorites] ${c.name} added ${added.title}`);
      this.broadcastFavorites();
      this.checkEpisodes(added.key);
      this.checkStatus(plugin);
    }
  }

  /** Asks the plugins for their favourites' current status (source.status), e.g. which channels are live. */
  async checkStatus(only = null) {
    const byPlugin = new Map();
    for (const f of this.favorites.entries) {
      if (only && f.plugin !== only) continue;
      if (!byPlugin.has(f.plugin)) byPlugin.set(f.plugin, []);
      byPlugin.get(f.plugin).push(f);
    }
    let changed = false;
    for (const [plugin, favs] of byPlugin) {
      if (!this.plugins.has(plugin, 'status')) continue;
      try {
        const res = await this.plugins.call(plugin, 'status', [favs.map((f) => f.id)], 20000);
        if (!res || typeof res !== 'object') continue;
        for (const f of favs) {
          const st = res[f.id];
          if (!st || typeof st !== 'object') continue;
          const patch = { ...st };
          if (patch.image) patch.image = this.plugins.imageUrl(plugin, patch.image);
          if (patch.title) patch.title = plainText(patch.title);
          if (patch.subtitle) patch.subtitle = plainText(patch.subtitle);
          if (this.favorites.updateStatus(f.key, patch)) changed = true;
        }
      } catch (e) {
        this.log(`[favorites] ${plugin}: could not check status: ${e.message}`);
      }
    }
    if (changed) this.broadcastFavorites();
  }

  async checkEpisodes(key) {
    const fav = this.favorites.get(key);
    if (!fav || !this.plugins.has(fav.plugin, 'episodes')) return;
    try {
      const list = await this.plugins.call(fav.plugin, 'episodes', [fav.id], 30000);
      const episodes = (Array.isArray(list) ? list : [])
        .map((e) => ({ id: str(e?.id), label: clean(e?.label, 40) || str(e?.id) }))
        .filter((e) => ITEM_ID.test(e.id));
      if (this.favorites.updateEpisodes(key, episodes)) this.broadcastFavorites();
    } catch (e) {
      this.log(`[favorites] could not check ${fav.title}: ${e.message}`);
    }
  }

  async checkAllEpisodes() {
    for (const f of this.favorites.entries) await this.checkEpisodes(f.key);
  }

  scheduleEpisodeChecks() {
    clearInterval(this.episodeTimer);
    clearTimeout(this.episodeKick);
    this.episodeKick = setTimeout(() => this.checkAllEpisodes(), 20_000);
    this.episodeTimer = setInterval(() => this.checkAllEpisodes(), Number(this.settings.get('newEpisodeCheckMinutes')) * 60_000);
    this.episodeKick.unref?.();
    this.episodeTimer.unref?.();
  }

  // ------------------------------------------------------------ live chat from the plugin
  // Chat is only fetched while live media with chat plays AND someone shows it. Messages are batched
  // and sent to those who show the chat about once a second.

  updateChat() {
    const m = this.state.media;
    const want = m?.chat && [...this.clients.values()].some((c) => c.chat) ? `${m.plugin}:${m.id}` : null;
    if ((this.chatRelay?.key || null) === want) return;
    if (this.chatRelay) { try { this.chatRelay.stop?.(); } catch { /* already closed */ } this.chatRelay = null; }
    for (const c of this.clients.values()) if (c.chat) this.send(c, { type: 'chat', key: want, reset: true, messages: [] });
    if (!want) return;
    const relay = this.chatRelay = { key: want, buf: [], pending: [], stop: null };
    Promise.resolve()
      .then(() => this.plugins.call(m.plugin, 'chat', [m.id, (msg) => {
        if (this.chatRelay !== relay) return;
        const text = clean(msg?.text, 500);
        if (!text) return;
        const out = { user: clean(msg.user, 40) || '?', color: readableColor(str(msg.color)), text };
        relay.buf.push(out);
        if (relay.buf.length > 60) relay.buf.shift();
        relay.pending.push(out);
        if (relay.pending.length > 200) relay.pending.splice(0, relay.pending.length - 200);
      }], 15000))
      .then((stop) => {
        const fn = typeof stop === 'function' ? stop : () => {};
        if (this.chatRelay === relay) relay.stop = fn; else fn();
      })
      .catch((e) => this.log(`[chat] ${want}: ${e.message}`));
  }

  flushChat() {
    const relay = this.chatRelay;
    if (!relay?.pending.length) return;
    const messages = relay.pending.splice(0).slice(-40);
    for (const c of this.clients.values()) if (c.chat) this.send(c, { type: 'chat', key: relay.key, messages });
  }

  // ------------------------------------------------------------ survives restarts
  // After a restart, on-demand media comes back PAUSED at the same place; live continues straight away.

  writeRoom() {
    try {
      const s = this.state;
      const m = s.media;
      fs.writeFileSync(this.roomFile, JSON.stringify({
        media: m && { plugin: m.plugin, id: m.id, kind: m.kind, title: m.title, subtitle: m.subtitle, image: m.image, live: m.live },
        position: m?.live ? 0 : this.position(),
        changedBy: s.changedBy,
        savedAt: now(),
      }));
    } catch (e) {
      this.log('[room] could not save:', e.message);
    }
  }

  saveRoom() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.writeRoom(), 300);
  }

  /** Called once the plugins are loaded. */
  async restore() {
    this.checkStatus(); // the plugins are loaded: which favourite channels are live right now
    let r;
    try { r = JSON.parse(fs.readFileSync(this.roomFile, 'utf8')); } catch { return; }
    const saved = r?.media;
    if (!saved?.plugin || !saved.id) return;
    try {
      const media = await this.buildMedia(saved.plugin, saved.id, saved);
      const s = this.state;
      s.media = media;
      s.refTime = now();
      s.changedBy = r.changedBy || null;
      s.action = 'restore';
      if (media.live) { s.position = 0; s.paused = false; }
      else { s.position = Math.max(0, Number(r.position) || 0); s.paused = true; }
      s.version++;
      this.broadcastState();
      this.log(`[room] restored "${plainText(media.title)}" (${media.live ? 'live' : `paused at ${Math.round(s.position)} s`})`);
    } catch (e) {
      this.log(`[room] could not restore ${saved.plugin}:${saved.id} – ${e.message}`);
    }
  }

  /** When plugins change: refresh the playing media's player, or stop it if its plugin is gone. */
  pluginsChanged() {
    const m = this.state.media;
    if (!m) return;
    if (!this.plugins.source(m.plugin)) { this.stop(null); return; }
    m.player = this.plugins.playerSpec(m.plugin, m.playerRaw);
    m.chat = m.live && this.plugins.has(m.plugin, 'chat');
    this.state.version++;
    this.state.action = 'player';
    this.broadcastState();
    this.updateChat();
  }

  /** What plugins and the admin panel can do with the room. */
  api() {
    return {
      state: () => ({ ...this.state, position: this.position(), duration: this.state.media ? this.history.durationOf(this.state.media) : null }),
      members: () => this.members(),
      load: (item, by = 'Couchmate') => this.load(by, { plugin: item?.plugin, id: item?.id, position: item?.position, meta: item || {} }),
      play: (by = 'Admin') => this.play(by),
      pause: (by = 'Admin') => this.pause(by),
      seek: (position, by = 'Admin') => this.seek(by, position),
      stop: (by = 'Admin') => this.stop(by),
      kick: (id) => this.kick(id),
      rename: (id, name) => this.rename(id, name),
      /** How far a plugin's items were watched (see History.watched). Includes the one playing right now. */
      watched: (plugin, ids) => {
        const s = this.state;
        if (s.media && !s.media.live && s.media.plugin === plugin) this.history.note(s.media, { position: this.position() });
        return this.history.watched(plugin, ids);
      },
      /** A short message to every app (api.t() text is translated per device). */
      notify: (text) => this.broadcast({ type: 'notice', text: typeof text === 'object' ? text : clean(text, 300) }),
    };
  }

  shutdown() {
    clearTimeout(this.saveTimer);
    this.writeRoom();
    this.timers.forEach(clearInterval);
  }
}

/** English text of a plain or api.t() value (for logs and stored data). */
export function plainText(v) {
  return v && typeof v === 'object' && typeof v[T] === 'string' ? v[T] : v;
}

/** Name colour that is readable on a dark background: dark colours get white mixed in. */
function readableColor(c) {
  if (!/^#[0-9a-fA-F]{6}$/.test(c)) return null;
  let [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (lum < 0.5) {
    const k = (0.5 - lum) / (1 - lum) + 0.15;
    [r, g, b] = [r, g, b].map((v) => Math.round(v + (255 - v) * Math.min(1, k)));
  }
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

