// The order of the groups on the Favorites screen, set in the admin panel.
// Plugins name their groups and suggest where they go (source.favoriteGroups); the admin can move them.
// A group the admin has not placed (e.g. from a plugin switched on later) goes where its plugin suggests,
// among the ones that have been placed.

import { JsonFile } from './util.js';
import { T } from './i18n.js';

export class FavoriteGroupOrder {
  constructor(file) {
    this.store = new JsonFile(file, {}, { delay: 0 });
    this.store.data.order = Array.isArray(this.store.data.order) ? this.store.data.order : [];
  }

  /** The groups ({ id, order, … } with the plugins' suggested order) in the order they are shown. */
  arrange(groups) {
    const saved = this.store.data.order;
    const byId = new Map(groups.map((g) => [g.id, g]));
    const out = saved.filter((id) => byId.has(id)).map((id) => byId.get(id));
    for (const g of [...groups].sort((a, b) => a.order - b.order)) {
      if (out.includes(g)) continue;
      // Right after the last placed group that its plugin would put before it.
      let at = 0;
      out.forEach((x, i) => { if (x.order <= g.order) at = i + 1; });
      out.splice(at, 0, g);
    }
    return out;
  }

  /** Where each group goes: id → position (0 first). */
  positions(groups) {
    return new Map(this.arrange(groups).map((g, i) => [g.id, i]));
  }

  /** For the admin panel: every group in the order shown. */
  forAdmin(groups, pluginNames) {
    return this.arrange(groups).map((g) => ({
      id: g.id,
      title: typeof g.title === 'object' ? g.title[T] : g.title,
      plugin: g.plugin,
      pluginName: g.plugin ? pluginNames[g.plugin] || g.plugin : null,
    }));
  }

  update({ order }) {
    if (!Array.isArray(order)) return;
    const ok = (id) => typeof id === 'string' && /^([a-z0-9_-]{1,64}:)?[a-z_]{1,24}$/.test(id);
    const given = [...new Set(order.filter(ok))].slice(0, 200);
    // Groups the page did not send (e.g. from a plugin switched off) keep their place after the others.
    this.store.data.order = [...given, ...this.store.data.order.filter((id) => !given.includes(id))].slice(0, 300);
    this.store.flush();
  }
}
