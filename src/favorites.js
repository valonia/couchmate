// Gemensamma favoriter för rummet (serier, filmer, kanaler).
// För serier håller vi koll på vilka avsnitt som fanns när de lades till, så att nya avsnitt kan markeras.

import fs from 'node:fs';
import path from 'node:path';

const TYPES = ['series', 'movie', 'live'];

export class Favorites {
  constructor(file, { log = console.log } = {}) {
    this.file = file;
    this.log = log;
    this.entries = [];
    this.saveTimer = null;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(data)) this.entries = data;
    } catch {
      // inga favoriter än
    }
  }

  static key(type, id) {
    return `${type}:${id}`;
  }

  /** Det klienterna får se (utan interna listor över sedda avsnitt). */
  list() {
    return this.entries.map((e) => ({
      key: e.key,
      type: e.type,
      id: e.id,
      name: e.name,
      icon: e.icon,
      ext: e.ext,
      categoryId: e.categoryId,
      categoryName: e.categoryName,
      addedBy: e.addedBy,
      addedAt: e.addedAt,
      newCount: e.newEpisodes?.length || 0,
      newLabel: e.newEpisodes?.length ? e.newEpisodes[e.newEpisodes.length - 1].label : null,
    }));
  }

  get(key) {
    return this.entries.find((e) => e.key === key);
  }

  add(item, by) {
    if (!TYPES.includes(item.type)) return null;
    const key = Favorites.key(item.type, item.id);
    if (this.get(key)) return null;
    const entry = {
      key,
      type: item.type,
      id: item.id,
      name: item.name,
      icon: item.icon || null,
      ext: item.ext || '',
      categoryId: item.categoryId || null,
      categoryName: item.categoryName || null,
      addedBy: by,
      addedAt: Date.now(),
      // serier: fylls i vid första kontrollen (allt som finns då räknas som "sett")
      initialized: item.type !== 'series',
      seen: [],
      newEpisodes: [],
    };
    this.entries.unshift(entry);
    this.save();
    return entry;
  }

  remove(key) {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.key !== key);
    if (this.entries.length !== before) this.save();
    return this.entries.length !== before;
  }

  /** Någon öppnade serien – alla nya avsnitt räknas som sedda. */
  markSeen(key) {
    const e = this.get(key);
    if (!e || !e.newEpisodes?.length) return false;
    e.seen.push(...e.newEpisodes.map((n) => n.id));
    e.newEpisodes = [];
    this.save();
    return true;
  }

  /** Någon tittade på ett avsnitt – det är inte nytt längre. */
  markEpisodeSeen(seriesId, episodeId) {
    const e = this.get(Favorites.key('series', seriesId));
    if (!e) return false;
    const had = e.newEpisodes?.some((n) => n.id === episodeId);
    if (!had) return false;
    e.newEpisodes = e.newEpisodes.filter((n) => n.id !== episodeId);
    e.seen.push(episodeId);
    this.save();
    return true;
  }

  /**
   * Uppdatera en serie med dess nuvarande avsnitt ([{id, label}]).
   * Returnerar true om något ändrades (nya avsnitt hittades).
   */
  updateEpisodes(key, episodes) {
    const e = this.get(key);
    if (!e) return false;
    if (!e.initialized) {
      e.seen = episodes.map((x) => x.id);
      e.initialized = true;
      this.save();
      return false;
    }
    const known = new Set([...e.seen, ...e.newEpisodes.map((n) => n.id)]);
    const fresh = episodes.filter((x) => !known.has(x.id));
    if (!fresh.length) return false;
    e.newEpisodes.push(...fresh);
    this.log(`[favoriter] ${e.name}: ${fresh.length} nya avsnitt (${fresh.map((f) => f.label).join(', ')})`);
    this.save();
    return true;
  }

  seriesKeys() {
    return this.entries.filter((e) => e.type === 'series').map((e) => e.key);
  }

  save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = this.file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this.entries));
        fs.renameSync(tmp, this.file);
      } catch (e) {
        this.log(`[favoriter] kunde inte spara: ${e.message}`);
      }
    }, 1000);
  }
}
