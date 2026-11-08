// Reminders for the room: "switch everyone to this channel when the programme starts".
// The channel is any playable item from a plugin, so this works for IPTV and anything else with a schedule.

import { JsonFile } from './util.js';

export class Reminders {
  constructor(file, { log = console.log } = {}) {
    this.log = log;
    this.store = new JsonFile(file, [], { delay: 200 });
    this.store.data = this.store.data.filter((e) => e && e.plugin && e.channel?.id);
  }

  static key(plugin, channelId, start) { return `${plugin}:${channelId}:${start}`; }

  /** Upcoming reminders, soonest first. */
  list() { return [...this.store.data].sort((a, b) => a.start - b.start); }

  get(key) { return this.store.data.find((e) => e.key === key); }

  add({ plugin, channel, title, desc, start, end }, by) {
    const key = Reminders.key(plugin, channel.id, start);
    if (this.get(key)) return null;
    const entry = { key, plugin, channel, title, desc: desc || null, start, end, addedBy: by || null, addedAt: Date.now() };
    this.store.data.push(entry);
    this.store.save();
    this.log(`[reminders] ${by || 'someone'} added "${title}" on ${channel.title}`);
    return entry;
  }

  remove(key) {
    const before = this.store.data.length;
    this.store.data = this.store.data.filter((e) => e.key !== key);
    if (this.store.data.length === before) return false;
    this.store.save();
    return true;
  }

  removePlugin(plugin) {
    this.store.data = this.store.data.filter((e) => e.plugin !== plugin);
    this.store.save();
  }

  /** Drops reminders for programmes that have already ended. */
  prune(nowSec) {
    const before = this.store.data.length;
    this.store.data = this.store.data.filter((e) => e.end > nowSec);
    if (this.store.data.length === before) return false;
    this.store.save();
    return true;
  }

  flush() { this.store.flush(); }
}
