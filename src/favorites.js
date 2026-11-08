// Shared favourites for the room, from any plugin.
// When the plugin can list an item's episodes (source.episodes), the server remembers which ones
// existed when it was added, so that new episodes can be flagged.

import { JsonFile } from './util.js';
import { refKey } from './history.js';

export class Favorites {
  constructor(file, { log = console.log } = {}) {
    this.log = log;
    this.store = new JsonFile(file, [], { delay: 1000 });
    this.store.data = this.store.data.filter((e) => e && e.plugin && e.id);
  }

  get entries() { return this.store.data; }

  /** What the apps see (without the internal lists of seen episodes). */
  list() {
    return this.entries.map((e) => ({
      key: e.key,
      plugin: e.plugin,
      id: e.id,
      kind: e.kind,
      title: e.title,
      subtitle: e.subtitle,
      image: e.image,
      live: e.live,
      action: e.action,
      view: e.view || null,
      addedBy: e.addedBy,
      addedAt: e.addedAt,
      newCount: e.newEpisodes?.length || 0,
      newLabel: e.newEpisodes?.length ? e.newEpisodes[e.newEpisodes.length - 1].label : null,
    }));
  }

  get(key) { return this.entries.find((e) => e.key === key); }

  add(item, by) {
    const key = refKey(item.plugin, item.id);
    if (this.get(key)) return null;
    const entry = {
      key,
      plugin: item.plugin,
      id: item.id,
      kind: item.kind || null,
      title: item.title,
      subtitle: item.subtitle || null,
      image: item.image || null,
      live: Boolean(item.live),
      action: item.action === 'open' ? 'open' : 'play',
      view: item.view || null,
      addedBy: by || null,
      addedAt: Date.now(),
      initialized: false, // the first episode check counts everything that exists as "seen"
      seen: [],
      newEpisodes: [],
    };
    this.entries.unshift(entry);
    this.store.save();
    return entry;
  }

  remove(key) {
    const before = this.entries.length;
    this.store.data = this.entries.filter((e) => e.key !== key);
    if (this.entries.length === before) return false;
    this.store.save();
    return true;
  }

  removePlugin(plugin) {
    this.store.data = this.entries.filter((e) => e.plugin !== plugin);
    this.store.save();
  }

  /** Someone opened the item – all new episodes count as seen. */
  markSeen(key) {
    const e = this.get(key);
    if (!e?.newEpisodes?.length) return false;
    e.seen.push(...e.newEpisodes.map((n) => n.id));
    e.newEpisodes = [];
    this.store.save();
    return true;
  }

  /** Someone watched an episode – it is no longer new, in whichever favourite lists it. */
  markEpisodeSeen(plugin, episodeId) {
    let changed = false;
    for (const e of this.entries) {
      if (e.plugin !== plugin || !e.newEpisodes?.some((n) => n.id === episodeId)) continue;
      e.newEpisodes = e.newEpisodes.filter((n) => n.id !== episodeId);
      e.seen.push(episodeId);
      changed = true;
    }
    if (changed) this.store.save();
    return changed;
  }

  /** Updates an item with its current episodes ([{ id, label }]). Returns true if new ones were found. */
  updateEpisodes(key, episodes) {
    const e = this.get(key);
    if (!e) return false;
    if (!e.initialized) {
      e.seen = episodes.map((x) => x.id);
      e.initialized = true;
      this.store.save();
      return false;
    }
    const known = new Set([...e.seen, ...e.newEpisodes.map((n) => n.id)]);
    const fresh = episodes.filter((x) => !known.has(x.id));
    if (!fresh.length) return false;
    e.newEpisodes.push(...fresh);
    this.log(`[favorites] ${e.title}: ${fresh.length} new episode(s) (${fresh.map((f) => f.label).join(', ')})`);
    this.store.save();
    return true;
  }

  flush() { this.store.flush(); }
}
