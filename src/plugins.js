// Plugin host. Everything the apps show besides search, favourites, history and settings comes from plugins:
// the menu entries, the screens behind them, search results, what is played and how the player behaves.
// See plugins/PLUGINS.md for the full contract.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzip } from './unzip.js';
import { SAFE_ID, ITEM_ID, clean, str, withTimeout } from './util.js';
import { T } from './i18n.js';
import { proxy } from './streams.js';

const KEY_ACTIONS = ['pause', 'settings', 'chat', 'info', 'channels', 'channel_up', 'channel_down', 'seek_back', 'seek_forward', 'none'];
const KEYS = ['ok', 'up', 'down', 'left', 'right'];
const SECTION_TYPES = ['quality', 'chat', 'audio', 'subtitles', 'choice', 'actions'];
const SCREEN_TYPES = ['rows', 'groups', 'detail', 'message'];
const ROUTE_AUTH = ['pin', 'admin', 'public'];

/** Text a plugin sends to the apps: a plain string (never translated) or api.t('…') (translated). */
function text(v, max) {
  if (v && typeof v === 'object' && typeof v[T] === 'string') {
    const out = { [T]: clean(v[T], max) };
    if (v.vars && typeof v.vars === 'object') {
      out.vars = Object.fromEntries(Object.entries(v.vars).slice(0, 10).map(([k, x]) => [clean(k, 20), typeof x === 'number' ? x : clean(x, 200)]));
    }
    return out[T] ? out : null;
  }
  return clean(v, max) || null;
}

export class PluginHost {
  constructor({ dir, bundledDir, stateFile, dataDir, cacheDir, room, log = console.log }) {
    this.dir = dir;
    this.bundledDir = bundledDir;
    this.stateFile = stateFile;
    this.dataDir = dataDir;
    this.cacheDir = cacheDir;
    this.room = room;
    this.log = log;
    this.plugins = new Map(); // id → plugin record
    this.listeners = { change: [] };
    this.state = {};
    try { this.state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {}; } catch { /* nothing saved yet */ }
    fs.mkdirSync(dir, { recursive: true });
  }

  onChange(fn) { this.listeners.change.push(fn); }

  saveState() {
    const out = {};
    for (const [id, p] of this.plugins) out[id] = { enabled: p.enabled, settings: p.settings };
    this.state = out;
    fs.writeFileSync(this.stateFile, JSON.stringify(out, null, 1));
    // Something was installed, switched on/off or removed – the apps reload their menu straight away.
    this.notify();
  }

  notify() {
    for (const fn of this.listeners.change) { try { fn(); } catch { /* listener gone */ } }
  }

  // ------------------------------------------------------------ loading

  async loadAll() {
    for (const f of fs.readdirSync(this.dir)) {
      const full = path.join(this.dir, f);
      if (f.startsWith('.') || !fs.statSync(full).isDirectory() || !SAFE_ID.test(f)) continue;
      await this.load(f);
    }
  }

  readManifest(dir) {
    let manifest = {};
    try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')); } catch { /* no plugin.json */ }
    const main = String(manifest.main || 'index.mjs');
    if (main.includes('..') || path.isAbsolute(main)) throw new Error('Invalid "main" in plugin.json');
    return { manifest, file: path.join(dir, main) };
  }

  async load(id) {
    const saved = this.state[id] || {};
    const p = this.plugins.get(id) || { id, enabled: Boolean(saved.enabled), settings: saved.settings || {} };
    this.plugins.set(id, p);
    this.reset(p);
    p.error = null;
    try {
      p.dir = path.join(this.dir, id);
      const { manifest, file } = this.readManifest(p.dir);
      p.manifest = manifest;
      // The query string forces a fresh import when the file has been replaced.
      const mod = await import(`${pathToFileURL(file).href}?v=${fs.statSync(file).mtimeMs}`);
      p.meta = {
        name: manifest.name || id,
        version: manifest.version || '',
        description: manifest.description || '',
        requires: manifest.requires || null,
        homepage: manifest.homepage || null,
        settings: manifest.settings || [],
        ...(mod.meta || {}),
      };
      p.setup = mod.default;
      if (typeof p.setup !== 'function') throw new Error('The plugin has no "export default function setup(api)"');
      for (const s of p.meta.settings || []) if (!(s.key in p.settings) && s.default !== undefined) p.settings[s.key] = s.default;
      if (p.enabled) await this.start(p);
    } catch (e) {
      p.error = e.message;
      this.log(`[plugin] ${id}: could not be loaded – ${e.message}`);
    }
    return p;
  }

  reset(p) {
    p.handlers = new Map();
    p.routes = [];
    p.links = [];
    p.source = null;
    p.menuCache = [];
  }

  async start(p) {
    this.stop(p);
    const dataDir = path.join(this.dataDir, p.id);
    const cacheDir = path.join(this.cacheDir, p.id);
    const api = {
      id: p.id,
      /** Translatable text: api.t('Live TV') or api.t('{n} viewers', { n: 12 }). Plain strings are never translated. */
      t: (s, vars) => (vars ? { [T]: String(s), vars } : { [T]: String(s) }),
      get settings() { return { ...p.settings }; },
      get dataDir() { fs.mkdirSync(dataDir, { recursive: true }); return dataDir; },
      get cacheDir() { fs.mkdirSync(cacheDir, { recursive: true }); return cacheDir; },
      log: (...args) => this.log(`[${p.id}]`, ...args),
      on: (event, fn) => {
        if (!p.handlers.has(event)) p.handlers.set(event, []);
        p.handlers.get(event).push(fn);
      },
      /**
       * An HTTP endpoint at /plugins/<id><path>. A path ending in "/*" matches everything below it.
       * auth: 'pin' (default – the apps), 'admin' (logged in to the admin panel) or 'public'.
       */
      route: (method, sub, handler, { auth = 'pin' } = {}) => {
        if (!ROUTE_AUTH.includes(auth)) throw new Error(`route auth must be one of ${ROUTE_AUTH.join(', ')}`);
        const subPath = `/${String(sub).replace(/^\/+/, '')}`;
        p.routes.push({ method: method.toUpperCase(), path: subPath, prefix: subPath.endsWith('/*') ? subPath.slice(0, -1) : null, handler, auth });
      },
      /** A link on the plugin's card in the admin panel, e.g. a status page served with api.route(…, { auth: 'admin' }). */
      link: (label, url) => p.links.push({ label: clean(label, 60), url: clean(url, 500) }),
      source: (def) => { p.source = def; },
      /** Call when what source.menu() returns has changed (e.g. content appeared) – the apps reload their menu. */
      menuChanged: () => this.refreshMenu(p, false),
      /** Passes an upstream response on to the app, with Range support (seeking): api.proxy(req, res, url, extraHeaders). */
      proxy: (req, res, url, headers) => proxy(req, res, url, headers),
      room: this.room,
    };
    try {
      const cleanup = await p.setup(api);
      p.cleanup = typeof cleanup === 'function' ? cleanup : null;
      this.log(`[plugin] ${p.meta?.name || p.id} started`);
      this.refreshMenu(p, false);
    } catch (e) {
      p.error = e.message;
      this.stop(p);
      this.log(`[plugin] ${p.id}: failed to start – ${e.message}`);
    }
  }

  stop(p) {
    try { p.cleanup?.(); } catch (e) { this.log(`[plugin] ${p.id}: error while stopping – ${e.message}`); }
    p.cleanup = null;
    this.reset(p);
  }

  // ------------------------------------------------------------ admin actions

  async setEnabled(id, enabled) {
    const p = this.require(id);
    p.enabled = enabled;
    if (enabled) await this.load(id); else this.stop(p);
    this.saveState();
    return p;
  }

  async setSettings(id, values) {
    const p = this.require(id);
    for (const s of p.meta?.settings || []) {
      if (!(s.key in values)) continue;
      const v = values[s.key];
      if (s.type === 'secret' && (v === '' || v === null || v === undefined)) continue;
      if (s.type === 'number') {
        const n = Number(v);
        if (!Number.isFinite(n)) throw new Error(`${s.label || s.key}: must be a number`);
        p.settings[s.key] = n;
      } else if (s.type === 'bool') p.settings[s.key] = v === true || v === 'true';
      else if (s.type === 'select') {
        const opts = (s.options || []).map((o) => (typeof o === 'object' ? o.value : o));
        if (!opts.includes(String(v))) throw new Error(`${s.label || s.key}: invalid choice`);
        p.settings[s.key] = String(v);
      } else p.settings[s.key] = String(v).slice(0, 4000);
    }
    this.saveState();
    if (p.enabled) await this.start(p); // restart so the new settings apply
    return p;
  }

  /** Installs a plugin from a zip file. New plugins are switched off until someone switches them on. */
  async installZip(filename, buf) {
    let files = unzip(buf).filter((f) => !f.name.startsWith('__MACOSX/') && !f.name.endsWith('.DS_Store'));
    if (!files.length) throw new Error('The zip file is empty');
    // If everything sits in one folder inside the zip, that folder is dropped.
    const tops = new Set(files.map((f) => f.name.split('/')[0]));
    if (tops.size === 1 && files.every((f) => f.name.includes('/'))) {
      const top = [...tops][0];
      files = files.map((f) => ({ ...f, name: f.name.slice(top.length + 1) })).filter((f) => f.name);
    }
    const mf = files.find((f) => f.name === 'plugin.json');
    if (!mf) throw new Error('The zip file has no plugin.json');
    let manifest;
    try { manifest = JSON.parse(mf.data.toString('utf8')); } catch { throw new Error('plugin.json is not valid JSON'); }
    const main = String(manifest.main || 'index.mjs');
    const entry = files.find((f) => f.name === main);
    if (!entry) throw new Error(`The zip file has no ${main}`);
    if (!/export\s+default/.test(entry.data.toString('utf8'))) throw new Error(`${main} does not look like a plugin (no "export default")`);
    const id = String(manifest.id || path.basename(String(filename)).replace(/\.zip$/i, '')).toLowerCase();
    if (!SAFE_ID.test(id)) throw new Error('Invalid plugin id in plugin.json (lowercase letters, digits, - and _)');

    const tmp = path.join(this.dir, `.tmp-${id}-${Date.now()}`);
    for (const f of files) {
      const target = path.join(tmp, f.name);
      if (!target.startsWith(tmp + path.sep)) throw new Error(`Path not allowed: ${f.name}`);
      if (f.name.endsWith('/')) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.data);
    }
    return this.replaceWith(id, tmp);
  }

  /** Plugins that ship with the server (the plugins/ folder in the image). */
  bundled() {
    if (!this.bundledDir || !fs.existsSync(this.bundledDir)) return [];
    return fs.readdirSync(this.bundledDir)
      .filter((f) => SAFE_ID.test(f) && fs.existsSync(path.join(this.bundledDir, f, 'plugin.json')))
      .map((f) => {
        const m = JSON.parse(fs.readFileSync(path.join(this.bundledDir, f, 'plugin.json'), 'utf8'));
        const installed = this.plugins.get(m.id || f);
        return { id: m.id || f, name: m.name || f, version: m.version || '', description: m.description || '', requires: m.requires || null, installed: Boolean(installed), installedVersion: installed?.meta?.version || null };
      });
  }

  async installBundled(id) {
    const src = path.join(this.bundledDir, id);
    if (!SAFE_ID.test(id) || !fs.existsSync(path.join(src, 'plugin.json'))) throw new Error('That plugin does not ship with the server');
    const tmp = path.join(this.dir, `.tmp-${id}-${Date.now()}`);
    fs.cpSync(src, tmp, { recursive: true });
    return this.replaceWith(id, tmp);
  }

  async replaceWith(id, tmp) {
    const old = this.plugins.get(id);
    if (old) this.stop(old);
    const dir = path.join(this.dir, id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
    const p = await this.load(id);
    this.saveState();
    return p;
  }

  remove(id) {
    const p = this.plugins.get(id);
    if (!p) return false;
    this.stop(p);
    this.plugins.delete(id);
    fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
    fs.rmSync(path.join(this.dataDir, id), { recursive: true, force: true });
    fs.rmSync(path.join(this.cacheDir, id), { recursive: true, force: true });
    this.saveState();
    return true;
  }

  require(id) {
    const p = this.plugins.get(id);
    if (!p) throw new Error('No such plugin');
    return p;
  }

  // ------------------------------------------------------------ events and routes

  /** Sends an event to every enabled plugin (an error in one plugin never stops the server). */
  emit(event, data) {
    for (const p of this.plugins.values()) {
      if (!p.enabled) continue;
      for (const fn of p.handlers.get(event) || []) {
        Promise.resolve().then(() => fn(data)).catch((e) => this.log(`[plugin] ${p.id}: error in "${event}" – ${e.message}`));
      }
    }
  }

  /** Finds the plugin route for /plugins/<id>/…, or null. */
  findRoute(method, pathname) {
    const m = /^\/plugins\/([a-z0-9_-]+)(\/.*)?$/.exec(pathname);
    if (!m) return null;
    const p = this.plugins.get(m[1]);
    if (!p?.enabled) return null;
    const sub = m[2] || '/';
    const want = method === 'HEAD' ? ['HEAD', 'GET'] : [method];
    const route = p.routes.find((r) => want.includes(r.method) && (r.prefix ? sub.startsWith(r.prefix) : r.path === sub));
    return route ? { plugin: p, route, rest: route.prefix ? sub.slice(route.prefix.length) : '' } : null;
  }

  // ------------------------------------------------------------ sources (what the apps show)

  source(id) {
    const p = this.plugins.get(id);
    return p?.enabled && p.source ? p.source : null;
  }

  has(id, fn) { return typeof this.source(id)?.[fn] === 'function'; }

  /**
   * Works out a plugin's menu entries. source.menu is a list, or a (async) function returning one – so a plugin
   * can leave out entries that have nothing to show. Without menu: one entry named after the source.
   */
  async refreshMenu(p, announce) {
    const src = p.enabled && p.source;
    if (!src) return;
    let entries;
    if (typeof src.menu === 'function') {
      try {
        entries = await withTimeout(src.menu(), 60000, 'menu() did not answer in time');
      } catch (e) {
        this.log(`[plugin] ${p.id}: menu – ${e.message}`);
        entries = [];
      }
    } else entries = Array.isArray(src.menu) && src.menu.length ? src.menu : [{ id: 'home', title: src.name || p.meta?.name || p.id, icon: src.icon }];
    if (p.source !== src) return; // restarted meanwhile
    const next = [];
    for (const e of (Array.isArray(entries) ? entries : []).slice(0, 8)) {
      const id = /^[A-Za-z0-9_-]{1,32}$/.test(str(e?.id)) ? str(e.id) : null;
      if (!id || next.some((x) => x.id === id)) continue;
      next.push({ plugin: p.id, id, title: text(e.title, 40) || p.meta?.name || p.id, icon: clean(e.icon || src.icon, 4000) || null });
    }
    const changed = JSON.stringify(next) !== JSON.stringify(p.menuCache || []);
    p.menuCache = next;
    if (changed || announce) this.notify();
  }

  /** Menu entries from every enabled plugin, in install order (the server applies the admin's order). */
  menu() {
    const out = [];
    for (const p of this.plugins.values()) if (p.enabled && p.source) out.push(...(p.menuCache || []));
    return out;
  }

  /** Calls a source function with a timeout. */
  async call(id, fn, args = [], timeoutMs = 15000) {
    const src = this.source(id);
    if (!src || typeof src[fn] !== 'function') throw new Error(`The plugin "${id}" cannot do that`);
    return withTimeout(src[fn](...args), timeoutMs, `${src.name || id} did not answer in time`);
  }

  // ---- validation of what plugins send, so the apps always get something they can draw

  imageUrl(id, v) {
    const s = clean(v, 2000);
    if (/^https?:\/\//.test(s)) return s;
    if (s.startsWith(`/plugins/${id}/`)) return s; // served by the plugin itself (fetched with the PIN)
    return null;
  }

  item(id, it) {
    const itemId = str(it?.id);
    if (!ITEM_ID.test(itemId)) return null;
    const out = {
      plugin: id,
      id: itemId,
      title: text(it.title, 200) || itemId,
      subtitle: text(it.subtitle, 200),
      image: this.imageUrl(id, it.image),
      backdrop: this.imageUrl(id, it.backdrop),
      description: text(it.description, 2000),
      kind: /^[a-z_]{1,24}$/.test(str(it.kind)) ? it.kind : null,
      action: it.action === 'open' ? 'open' : 'play',
      live: Boolean(it.live),
      favorite: it.favorite !== false,
    };
    if (Number(it.number) > 0) out.number = Math.round(Number(it.number));
    if (Number(it.viewers) >= 0 && it.viewers !== undefined && it.viewers !== null) out.viewers = Math.round(Number(it.viewers));
    if (Number(it.rating) > 0) out.rating = Math.round(Number(it.rating) * 10) / 10;
    for (const k of ['year', 'genre', 'badge']) { const v = text(it[k], 100); if (v) out[k] = v; }
    if (Number(it.duration) > 0) out.duration = Number(it.duration);
    return out;
  }

  items(id, list, max = 500) {
    return (Array.isArray(list) ? list : []).map((it) => this.item(id, it)).filter(Boolean).slice(0, max);
  }

  /** A screen: rows | groups | detail | message. */
  screen(id, d) {
    if (!d || typeof d !== 'object') return { type: 'message', text: null };
    const type = SCREEN_TYPES.includes(d.type) ? d.type : 'rows';
    const out = { type, message: text(d.message, 500) };
    if (type === 'rows') {
      out.rows = (Array.isArray(d.rows) ? d.rows : Array.isArray(d.sections) ? d.sections : []).slice(0, 30).map((r, i) => ({
        id: clean(r.id, 64) || String(i),
        title: text(r.title, 120),
        style: ['landscape', 'poster', 'square'].includes(r.style) ? r.style : 'landscape',
        items: this.items(id, r.items, 200),
      }));
    } else if (type === 'groups') {
      out.style = ['channels', 'posters', 'landscape'].includes(d.style) ? d.style : 'posters';
      out.guide = Boolean(d.guide); // channels with a programme guide (data 'epg' and 'guide')
      out.groups = (Array.isArray(d.groups) ? d.groups : []).slice(0, 2000).map((g) => ({
        id: clean(g.id, 64), title: text(g.title, 200), count: Number(g.count) >= 0 ? Number(g.count) : null,
      })).filter((g) => g.id);
      out.initial = clean(d.initial, 64) || null;
    } else if (type === 'detail') {
      out.item = this.item(id, d.item);
      out.facts = (Array.isArray(d.facts) ? d.facts : []).map((f) => text(f, 100)).filter(Boolean).slice(0, 8);
      out.seasons = (Array.isArray(d.seasons) ? d.seasons : []).slice(0, 100).map((s, i) => ({
        id: clean(s.id, 64) || String(i), title: text(s.title, 80), items: this.items(id, s.items, 500),
      }));
      out.resume = d.resume && ITEM_ID.test(str(d.resume)) ? str(d.resume) : null;
    } else {
      out.text = text(d.text, 1000);
    }
    return out;
  }

  /** Search results: a list of items (one section) or { sections: [{ title, items, style }] }. */
  searchResults(id, d) {
    const sections = Array.isArray(d) ? [{ id: 'all', items: d }] : Array.isArray(d?.sections) ? d.sections : [];
    return sections.slice(0, 10).map((s, i) => ({
      id: clean(s.id, 64) || String(i),
      title: text(s.title, 120),
      style: ['landscape', 'poster', 'square', 'channels'].includes(s.style) ? s.style : 'landscape',
      items: this.items(id, s.items, 60),
    })).filter((s) => s.items.length);
  }

  /** Programmes for a channel guide: [{ title, description, start, end }] (seconds). */
  programmes(list, max = 200) {
    const seen = new Set();
    return (Array.isArray(list) ? list : [])
      .map((e) => ({ title: clean(e?.title, 200), description: clean(e?.description, 1000) || null, start: Math.floor(Number(e?.start)) || 0, end: Math.floor(Number(e?.end)) || 0 }))
      .filter((e) => e.title && e.end > e.start && !seen.has(e.start) && seen.add(e.start))
      .sort((a, b) => a.start - b.start)
      .slice(0, max);
  }

  /**
   * How the player looks and is controlled for this plugin (or one item, when resolve() returned `player`).
   * Whatever the plugin says is checked here, so the apps always get something valid.
   */
  playerSpec(id, override) {
    const src = this.source(id);
    if (!src) return null;
    const hasChat = typeof src.chat === 'function';
    const hasAction = typeof src.action === 'function';
    const raw = (override && typeof override === 'object' ? override : null) || (src.player && typeof src.player === 'object' ? src.player : {});
    const safeId = (v) => (/^[A-Za-z0-9_-]{1,32}$/.test(str(v)) ? str(v) : null);

    // channels: the plugin lists the channels to zap between (data('channels', { id })).
    // guide: the plugin has programme info for the overlay (data('epg', { ids })).
    const hasData = typeof src.data === 'function';
    const channels = hasData && Boolean(raw.channels);
    const guide = hasData && Boolean(raw.guide);
    const keys = { ok: 'pause', up: 'info', down: 'settings', left: hasChat ? 'chat' : 'none', right: 'settings' };
    for (const k of KEYS) {
      const v = raw.keys?.[k];
      if (!KEY_ACTIONS.includes(v)) continue;
      if ((v === 'chat' && !hasChat) || (['channels', 'channel_up', 'channel_down'].includes(v) && !channels)) keys[k] = 'none';
      else keys[k] = v;
    }

    const list = Array.isArray(raw.settings) ? raw.settings : [...(hasChat ? [{ type: 'chat' }] : []), { type: 'quality' }, { type: 'audio' }, { type: 'subtitles' }];
    const settings = [];
    for (const s of list.slice(0, 12)) {
      if (!s || !SECTION_TYPES.includes(s.type)) continue;
      if (s.type === 'chat' && !hasChat) continue;
      if (s.type === 'actions' && !hasAction) continue;
      const out = { id: safeId(s.id) || s.type, type: s.type, title: text(s.title, 40) };
      if (s.type === 'choice' || s.type === 'actions') {
        out.options = (Array.isArray(s.options) ? s.options : [])
          .map((o) => ({ id: safeId(o?.id), label: text(o?.label, 60) }))
          .filter((o) => o.id && o.label)
          .slice(0, 20);
        if (!out.options.length) continue;
        if (s.type === 'choice') out.default = out.options.some((o) => o.id === s.default) ? s.default : out.options[0].id;
      }
      if (settings.some((x) => x.id === out.id)) continue;
      settings.push(out);
    }
    return { keys, settings, channels, guide };
  }

  /** Choices the player sent (?opt.<id>=<value>): only 'choice' settings the plugin declared, only valid values. */
  playerOptions(id, params) {
    const options = {};
    for (const s of this.playerSpec(id)?.settings || []) {
      if (s.type !== 'choice') continue;
      const v = str(params.get(`opt.${s.id}`));
      options[s.id] = s.options.some((o) => o.id === v) ? v : s.default;
    }
    return options;
  }

  // ------------------------------------------------------------ admin listing

  list() {
    return [...this.plugins.values()].map((p) => ({
      id: p.id,
      name: p.meta?.name || p.id,
      version: p.meta?.version || '',
      description: p.meta?.description || '',
      requires: p.meta?.requires || null,
      homepage: p.meta?.homepage || null,
      enabled: p.enabled,
      error: p.error,
      menu: p.enabled && p.source ? this.menu().filter((m) => m.plugin === p.id).map((m) => (typeof m.title === 'object' ? m.title[T] : m.title)) : [],
      links: p.links || [],
      events: [...(p.handlers?.keys() || [])],
      settings: (p.meta?.settings || []).map((s) => ({
        ...s,
        value: s.type === 'secret' ? undefined : p.settings[s.key],
        isSet: s.type === 'secret' ? Boolean(p.settings[s.key]) : undefined,
      })),
    }));
  }
}
