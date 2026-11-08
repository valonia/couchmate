// Shared watch history for the room. Works for any plugin: entries are keyed "<plugin>:<item id>".
// For things that are not live, the position and length are kept so that you can resume.

import { JsonFile } from './util.js';

export const refKey = (plugin, id) => `${plugin}:${id}`;

export class History {
  constructor(file, { max = 200 } = {}) {
    this.max = max;
    this.store = new JsonFile(file, [], { delay: 2000 });
    this.store.data = this.store.data.filter((e) => e && e.plugin && e.id).slice(0, max);
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
  }

  progress(media, position) {
    if (!media || media.live || !Number.isFinite(position)) return;
    const e = this.find(media);
    if (!e) return;
    e.position = Math.max(0, position);
    e.lastAt = Date.now();
    this.store.save();
  }

  durationOf(media) { return this.find(media)?.duration ?? null; }

  setDuration(media, duration) {
    if (!media || media.live || !(duration > 0)) return;
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

  flush() { this.store.flush(); }
}
