// The order of the app menu, set in the admin panel.
// Search is always at the top and Settings always at the bottom (the apps draw those).
// In between: Favorites, History and every plugin's menu entries, in the order the admin chose.
// A new entry (a plugin switched on, or a section that gets content) always lands last, right above Settings.
// The admin can also hide entries.

import { JsonFile } from './util.js';
import { T } from './i18n.js';

// Built into the apps, but placed by the admin like any plugin entry.
const CORE = [
  { core: 'favorites', plugin: null, id: 'favorites', title: { [T]: 'Favorites' }, icon: null },
  { core: 'history', plugin: null, id: 'history', title: { [T]: 'History' }, icon: null },
];
export const menuKey = (e) => (e.core ? `core/${e.core}` : `${e.plugin}/${e.id}`);

export class MenuLayout {
  constructor(file) {
    this.store = new JsonFile(file, {}, { delay: 0 });
    const d = this.store.data;
    d.order = Array.isArray(d.order) ? d.order : [];
    d.hidden = Array.isArray(d.hidden) ? d.hidden : [];
    d.known = d.known && typeof d.known === 'object' ? d.known : {}; // key → { title, plugin } seen before
  }

  /** Every entry right now (Favorites, History, plugins), in the saved order. */
  ordered(pluginEntries) {
    this.remember(pluginEntries);
    const pos = new Map(this.store.data.order.map((k, i) => [k, i]));
    return [...CORE, ...pluginEntries].sort((a, b) => pos.get(menuKey(a)) - pos.get(menuKey(b)));
  }

  /** What the apps get: the visible entries in order. */
  apply(pluginEntries) {
    const hidden = new Set(this.store.data.hidden);
    return this.ordered(pluginEntries).filter((e) => !hidden.has(menuKey(e)));
  }

  /**
   * Remembers every entry seen. A new one is added at the END of the order – right above Settings –
   * and stays where it is until the admin moves it. Titles are kept so the admin can still place an
   * entry while its plugin has nothing to show.
   */
  remember(pluginEntries) {
    const d = this.store.data;
    let changed = false;
    for (const e of [...CORE, ...pluginEntries]) {
      const k = menuKey(e);
      if (!d.order.includes(k)) { d.order.push(k); changed = true; }
      if (e.core) continue;
      const title = typeof e.title === 'object' ? e.title[T] : e.title;
      if (d.known[k]?.title !== title) { d.known[k] = { title, plugin: e.plugin }; changed = true; }
    }
    if (changed) this.store.flush();
  }

  /** For the admin panel: current entries plus known ones that are not shown right now, in the saved order. */
  forAdmin(pluginEntries, pluginNames) {
    const d = this.store.data;
    const hidden = new Set(d.hidden);
    const current = this.ordered(pluginEntries);
    const rows = new Map(current.map((e) => [menuKey(e), { title: typeof e.title === 'object' ? e.title[T] : e.title, plugin: e.plugin, available: true }]));
    for (const [k, v] of Object.entries(d.known)) {
      if (!rows.has(k) && pluginNames[v.plugin]) rows.set(k, { title: v.title, plugin: v.plugin, available: false });
    }
    return d.order.filter((k) => rows.has(k)).map((key) => {
      const r = rows.get(key);
      return { key, title: r.title, plugin: r.plugin, pluginName: r.plugin ? pluginNames[r.plugin] || r.plugin : null, available: r.available, hidden: hidden.has(key) };
    });
  }

  update({ order, hidden }) {
    const ok = (k) => typeof k === 'string' && /^[a-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,32}$/.test(k);
    if (Array.isArray(order)) {
      const given = [...new Set(order.filter(ok))];
      // Entries the admin page did not send (e.g. from an uninstalled plugin) keep their place at the end.
      this.store.data.order = [...given, ...this.store.data.order.filter((k) => !given.includes(k))].slice(0, 300);
    }
    if (Array.isArray(hidden)) this.store.data.hidden = [...new Set(hidden.filter(ok))].slice(0, 200);
    this.store.flush();
  }
}
