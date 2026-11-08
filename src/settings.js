// Core server settings, edited in the admin panel and stored in data/settings.json.
// Everything source-specific (IPTV, Twitch …) lives in the plugins' own settings.

import { JsonFile } from './util.js';

/**
 * type: text | secret (never sent to the browser) | number | bool | select
 */
export const SCHEMA = [
  // ---- Access
  { key: 'pin', group: 'access', type: 'secret', def: '', label: 'PIN code',
    help: 'Everyone enters this in the app to connect. The apps cannot connect until a PIN is set. If you change it, everyone has to enter the new one.' },
  { key: 'serverName', group: 'access', type: 'text', def: 'Couchmate', label: 'Server name', help: 'Shown in the apps and on the download page.' },

  // ---- Playback
  { key: 'startTimeoutMs', group: 'playback', type: 'number', def: 12000, min: 2000, max: 60000,
    label: 'Max wait for everyone to be ready (ms)', help: 'Playback starts when every viewer has buffered, or after this long.' },
  { key: 'upnextSeconds', group: 'playback', type: 'number', def: 10, min: 0, max: 120,
    label: 'Next episode starts after (seconds)' },

  // ---- Reminders
  { key: 'reminderSwitchSeconds', group: 'reminders', type: 'number', def: 0, min: 0, max: 600,
    label: 'Switch this long before the start (seconds)', help: '0 = switch exactly when the programme starts.' },
  { key: 'reminderWarnSeconds', group: 'reminders', type: 'number', def: 30, min: 5, max: 600,
    label: 'Show the reminder card this long before switching (seconds)' },

  // ---- Favourites
  { key: 'newEpisodeCheckMinutes', group: 'favorites', type: 'number', def: 30, min: 5, max: 1440,
    label: 'Check favourite series for new episodes every (minutes)' },

  // ---- Translation
  { key: 'translation', group: 'translation', type: 'bool', def: true,
    label: 'Translate the apps', help: 'Translates menus and buttons from English into each device\'s language, on this server. Nothing is sent anywhere else.' },
];

export const GROUPS = [
  { key: 'access', label: 'Access' },
  { key: 'playback', label: 'Playback' },
  { key: 'reminders', label: 'Reminders' },
  { key: 'favorites', label: 'Favourites' },
  { key: 'translation', label: 'Translation' },
];

export class Settings {
  constructor(file) {
    this.store = new JsonFile(file, {}, { delay: 0 });
    this.listeners = [];
  }

  get(key) {
    const d = SCHEMA.find((s) => s.key === key);
    return key in this.store.data ? this.store.data[key] : d?.def;
  }

  /** For the admin panel: secrets only say whether they are set. */
  forAdmin() {
    return SCHEMA.map((d) => ({
      ...d,
      value: d.type === 'secret' ? undefined : this.get(d.key),
      isSet: d.type === 'secret' ? Boolean(this.get(d.key)) : undefined,
    }));
  }

  /** Validates and saves. Empty secrets are left untouched. Returns the changed keys. */
  update(patch) {
    const changed = [];
    const next = {};
    for (const d of SCHEMA) {
      if (!(d.key in patch)) continue;
      let v = patch[d.key];
      if (d.type === 'secret' && (v === null || v === undefined || v === '')) continue;
      if (d.type === 'number') {
        v = Number(v);
        if (!Number.isFinite(v)) throw new Error(`${d.label}: must be a number`);
        if (d.min !== undefined && v < d.min) throw new Error(`${d.label}: at least ${d.min}`);
        if (d.max !== undefined && v > d.max) throw new Error(`${d.label}: at most ${d.max}`);
      } else if (d.type === 'bool') {
        v = v === true || v === 'true';
      } else {
        v = String(v).trim().slice(0, 2000);
        if (d.type === 'select' && !d.options.includes(v)) throw new Error(`${d.label}: invalid choice`);
        if (d.key === 'pin' && !/^[A-Za-z0-9]{4,32}$/.test(v)) throw new Error('PIN code: 4–32 letters or digits');
      }
      if (this.get(d.key) !== v) { next[d.key] = v; changed.push(d.key); }
    }
    if (changed.length) {
      Object.assign(this.store.data, next);
      this.store.flush();
      for (const fn of this.listeners) fn(changed);
    }
    return changed;
  }

  onChange(fn) { this.listeners.push(fn); }
}
