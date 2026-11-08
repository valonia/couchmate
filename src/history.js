// Gemensam tittarhistorik för rummet. Sparas som JSON så att den överlever omstarter.
// För filmer/avsnitt sparas även position och längd, så att man kan fortsätta där man var.

import fs from 'node:fs';
import path from 'node:path';

export class History {
  constructor(file, { max = 100, log = console.log } = {}) {
    this.file = file;
    this.max = max;
    this.log = log;
    this.entries = [];
    this.saveTimer = null;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(data)) this.entries = data.slice(0, max);
    } catch {
      // ingen historik än
    }
  }

  static key(media) {
    return `${media.type}:${media.id}`;
  }

  list() {
    return this.entries;
  }

  /** Något startades – lägg överst. */
  touch(media, by, position = 0) {
    const key = History.key(media);
    const old = this.entries.find((e) => e.key === key);
    const entry = {
      key,
      type: media.type,
      id: media.id,
      ext: media.ext,
      title: media.title,
      subtitle: media.subtitle,
      icon: media.icon,
      categoryId: media.categoryId,
      seriesId: media.seriesId ?? null,
      startedBy: by,
      startedAt: Date.now(),
      lastAt: Date.now(),
      position: media.type === 'live' || media.live ? 0 : position,
      live: media.live ?? undefined,
      duration: old?.duration ?? null,
    };
    this.entries = [entry, ...this.entries.filter((e) => e.key !== key)].slice(0, this.max);
    this.save();
  }

  progress(media, position) {
    if (!media || media.type === 'live') return;
    const e = this.entries.find((x) => x.key === History.key(media));
    if (!e || !Number.isFinite(position)) return;
    e.position = Math.max(0, position);
    e.lastAt = Date.now();
    this.save();
  }

  durationOf(media) {
    return this.entries.find((x) => x.key === History.key(media))?.duration ?? null;
  }

  setDuration(media, duration) {
    if (!media || media.type === 'live' || !(duration > 0)) return;
    const e = this.entries.find((x) => x.key === History.key(media));
    if (e && e.duration !== duration) {
      e.duration = duration;
      this.save();
    }
  }

  remove(key) {
    this.entries = this.entries.filter((e) => e.key !== key);
    this.save();
  }

  clear() {
    this.entries = [];
    this.save();
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
        this.log(`[historik] kunde inte spara: ${e.message}`);
      }
    }, 2000);
  }
}
