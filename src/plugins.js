// Plugins: små JavaScript-moduler som läggs i data/plugins/ och kan utöka servern.
//
// En plugin är en fil som slutar på .mjs och ser ut så här:
//
//   export const meta = {
//     name: 'Mitt plugin', version: '1.0', description: 'Vad den gör',
//     settings: [ { key: 'url', label: 'Webhook-adress', type: 'text' } ],   // visas i adminpanelen
//   };
//   export default function setup(api) {
//     api.on('load', ({ media, by }) => api.log(`${by} startade ${media.title}`));
//     api.route('GET', '/hej', (req, res) => res.end('hej'));                // → /plugins/<id>/hej
//     return () => { /* städa upp när pluginet stängs av */ };
//   }
//
// Händelser: load, play, pause, seek, stop, member_join, member_leave, reminder, state
// api.room: state(), members(), load(media), play(), pause(), seek(sekunder), stop(), notify(text)
// OBS: plugins kör med samma rättigheter som servern – installera bara sådana du litar på.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export class PluginHost {
  constructor({ dir, stateFile, room, log = console.log }) {
    this.dir = dir;
    this.stateFile = stateFile;
    this.room = room;
    this.log = log;
    this.plugins = new Map(); // id → { id, file, meta, enabled, error, handlers, routes, cleanup, settings }
    this.state = {};
    try { this.state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {}; } catch { /* inget sparat än */ }
    fs.mkdirSync(dir, { recursive: true });
  }

  saveState() {
    const out = {};
    for (const [id, p] of this.plugins) out[id] = { enabled: p.enabled, settings: p.settings };
    fs.writeFileSync(this.stateFile, JSON.stringify(out, null, 1));
  }

  /** Hittar alla .mjs-filer i plugin-mappen och startar de som är påslagna. */
  async loadAll() {
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.mjs')) continue;
      const id = f.slice(0, -4).toLowerCase();
      if (!SAFE_ID.test(id)) continue;
      await this.load(id);
    }
  }

  async load(id) {
    const file = path.join(this.dir, `${id}.mjs`);
    const saved = this.state[id] || {};
    const p = this.plugins.get(id) || { id, file, handlers: new Map(), routes: [], enabled: Boolean(saved.enabled), settings: saved.settings || {} };
    this.plugins.set(id, p);
    p.error = null;
    try {
      // Frågetecknet tvingar fram en ny inläsning när filen har bytts ut.
      const mod = await import(`${pathToFileURL(file).href}?v=${fs.statSync(file).mtimeMs}`);
      p.meta = { name: id, version: '', description: '', settings: [], ...(mod.meta || {}) };
      p.setup = mod.default;
      if (typeof p.setup !== 'function') throw new Error('Pluginet saknar "export default function setup(api)"');
      for (const s of p.meta.settings || []) if (!(s.key in p.settings) && s.default !== undefined) p.settings[s.key] = s.default;
      if (p.enabled) await this.start(p);
    } catch (e) {
      p.error = e.message;
      this.log(`[plugin] ${id}: kunde inte läsas in – ${e.message}`);
    }
    return p;
  }

  async start(p) {
    this.stop(p);
    const api = {
      id: p.id,
      on: (event, fn) => {
        if (!p.handlers.has(event)) p.handlers.set(event, []);
        p.handlers.get(event).push(fn);
      },
      route: (method, sub, handler) => {
        const subPath = `/${String(sub).replace(/^\/+/, '')}`;
        p.routes.push({ method: method.toUpperCase(), path: subPath, handler });
      },
      get settings() { return { ...p.settings }; },
      log: (...args) => this.log(`[plugin ${p.id}]`, ...args),
      room: this.room,
    };
    try {
      const cleanup = await p.setup(api);
      p.cleanup = typeof cleanup === 'function' ? cleanup : null;
      this.log(`[plugin] ${p.meta?.name || p.id} startad`);
    } catch (e) {
      p.error = e.message;
      this.stop(p);
      this.log(`[plugin] ${p.id}: fel vid start – ${e.message}`);
    }
  }

  stop(p) {
    try { p.cleanup?.(); } catch (e) { this.log(`[plugin] ${p.id}: fel vid stopp – ${e.message}`); }
    p.cleanup = null;
    p.handlers = new Map();
    p.routes = [];
  }

  async setEnabled(id, enabled) {
    const p = this.plugins.get(id);
    if (!p) throw new Error('Pluginet finns inte');
    p.enabled = enabled;
    if (enabled) await this.load(id); else this.stop(p);
    this.saveState();
    return p;
  }

  async setSettings(id, values) {
    const p = this.plugins.get(id);
    if (!p) throw new Error('Pluginet finns inte');
    for (const s of p.meta?.settings || []) {
      if (!(s.key in values)) continue;
      const v = values[s.key];
      if (s.type === 'secret' && (v === '' || v === null || v === undefined)) continue;
      p.settings[s.key] = s.type === 'number' ? Number(v) : s.type === 'bool' ? v === true || v === 'true' : String(v).slice(0, 4000);
    }
    this.saveState();
    if (p.enabled) await this.start(p); // starta om så att de nya inställningarna gäller
    return p;
  }

  /** Sparar en uppladdad plugin-fil (alltid avstängd tills någon slår på den). */
  async install(filename, code) {
    const id = path.basename(String(filename)).replace(/\.(m?js)$/i, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!SAFE_ID.test(id)) throw new Error('Ogiltigt filnamn');
    if (!/export\s+default/.test(code)) throw new Error('Filen ser inte ut som ett plugin (saknar "export default")');
    fs.writeFileSync(path.join(this.dir, `${id}.mjs`), code);
    const old = this.plugins.get(id);
    if (old) this.stop(old);
    if (this.state[id]) this.state[id].enabled = old?.enabled || false;
    const p = await this.load(id);
    this.saveState();
    return p;
  }

  remove(id) {
    const p = this.plugins.get(id);
    if (!p) return false;
    this.stop(p);
    this.plugins.delete(id);
    try { fs.unlinkSync(p.file); } catch { /* redan borta */ }
    this.saveState();
    return true;
  }

  /** Skickar en händelse till alla påslagna plugins (fel i ett plugin stoppar inte servern). */
  emit(event, data) {
    for (const p of this.plugins.values()) {
      if (!p.enabled) continue;
      for (const fn of p.handlers.get(event) || []) {
        Promise.resolve().then(() => fn(data)).catch((e) => this.log(`[plugin] ${p.id}: fel i "${event}" – ${e.message}`));
      }
    }
  }

  /** Plugin-sidor och -anrop: /plugins/<id>/... */
  async handleHttp(req, res, pathname) {
    const m = /^\/plugins\/([a-z0-9_-]+)(\/.*)?$/.exec(pathname);
    if (!m) return false;
    const p = this.plugins.get(m[1]);
    if (!m[2] && p?.enabled) { res.writeHead(301, { location: `/plugins/${m[1]}/` }); res.end(); return true; } // relativa länkar kräver snedstreck
    const sub = m[2] || '/';
    const route = p?.enabled && p.routes.find((r) => r.method === req.method && r.path === sub);
    if (!route) return false;
    await route.handler(req, res);
    return true;
  }

  list() {
    return [...this.plugins.values()].map((p) => ({
      id: p.id,
      name: p.meta?.name || p.id,
      version: p.meta?.version || '',
      description: p.meta?.description || '',
      enabled: p.enabled,
      error: p.error,
      events: [...p.handlers.keys()],
      routes: p.routes.map((r) => `${r.method} /plugins/${p.id}${r.path}`),
      settings: (p.meta?.settings || []).map((s) => ({
        ...s,
        value: s.type === 'secret' ? undefined : p.settings[s.key],
        isSet: s.type === 'secret' ? Boolean(p.settings[s.key]) : undefined,
      })),
    }));
  }
}
