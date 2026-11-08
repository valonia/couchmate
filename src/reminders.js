// Påminnelser för rummet: "byt till den här kanalen när programmet börjar".
// Gemensamma för alla, sparas till fil så att de överlever omstarter.

import fs from 'node:fs';
import path from 'node:path';

export class Reminders {
  constructor(file, { log = console.log } = {}) {
    this.file = file;
    this.log = log;
    this.entries = [];
    this.saveTimer = null;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(data)) this.entries = data;
    } catch {
      // inga påminnelser än
    }
  }

  static key(channelId, start) {
    return `${channelId}:${start}`;
  }

  /** Kommande påminnelser, närmast först. */
  list() {
    return [...this.entries].sort((a, b) => a.start - b.start);
  }

  get(key) {
    return this.entries.find((e) => e.key === key);
  }

  add({ channel, title, desc, start, end }, by) {
    const key = Reminders.key(channel.id, start);
    if (this.get(key)) return null;
    const entry = { key, channel, title, desc: desc || null, start, end, addedBy: by || null, addedAt: Date.now() };
    this.entries.push(entry);
    this.save();
    this.log(`[påminnelse] ${by || 'någon'} lade till "${title}" på ${channel.name}`);
    return entry;
  }

  remove(key) {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.key !== key);
    if (this.entries.length === before) return false;
    this.save();
    return true;
  }

  /** Tar bort påminnelser för program som redan har slutat. */
  prune(nowSec) {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.end > nowSec);
    if (this.entries.length === before) return false;
    this.save();
    return true;
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify(this.entries, null, 1));
      } catch (e) {
        this.log(`[påminnelse] kunde inte spara: ${e.message}`);
      }
    }, 200);
  }
}
