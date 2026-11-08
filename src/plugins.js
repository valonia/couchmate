// Plugins: små JavaScript-moduler som läggs i data/plugins/ och kan utöka servern.
//
// Ett plugin är antingen en enda .mjs-fil, eller en zip-fil med en mapp som innehåller
// plugin.json (id, name, version, description, main, requires) och koden (main, standard index.mjs).
// Så här ser koden ut:
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
//
// Källor (visas i apparnas meny mellan Favoriter och Historik, och i sök):
//   api.source({
//     name: 'Twitch', iconPath: 'M…',                    // ikon: SVG-sökväg i en 24×24-ruta
//     browse: async () => ({ sections: [{ id, title, items: [item, …] }] }),
//     search: async (q) => [item, …],
//     resolve: async (itemId) => ({ url: 'https://…/playlist.m3u8' }),   // HLS-ström att spela
//   });
//   item = { id, title, subtitle, image, live: true/false, viewers }
// OBS: plugins kör med samma rättigheter som servern – installera bara sådana du litar på.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzip } from './unzip.js';

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
      const full = path.join(this.dir, f);
      let id = null;
      if (f.endsWith('.mjs')) id = f.slice(0, -4).toLowerCase();
      else if (fs.statSync(full).isDirectory() && !f.startsWith('.')) id = f.toLowerCase();
      if (!id || !SAFE_ID.test(id)) continue;
      await this.load(id);
    }
  }

  /** Var pluginets kod ligger, och dess plugin.json om det är ett zip-plugin. */
  locate(id) {
    const dir = path.join(this.dir, id);
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      let manifest = {};
      try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')); } catch { /* ingen plugin.json */ }
      const main = String(manifest.main || 'index.mjs');
      if (main.includes('..') || path.isAbsolute(main)) throw new Error('Ogiltig "main" i plugin.json');
      return { file: path.join(dir, main), dir, manifest };
    }
    return { file: path.join(this.dir, `${id}.mjs`), dir: null, manifest: {} };
  }

  async load(id) {
    const saved = this.state[id] || {};
    const p = this.plugins.get(id) || { id, handlers: new Map(), routes: [], enabled: Boolean(saved.enabled), settings: saved.settings || {} };
    this.plugins.set(id, p);
    p.error = null;
    try {
      const where = this.locate(id);
      Object.assign(p, { file: where.file, dir: where.dir, manifest: where.manifest });
      // Frågetecknet tvingar fram en ny inläsning när filen har bytts ut.
      const mod = await import(`${pathToFileURL(where.file).href}?v=${fs.statSync(where.file).mtimeMs}`);
      const m = where.manifest;
      p.meta = { name: m.name || id, version: m.version || '', description: m.description || '', settings: m.settings || [], ...(mod.meta || {}) };
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
      source: (def) => { p.source = def; },
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
    p.source = null;
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

  /** Installerar ett plugin från en zip-fil (alltid avstängt tills någon slår på det). */
  async installZip(filename, buf) {
    let files = unzip(buf).filter((f) => !f.name.startsWith('__MACOSX/') && !f.name.endsWith('.DS_Store'));
    if (!files.length) throw new Error('Zip-filen är tom');
    // Ligger allt i en gemensam mapp i zip-filen tas den bort.
    const tops = new Set(files.map((f) => f.name.split('/')[0]));
    if (tops.size === 1 && files.every((f) => f.name.includes('/'))) {
      const top = [...tops][0];
      files = files.map((f) => ({ ...f, name: f.name.slice(top.length + 1) }));
    }
    let manifest = {};
    const mf = files.find((f) => f.name === 'plugin.json');
    if (mf) { try { manifest = JSON.parse(mf.data.toString('utf8')); } catch { throw new Error('plugin.json är inte giltig JSON'); } }
    const main = String(manifest.main || 'index.mjs');
    const entry = files.find((f) => f.name === main);
    if (!entry) throw new Error(`Zip-filen saknar ${main}`);
    if (!/export\s+default/.test(entry.data.toString('utf8'))) throw new Error(`${main} ser inte ut som ett plugin (saknar "export default")`);
    const fromName = path.basename(String(filename)).replace(/\.zip$/i, '');
    const id = String(manifest.id || fromName).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!SAFE_ID.test(id)) throw new Error('Ogiltigt plugin-id (bokstäver, siffror, - och _)');

    // Packa upp i en tillfällig mapp och byt sedan ut den gamla.
    const tmp = path.join(this.dir, `.tmp-${id}-${Date.now()}`);
    for (const f of files) {
      const target = path.join(tmp, f.name);
      if (!target.startsWith(tmp + path.sep)) throw new Error(`Otillåten sökväg: ${f.name}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.data);
    }
    const old = this.plugins.get(id);
    if (old) this.stop(old);
    const dir = path.join(this.dir, id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.join(this.dir, `${id}.mjs`), { force: true });
    fs.renameSync(tmp, dir);
    const p = await this.load(id);
    this.saveState();
    return p;
  }

  remove(id) {
    const p = this.plugins.get(id);
    if (!p) return false;
    this.stop(p);
    this.plugins.delete(id);
    try {
      if (p.dir) fs.rmSync(p.dir, { recursive: true, force: true });
      else fs.unlinkSync(p.file);
    } catch { /* redan borta */ }
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

  /** Källor från påslagna plugins (det apparna visar i menyn). */
  sources() {
    return [...this.plugins.values()]
      .filter((p) => p.enabled && p.source)
      .map((p) => ({ id: p.id, name: p.source.name || p.meta?.name || p.id, iconPath: p.source.iconPath || null }));
  }

  /** Anropar en källas funktion (browse/search/resolve) med tidsgräns. */
  async callSource(id, fn, args = [], timeoutMs = 15000) {
    const p = this.plugins.get(id);
    if (!p?.enabled || !p.source || typeof p.source[fn] !== 'function') throw new Error('Källan finns inte');
    let timer;
    try {
      return await Promise.race([
        Promise.resolve(p.source[fn](...args)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${p.source.name || id} svarade inte i tid`)), timeoutMs); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  list() {
    return [...this.plugins.values()].map((p) => ({
      id: p.id,
      name: p.meta?.name || p.id,
      version: p.meta?.version || '',
      description: p.meta?.description || '',
      kind: p.dir ? 'zip' : 'fil',
      requires: p.manifest?.requires || null,
      homepage: p.manifest?.homepage || null,
      source: p.enabled && p.source ? { name: p.source.name || p.id } : null,
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
