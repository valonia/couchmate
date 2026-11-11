// Shared watch history for the room. Works for any plugin: entries are keyed "<plugin>:<item id>".
// For things that are not live, the position and length are kept so that you can resume.

import { JsonFile } from './util.js';

export const refKey = (plugin, id) => `${plugin}:${id}`;

export class History {
  constructor(file, { max = 200 } = {}) {
    this.max = max;
    this.store = new JsonFile(file, [], { delay: 2000 });
    this.store.data = this.store.data.filter((e) => e && e.plugin && e.id).slice(0, max);
    // How far everything that is not live was watched – without the history's limit, so a long series keeps
    // which episodes were seen. "<plugin>:<id>" → { p: position, d: length, t: when } (seconds, ms).
    this.watchStore = new JsonFile(file.replace(/history\.json$/, 'watched.json'), {}, { delay: 5000 });
    // The first time: start from what the history already knows.
    if (!Object.keys(this.watchStore.data).length && this.entries.length) {
      for (const e of [...this.entries].reverse()) {
        if (!e.live) this.watchStore.data[e.key] = { p: Math.round(e.position || 0), ...(e.duration > 0 ? { d: Math.round(e.duration) } : {}), t: e.lastAt || 0 };
      }
      this.watchStore.save();
    }
  }

  /** Remembers how far an item got (and its length, and who started it, when known). */
  note(media, { position, duration, by } = {}) {
    if (!media || media.live) return;
    const key = refKey(media.plugin, media.id);
    const all = this.watchStore.data;
    const w = all[key] || {};
    if (Number.isFinite(position)) w.p = Math.max(0, Math.round(position));
    if (duration > 0) w.d = Math.round(duration);
    if (by) w.b = String(by).slice(0, 40);
    w.t = Date.now();
    delete all[key];
    all[key] = w; // newest last – the oldest go first when there are too many
    const keys = Object.keys(all);
    if (keys.length > 20000) for (const k of keys.slice(0, keys.length - 20000)) delete all[k];
    this.watchStore.save();
  }

  /**
   * How far a plugin's items were watched: { id: { position, duration, finished, at, by } } for those that were
   * started (by = who started it). Finished = the end was reached (the last few minutes – where the credits are).
   */
  watched(plugin, ids) {
    const out = {};
    for (const id of ids) {
      const key = refKey(plugin, id);
      const w = this.watchStore.data[key];
      if (!w) continue;
      const d = w.d || 0;
      const p = w.p || 0;
      const by = w.b || this.entries.find((e) => e.key === key)?.startedBy || null;
      out[id] = { position: p, duration: d || null, finished: d > 0 && d - p <= Math.min(300, d * 0.08), at: w.t || 0, by };
    }
    return out;
  }

  get entries() { return this.store.data; }

  list() { return this.entries; }

  find(media) { return media && this.entries.find((e) => e.key === refKey(media.plugin, media.id)); }

  /** Something was started – put it first. */
  touch(media, by, position = 0) {
    const key = refKey(media.plugin, media.id);
    const old = this.entries.find((e) => e.key === key);
    const entry = {
      key,
      plugin: media.plugin,
      id: media.id,
      kind: media.kind || null,
      title: media.title,
      subtitle: media.subtitle || null,
      image: media.image || null,
      live: Boolean(media.live),
      startedBy: by || null,
      startedAt: Date.now(),
      lastAt: Date.now(),
      position: media.live ? 0 : position,
      duration: old?.duration ?? null,
    };
    this.store.data = [entry, ...this.entries.filter((e) => e.key !== key)].slice(0, this.max);
    this.store.save();
    this.note(media, { position: entry.position, by });
  }

  progress(media, position) {
    if (!media || media.live || !Number.isFinite(position)) return;
    this.note(media, { position });
    const e = this.find(media);
    if (!e) return;
    e.position = Math.max(0, position);
    e.lastAt = Date.now();
    this.store.save();
  }

  durationOf(media) { return this.find(media)?.duration ?? null; }

  setDuration(media, duration) {
    if (!media || media.live || !(duration > 0)) return;
    this.note(media, { duration });
    const e = this.find(media);
    if (e && e.duration !== duration) { e.duration = duration; this.store.save(); }
  }

  remove(key) {
    this.store.data = this.entries.filter((e) => e.key !== key);
    this.store.save();
  }

  /** Everything from one plugin (used when a plugin is removed). */
  removePlugin(plugin) {
    this.store.data = this.entries.filter((e) => e.plugin !== plugin);
    this.store.save();
  }

  clear() {
    this.store.data = [];
    this.store.save();
  }

  flush() { this.store.flush(); this.watchStore.flush(); }
}
