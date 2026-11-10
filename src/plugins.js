// Plugin host. Everything the apps show besides search, favourites, history and settings comes from plugins:
// the menu entries, the screens behind them, search results, what is played and how the player behaves.
// See plugins/PLUGINS.md for the full contract.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzip } from './unzip.js';
import { SAFE_ID, ITEM_ID, clean, str, withTimeout } from './util.js';
import { T } from './i18n.js';
import { proxy } from './streams.js';

const KEY_ACTIONS = ['pause', 'settings', 'chat', 'info', 'channels', 'channel_up', 'channel_down', 'seek_back', 'seek_forward', 'queue', 'none'];
const KEYS = ['ok', 'up', 'down', 'left', 'right'];
const SECTION_TYPES = ['quality', 'chat', 'audio', 'subtitles', 'choice', 'actions'];
const ROUTE_AUTH = ['pin', 'admin', 'public'];

/** Text a plugin sends to the apps: a plain string (never translated) or api.t('…') (translated). */
function text(v, max) {
  if (v && typeof v === 'object' && typeof v[T] === 'string') {
    const out = { [T]: clean(v[T], max) };
    if (v.vars && typeof v.vars === 'object') {
      out.vars = Object.fromEntries(Object.entries(v.vars).slice(0, 10).map(([k, x]) => [clean(k, 20), typeof x === 'number' ? x : clean(x, 200)]));
    }
    return out[T] ? out : null;
  }
  return clean(v, max) || null;
}

/**
 * The groups on the Favorites screen for the usual kinds – used when a plugin does not name its own
 * (source.favoriteGroups). style: poster (tall covers) | landscape (16:9 cards) | guide (TV channels: a row with
 * what is on now). Lower order comes first.
 */
const FAVORITE_GROUPS = {
  series: { title: 'Series', order: 10, style: 'poster' },
  movie: { title: 'Movies', order: 20, style: 'poster' },
  channel: { title: 'Channels', order: 30, style: 'guide' },
  stream: { title: 'Streams', order: 40, style: 'landscape' },
  creator: { title: 'Creators', order: 50, style: 'landscape' },
  playlist: { title: 'Playlists', order: 60, style: 'landscape' },
  video: { title: 'Videos', order: 70, style: 'landscape' },
};
const FAVORITE_STYLES = ['poster', 'landscape', 'guide'];

// Updates from GitHub: plugin.json's "repository" ("owner/repo"); a release tagged with the version (e.g. v2.1.0).
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const GH_HEADERS = { 'user-agent': 'Couchmate', accept: 'application/vnd.github+json' };
// Whose plugins the admin panel lists (public repositories with the topic "couchmate-plugin").
const CATALOG_OWNER = 'valonia';

/** plugin.json's "needs": the plugins this one builds on – [{ id, name, repository }]. */
export function needsOf(manifest) {
  return (Array.isArray(manifest?.needs) ? manifest.needs : []).slice(0, 10).map((n) => ({
    id: String(n?.id || '').toLowerCase(),
    name: String(n?.name || n?.id || ''),
    repository: REPO.test(String(n?.repository || '')) ? String(n.repository) : null,
  })).filter((n) => SAFE_ID.test(n.id));
}

/** Is version a newer than version b? ("2.10.0" > "2.9.1"; a leading "v" is ignored.) */
export function isNewer(a, b) {
  const parts = (v) => String(v || '').trim().replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

export class PluginHost {
  constructor({ dir, stateFile, dataDir, cacheDir, room, log = console.log }) {
    this.dir = dir;
    this.stateFile = stateFile;
    this.dataDir = dataDir;
    this.cacheDir = cacheDir;
    this.room = room;
    this.log = log;
    this.plugins = new Map(); // id → plugin record
    this.listeners = { change: [] };
    this.state = {};
    try { this.state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {}; } catch { /* nothing saved yet */ }
    fs.mkdirSync(dir, { recursive: true });
  }

  onChange(fn) { this.listeners.change.push(fn); }

  saveState() {
    const out = {};
    for (const [id, p] of this.plugins) out[id] = { enabled: p.enabled, settings: p.settings, autoUpdate: Boolean(p.autoUpdate) };
    this.state = out;
    fs.writeFileSync(this.stateFile, JSON.stringify(out, null, 1));
    // Something was installed, switched on/off or removed – the apps reload their menu straight away.
    this.notify();
  }

  notify() {
    for (const fn of this.listeners.change) { try { fn(); } catch { /* listener gone */ } }
  }

  // ------------------------------------------------------------ loading

  async loadAll() {
    for (const f of fs.readdirSync(this.dir)) {
      const full = path.join(this.dir, f);
      if (f.startsWith('.') || !fs.statSync(full).isDirectory() || !SAFE_ID.test(f)) continue;
      await this.load(f);
    }
  }

  readManifest(dir) {
    let manifest = {};
    try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')); } catch { /* no plugin.json */ }
    const main = String(manifest.main || 'index.mjs');
    if (main.includes('..') || path.isAbsolute(main)) throw new Error('Invalid "main" in plugin.json');
    return { manifest, file: path.join(dir, main) };
  }

  async load(id) {
    const saved = this.state[id] || {};
    const p = this.plugins.get(id) || { id, enabled: Boolean(saved.enabled), settings: saved.settings || {}, autoUpdate: Boolean(saved.autoUpdate) };
    this.plugins.set(id, p);
    this.reset(p);
    p.error = null;
    try {
      p.dir = path.join(this.dir, id);
      const { manifest, file } = this.readManifest(p.dir);
      p.manifest = manifest;
      // The query string forces a fresh import when the file has been replaced.
      const mod = await import(`${pathToFileURL(file).href}?v=${fs.statSync(file).mtimeMs}`);
      p.meta = {
        name: manifest.name || id,
        version: manifest.version || '',
        description: manifest.description || '',
        requires: manifest.requires || null,
        homepage: manifest.homepage || null,
        repository: manifest.repository || null, // GitHub "owner/repo" – where updates come from
        needs: needsOf(manifest), // plugins this one builds on
        settings: manifest.settings || [],
        ...(mod.meta || {}),
      };
      p.setup = mod.default;
      if (typeof p.setup !== 'function') throw new Error('The plugin has no "export default function setup(api)"');
      for (const s of p.meta.settings || []) if (!(s.key in p.settings) && s.default !== undefined) p.settings[s.key] = s.default;
      if (p.enabled) await this.start(p);
    } catch (e) {
      p.error = e.message;
      this.log(`[plugin] ${id}: could not be loaded – ${e.message}`);
    }
    return p;
  }

  reset(p) {
    p.handlers = new Map();
    p.routes = [];
    p.links = [];
    p.source = null;
    p.menuCache = [];
    p.services = new Map(); // name → function other plugins can use (api.expose / api.use)
  }

  async start(p) {
    this.stop(p);
    const dataDir = path.join(this.dataDir, p.id);
    const cacheDir = path.join(this.cacheDir, p.id);
    const api = {
      id: p.id,
      /** Translatable text: api.t('Live TV') or api.t('{n} viewers', { n: 12 }). Plain strings are never translated. */
      t: (s, vars) => (vars ? { [T]: String(s), vars } : { [T]: String(s) }),
      get settings() { return { ...p.settings }; },
      get dataDir() { fs.mkdirSync(dataDir, { recursive: true }); return dataDir; },
      get cacheDir() { fs.mkdirSync(cacheDir, { recursive: true }); return cacheDir; },
      log: (...args) => this.log(`[${p.id}]`, ...args),
      on: (event, fn) => {
        if (!p.handlers.has(event)) p.handlers.set(event, []);
        p.handlers.get(event).push(fn);
      },
      /**
       * An HTTP endpoint at /plugins/<id><path>. A path ending in "/*" matches everything below it.
       * auth: 'pin' (default – the apps), 'admin' (logged in to the admin panel) or 'public'.
       */
      route: (method, sub, handler, { auth = 'pin' } = {}) => {
        if (!ROUTE_AUTH.includes(auth)) throw new Error(`route auth must be one of ${ROUTE_AUTH.join(', ')}`);
        const subPath = `/${String(sub).replace(/^\/+/, '')}`;
        p.routes.push({ method: method.toUpperCase(), path: subPath, prefix: subPath.endsWith('/*') ? subPath.slice(0, -1) : null, handler, auth });
      },
      /** A link on the plugin's card in the admin panel, e.g. a status page served with api.route(…, { auth: 'admin' }). */
      link: (label, url) => p.links.push({ label: clean(label, 60), url: clean(url, 500) }),
      source: (def) => { p.source = def; },
      /** Call when what source.menu() returns has changed (e.g. content appeared) – the apps reload their menu. */
      menuChanged: () => this.refreshMenu(p, false),
      /**
       * Offers a function to other plugins, e.g. api.expose('findVideo', async (query) => …). They call it with
       * api.use('<this plugin id>', 'findVideo', query). Lets plugins build on each other (extensions).
       */
      expose: (name, fn) => {
        if (!/^[A-Za-z0-9_]{1,40}$/.test(String(name)) || typeof fn !== 'function') throw new Error('api.expose(name, function)');
        p.services.set(String(name), fn);
      },
      /**
       * Calls a function another plugin offers (api.expose). Throws if that plugin is not installed, switched
       * off, or does not offer it – check first with api.has(pluginId, name).
       */
      use: (pluginId, name, ...args) => this.useService(String(pluginId), String(name), args),
      has: (pluginId, name) => Boolean(this.serviceOf(String(pluginId), String(name))),
      /** The switched-on plugins that offer a function (api.expose) – e.g. every extension of this plugin. */
      providers: (name) => [...this.plugins.values()].filter((x) => x.enabled && x.services?.has(String(name))).map((x) => x.id),
      /** Passes an upstream response on to the app, with Range support (seeking): api.proxy(req, res, url, extraHeaders). */
      proxy: (req, res, url, headers) => proxy(req, res, url, headers),
      room: this.room,
    };
    try {
      const cleanup = await p.setup(api);
      p.cleanup = typeof cleanup === 'function' ? cleanup : null;
      this.log(`[plugin] ${p.meta?.name || p.id} started`);
      this.refreshMenu(p, false);
    } catch (e) {
      p.error = e.message;
      this.stop(p);
      this.log(`[plugin] ${p.id}: failed to start – ${e.message}`);
    }
  }

  stop(p) {
    try { p.cleanup?.(); } catch (e) { this.log(`[plugin] ${p.id}: error while stopping – ${e.message}`); }
    p.cleanup = null;
    this.reset(p);
  }

  // ------------------------------------------------------------ admin actions

  async setEnabled(id, enabled) {
    const p = this.require(id);
    p.enabled = enabled;
    if (enabled) await this.load(id); else this.stop(p);
    this.saveState();
    return p;
  }

  async setSettings(id, values) {
    const p = this.require(id);
    for (const s of p.meta?.settings || []) {
      if (!(s.key in values)) continue;
      const v = values[s.key];
      if (s.type === 'secret' && (v === '' || v === null || v === undefined)) continue;
      if (s.type === 'number') {
        const n = Number(v);
        if (!Number.isFinite(n)) throw new Error(`${s.label || s.key}: must be a number`);
        p.settings[s.key] = n;
      } else if (s.type === 'bool') p.settings[s.key] = v === true || v === 'true';
      else if (s.type === 'select') {
        const opts = (s.options || []).map((o) => (typeof o === 'object' ? o.value : o));
        if (!opts.includes(String(v))) throw new Error(`${s.label || s.key}: invalid choice`);
        p.settings[s.key] = String(v);
      } else p.settings[s.key] = String(v).slice(0, 4000);
    }
    this.saveState();
    if (p.enabled) await this.start(p); // restart so the new settings apply
    return p;
  }

  /** Installs a plugin from a zip file. New plugins are switched off until someone switches them on. */
  async installZip(filename, buf, { expectId = null, checkNeeds = false } = {}) {
    let files = unzip(buf).filter((f) => !f.name.startsWith('__MACOSX/') && !f.name.endsWith('.DS_Store'));
    if (!files.length) throw new Error('The zip file is empty');
    // If everything sits in one folder inside the zip, that folder is dropped.
    const tops = new Set(files.map((f) => f.name.split('/')[0]));
    if (tops.size === 1 && files.every((f) => f.name.includes('/'))) {
      const top = [...tops][0];
      files = files.map((f) => ({ ...f, name: f.name.slice(top.length + 1) })).filter((f) => f.name);
    }
    const mf = files.find((f) => f.name === 'plugin.json');
    if (!mf) throw new Error('The zip file has no plugin.json');
    let manifest;
    try { manifest = JSON.parse(mf.data.toString('utf8')); } catch { throw new Error('plugin.json is not valid JSON'); }
    const main = String(manifest.main || 'index.mjs');
    const entry = files.find((f) => f.name === main);
    if (!entry) throw new Error(`The zip file has no ${main}`);
    if (!/export\s+default/.test(entry.data.toString('utf8'))) throw new Error(`${main} does not look like a plugin (no "export default")`);
    const id = String(manifest.id || path.basename(String(filename)).replace(/\.zip$/i, '')).toLowerCase();
    if (!SAFE_ID.test(id)) throw new Error('Invalid plugin id in plugin.json (lowercase letters, digits, - and _)');
    if (expectId && id !== expectId) throw new Error(`The update is for "${id}", not "${expectId}"`);
    if (checkNeeds) {
      const missing = needsOf(manifest).filter((n) => !this.plugins.has(n.id));
      if (missing.length) {
        const err = new Error(`${manifest.name || id} needs ${missing.map((n) => n.name).join(' and ')}`);
        err.needs = missing;
        err.plugin = { id, name: String(manifest.name || id) };
        throw err;
      }
    }

    const tmp = path.join(this.dir, `.tmp-${id}-${Date.now()}`);
    for (const f of files) {
      const target = path.join(tmp, f.name);
      if (!target.startsWith(tmp + path.sep)) throw new Error(`Path not allowed: ${f.name}`);
      if (f.name.endsWith('/')) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.data);
    }
    return this.replaceWith(id, tmp);
  }

  // ------------------------------------------------------------ getting plugins from GitHub

  /** A repository's latest release: { tag, version, zip, url, notes }, or null when it has none yet. */
  async latestRelease(repo) {
    const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: GH_HEADERS, signal: AbortSignal.timeout(15000) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    const rel = await r.json();
    const zip = String(rel.zipball_url || '');
    if (!zip.startsWith('https://api.github.com/')) return null;
    return { tag: String(rel.tag_name || ''), version: String(rel.tag_name || '').replace(/^v/i, ''), zip, url: String(rel.html_url || ''), notes: String(rel.body || '').slice(0, 3000) };
  }

  /**
   * The plugins you can get: public GitHub repositories by CATALOG_OWNER with the topic "couchmate-plugin" – a new
   * one shows up here as soon as it has a release, without a new server. Kept for 10 minutes.
   */
  async catalog(fresh = false) {
    if (!fresh && this.catalogCache && Date.now() - this.catalogCache.t < 10 * 60 * 1000) return this.withInstalled(this.catalogCache.list);
    const q = encodeURIComponent(`topic:couchmate-plugin user:${CATALOG_OWNER}`);
    const r = await fetch(`https://api.github.com/search/repositories?q=${q}&per_page=50`, { headers: GH_HEADERS, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    const repos = ((await r.json()).items || []).map((x) => String(x.full_name || '')).filter((x) => REPO.test(x));
    const list = (await Promise.all(repos.map(async (repo) => {
      try {
        const rel = await this.latestRelease(repo);
        if (!rel) return null;
        const m = await (await fetch(`https://raw.githubusercontent.com/${repo}/${encodeURIComponent(rel.tag)}/plugin.json`, { signal: AbortSignal.timeout(15000) })).json();
        const id = String(m.id || '').toLowerCase();
        if (!SAFE_ID.test(id)) return null;
        return { repo, id, name: String(m.name || id), description: String(m.description || ''), requires: m.requires || null, version: rel.version, needs: needsOf(m) };
      } catch { return null; }
    }))).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
    this.catalogCache = { t: Date.now(), list };
    return this.withInstalled(list);
  }

  withInstalled(list) {
    return list.map((c) => {
      const p = this.plugins.get(c.id);
      return { ...c, installed: Boolean(p), installedVersion: p?.meta?.version || null };
    });
  }

  /** Installs a plugin from a GitHub repository's latest release ("owner/repo" or its address). Switched off until switched on. */
  async installFromGitHub(repoIn, { withNeeds = false } = {}, depth = 0) {
    const repo = String(repoIn || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
    if (!REPO.test(repo)) throw new Error('Write the repository as owner/name, e.g. valonia/couchmate-twitch');
    const rel = await this.latestRelease(repo);
    if (!rel) throw new Error(`${repo} has no release yet`);
    const r = await fetch(rel.zip, { headers: GH_HEADERS, redirect: 'follow', signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 50 * 1024 * 1024) throw new Error('The plugin is too big');
    let p;
    try {
      p = await this.installZip(`${repo.split('/')[1]}.zip`, buf, { checkNeeds: true });
    } catch (e) {
      // It builds on plugins that are not installed: install those first if the admin said yes, else ask.
      if (!e.needs || !withNeeds || depth > 2) throw e;
      for (const n of e.needs) {
        if (!n.repository) throw new Error(`${e.plugin.name} needs ${n.name}, but does not say where to get it`);
        await this.installFromGitHub(n.repository, { withNeeds: true }, depth + 1);
      }
      p = await this.installZip(`${repo.split('/')[1]}.zip`, buf);
    }
    p.update = null;
    this.log(`[plugins] ${p.meta?.name || p.id} ${p.meta?.version || ''} installed from github.com/${repo}`);
    return p;
  }

  async replaceWith(id, tmp) {
    const old = this.plugins.get(id);
    if (old) this.stop(old);
    const dir = path.join(this.dir, id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
    const p = await this.load(id);
    this.saveState();
    return p;
  }

  // ------------------------------------------------------------ updates from GitHub

  /** The plugin's GitHub repository ("owner/repo") from plugin.json, or null. */
  repoOf(p) {
    const r = String(p?.meta?.repository || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
    return REPO.test(r) ? r : null;
  }

  /**
   * Asks GitHub for each plugin's latest release. A newer one is shown in the admin panel – and installed
   * straight away for plugins set to update automatically (when [install] is true).
   */
  async checkUpdates({ install = true } = {}) {
    for (const p of [...this.plugins.values()]) {
      const repo = this.repoOf(p);
      if (!repo) continue;
      try {
        const rel = await this.latestRelease(repo);
        p.updateCheckedAt = Date.now();
        p.updateError = null;
        p.update = rel?.version && isNewer(rel.version, p.meta?.version) ? rel : null;
        if (p.update) this.log(`[plugins] ${p.meta?.name || p.id}: version ${rel.version} is out (installed: ${p.meta?.version || '?'})`);
        if (p.update && install && p.autoUpdate) await this.installUpdate(p.id);
      } catch (e) {
        p.updateError = e.message;
        this.log(`[plugins] ${p.meta?.name || p.id}: could not check for updates: ${e.message}`);
      }
    }
  }

  /** Downloads the newer release from GitHub and installs it (settings and on/off are kept). */
  async installUpdate(id) {
    const p = this.require(id);
    const u = p.update;
    if (!u) throw new Error('There is no update');
    const r = await fetch(u.zip, { headers: GH_HEADERS, redirect: 'follow', signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 50 * 1024 * 1024) throw new Error('The update is too big');
    const from = p.meta?.version || '?';
    const np = await this.installZip(`${id}.zip`, buf, { expectId: id });
    np.update = null;
    this.log(`[plugins] ${np.meta?.name || id} updated from ${from} to ${np.meta?.version || u.version}`);
    return np;
  }

  setAutoUpdate(id, on) {
    const p = this.require(id);
    p.autoUpdate = Boolean(on);
    this.saveState();
    if (p.autoUpdate && p.update) this.installUpdate(id).catch((e) => this.log(`[plugins] ${id}: update failed: ${e.message}`));
  }

  remove(id) {
    const p = this.plugins.get(id);
    if (!p) return false;
    this.stop(p);
    this.plugins.delete(id);
    fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
    fs.rmSync(path.join(this.dataDir, id), { recursive: true, force: true });
    fs.rmSync(path.join(this.cacheDir, id), { recursive: true, force: true });
    this.saveState();
    return true;
  }

  require(id) {
    const p = this.plugins.get(id);
    if (!p) throw new Error('No such plugin');
    return p;
  }

  // ------------------------------------------------------------ events and routes

  /** Sends an event to every enabled plugin (an error in one plugin never stops the server). */
  emit(event, data) {
    for (const p of this.plugins.values()) {
      if (!p.enabled) continue;
      for (const fn of p.handlers.get(event) || []) {
        Promise.resolve().then(() => fn(data)).catch((e) => this.log(`[plugin] ${p.id}: error in "${event}" – ${e.message}`));
      }
    }
  }

  /** Finds the plugin route for /plugins/<id>/…, or null. */
  findRoute(method, pathname) {
    const m = /^\/plugins\/([a-z0-9_-]+)(\/.*)?$/.exec(pathname);
    if (!m) return null;
    const p = this.plugins.get(m[1]);
    if (!p?.enabled) return null;
    const sub = m[2] || '/';
    const want = method === 'HEAD' ? ['HEAD', 'GET'] : [method];
    const route = p.routes.find((r) => want.includes(r.method) && (r.prefix ? sub.startsWith(r.prefix) : r.path === sub));
    return route ? { plugin: p, route, rest: route.prefix ? sub.slice(route.prefix.length) : '' } : null;
  }

  // ------------------------------------------------------------ sources (what the apps show)

  source(id) {
    const p = this.plugins.get(id);
    return p?.enabled && p.source ? p.source : null;
  }

  has(id, fn) { return typeof this.source(id)?.[fn] === 'function'; }

  /**
   * The group a favourite goes under on the Favorites screen: { id, title, order, style }. A plugin names its own
   * with source.favoriteGroups = { <kind>: { title, order, style } } – those are its own group (e.g. "Twitch
   * channels"); otherwise the usual kinds share a group across plugins, and anything else goes under "Other".
   */
  favoriteGroup(plugin, kind) {
    const k = str(kind);
    const own = k && this.source(plugin)?.favoriteGroups?.[k];
    if (own && typeof own === 'object') {
      const base = FAVORITE_GROUPS[k];
      return {
        id: `${plugin}:${k}`,
        title: text(own.title, 40) || { [T]: base?.title || 'Other' },
        order: Number.isFinite(Number(own.order)) ? Number(own.order) : base?.order ?? 90,
        style: FAVORITE_STYLES.includes(own.style) ? own.style : base?.style || 'landscape',
      };
    }
    const base = FAVORITE_GROUPS[k];
    if (base) return { id: k, title: { [T]: base.title }, order: base.order, style: base.style };
    return { id: 'other', title: { [T]: 'Other' }, order: 99, style: 'landscape' };
  }

  /**
   * Every group the Favorites screen can have – the usual ones, the ones the switched-on plugins name, and
   * "Other" – with the order they suggest. For the admin panel, where the order can be changed.
   */
  favoriteGroupList() {
    const out = Object.keys(FAVORITE_GROUPS).map((k) => ({ ...this.favoriteGroup(null, k), plugin: null }));
    for (const [id, p] of this.plugins) {
      const own = p.enabled && p.source?.favoriteGroups;
      if (!own || typeof own !== 'object') continue;
      for (const k of Object.keys(own).slice(0, 20)) if (/^[a-z_]{1,24}$/.test(k)) out.push({ ...this.favoriteGroup(id, k), plugin: id });
    }
    out.push({ ...this.favoriteGroup(null, null), plugin: null });
    return out.sort((a, b) => a.order - b.order);
  }

  /**
   * Works out a plugin's menu entries. source.menu is a list, or a (async) function returning one – so a plugin
   * can leave out entries that have nothing to show. Without menu: one entry named after the source.
   */
  async refreshMenu(p, announce) {
    const src = p.enabled && p.source;
    if (!src) return;
    let entries;
    if (typeof src.menu === 'function') {
      try {
        entries = await withTimeout(src.menu(), 60000, 'menu() did not answer in time');
      } catch (e) {
        this.log(`[plugin] ${p.id}: menu – ${e.message}`);
        entries = [];
      }
    } else entries = Array.isArray(src.menu) && src.menu.length ? src.menu : [{ id: 'home', title: src.name || p.meta?.name || p.id, icon: src.icon }];
    if (p.source !== src) return; // restarted meanwhile
    const next = [];
    for (const e of (Array.isArray(entries) ? entries : []).slice(0, 8)) {
      const id = /^[A-Za-z0-9_-]{1,32}$/.test(str(e?.id)) ? str(e.id) : null;
      if (!id || next.some((x) => x.id === id)) continue;
      next.push({ plugin: p.id, id, title: text(e.title, 40) || p.meta?.name || p.id, icon: clean(e.icon || src.icon, 4000) || null });
    }
    const changed = JSON.stringify(next) !== JSON.stringify(p.menuCache || []);
    p.menuCache = next;
    if (changed || announce) this.notify();
  }

  /** Menu entries from every enabled plugin, in install order (the server applies the admin's order). */
  menu() {
    const out = [];
    for (const p of this.plugins.values()) if (p.enabled && p.source) out.push(...(p.menuCache || []));
    return out;
  }

  /** Calls a source function with a timeout. */
  serviceOf(id, name) {
    const p = this.plugins.get(id);
    return (p?.enabled && p.services?.get(name)) || null;
  }

  async useService(id, name, args, timeoutMs = 60000) {
    const fn = this.serviceOf(id, name);
    if (!fn) throw new Error(`The plugin "${id}" does not offer "${name}" (is it installed and switched on?)`);
    return withTimeout(Promise.resolve().then(() => fn(...args)), timeoutMs, `${id} did not answer in time`);
  }

  async call(id, fn, args = [], timeoutMs = 15000) {
    const src = this.source(id);
    if (!src || typeof src[fn] !== 'function') throw new Error(`The plugin "${id}" cannot do that`);
    return withTimeout(src[fn](...args), timeoutMs, `${src.name || id} did not answer in time`);
  }

  // ---- validation of what plugins send, so the apps always get something they can draw

  imageUrl(id, v) {
    const s = clean(v, 2000);
    if (/^https?:\/\//.test(s)) return s;
    if (s.startsWith(`/plugins/${id}/`)) return s; // served by the plugin itself (fetched with the PIN)
    return null;
  }

  item(id, it) {
    const itemId = str(it?.id);
    if (!ITEM_ID.test(itemId)) return null;
    const out = {
      plugin: id,
      id: itemId,
      title: text(it.title, 200) || itemId,
      subtitle: text(it.subtitle, 200),
      image: this.imageUrl(id, it.image),
      backdrop: this.imageUrl(id, it.backdrop),
      description: text(it.description, 2000),
      kind: /^[a-z_]{1,24}$/.test(str(it.kind)) ? it.kind : null,
      action: it.action === 'open' ? 'open' : 'play',
      // The view that opens for action 'open' (with params { id }).
      view: /^[A-Za-z0-9_-]{1,32}$/.test(str(it.view)) ? str(it.view) : null,
      live: Boolean(it.live),
      favorite: it.favorite !== false,
    };
    if (Number(it.number) > 0) out.number = Math.round(Number(it.number));
    if (Number(it.viewers) >= 0 && it.viewers !== undefined && it.viewers !== null) out.viewers = Math.round(Number(it.viewers));
    if (Number(it.rating) > 0) out.rating = Math.round(Number(it.rating) * 10) / 10;
    for (const k of ['year', 'genre', 'badge']) { const v = text(it[k], 100); if (v) out[k] = v; }
    if (Number(it.duration) > 0) out.duration = Number(it.duration);
    // Shown but cannot be played (e.g. a song that was not found) – the apps grey it out and skip it.
    if (it.unavailable === true) out.unavailable = true;
    return out;
  }

  items(id, list, max = 500) {
    return (Array.isArray(list) ? list : []).map((it) => this.item(id, it)).filter(Boolean).slice(0, max);
  }

  /**
   * A view the plugin built from building blocks (see plugins/PLUGINS.md). It is passed on to the apps as it is –
   * they draw it – but it must be an object, not too deep and not too large.
   */
  view(id, d) {
    const message = (t) => ({ type: 'column', padding: 20, children: [{ type: 'text', text: t, style: 'dim' }] });
    if (!d || typeof d !== 'object' || Array.isArray(d)) return message(null);
    let depth = 0;
    const walk = (v, level) => {
      depth = Math.max(depth, level);
      if (depth > 40) throw new Error('The view is nested too deeply');
      if (Array.isArray(v)) v.forEach((x) => walk(x, level + 1));
      else if (v && typeof v === 'object') Object.values(v).forEach((x) => walk(x, level + 1));
    };
    walk(d, 0);
    if (JSON.stringify(d).length > 4_000_000) throw new Error('The view is too large');
    return d;
  }

  /** Search results: a list of items (one section) or { sections: [{ title, items, style }] }. */
  searchResults(id, d) {
    const sections = Array.isArray(d) ? [{ id: 'all', items: d }] : Array.isArray(d?.sections) ? d.sections : [];
    return sections.slice(0, 10).map((s, i) => ({
      id: clean(s.id, 64) || String(i),
      title: text(s.title, 120),
      style: ['landscape', 'poster', 'square', 'channels'].includes(s.style) ? s.style : 'landscape',
      items: this.items(id, s.items, 60),
    })).filter((s) => s.items.length);
  }

  /** Programmes for a channel guide: [{ title, description, start, end }] (seconds). */
  programmes(list, max = 200) {
    const seen = new Set();
    return (Array.isArray(list) ? list : [])
      .map((e) => ({ title: clean(e?.title, 200), description: clean(e?.description, 1000) || null, start: Math.floor(Number(e?.start)) || 0, end: Math.floor(Number(e?.end)) || 0 }))
      .filter((e) => e.title && e.end > e.start && !seen.has(e.start) && seen.add(e.start))
      .sort((a, b) => a.start - b.start)
      .slice(0, max);
  }

  /**
   * How the player looks and is controlled for this plugin (or one item, when resolve() returned `player`).
   * Whatever the plugin says is checked here, so the apps always get something valid.
   */
  playerSpec(id, override) {
    const src = this.source(id);
    if (!src) return null;
    const hasChat = typeof src.chat === 'function';
    const hasAction = typeof src.action === 'function';
    const raw = (override && typeof override === 'object' ? override : null) || (src.player && typeof src.player === 'object' ? src.player : {});
    const safeId = (v) => (/^[A-Za-z0-9_-]{1,32}$/.test(str(v)) ? str(v) : null);

    // channels: the plugin lists the channels to zap between (data('channels', { id })).
    // guide: the plugin has programme info for the overlay (data('epg', { ids })).
    const hasData = typeof src.data === 'function';
    const channels = hasData && Boolean(raw.channels);
    const guide = hasData && Boolean(raw.guide);
    // queue: the plugin tells what plays next (data('queue', { id })) – shown in a list at the side.
    const queue = hasData && Boolean(raw.queue);
    const keys = { ok: 'pause', up: 'info', down: 'settings', left: hasChat ? 'chat' : 'none', right: 'settings' };
    for (const k of KEYS) {
      const v = raw.keys?.[k];
      if (!KEY_ACTIONS.includes(v)) continue;
      if ((v === 'chat' && !hasChat) || (['channels', 'channel_up', 'channel_down'].includes(v) && !channels) || (v === 'queue' && !queue)) keys[k] = 'none';
      else keys[k] = v;
    }

    const list = Array.isArray(raw.settings) ? raw.settings : [...(hasChat ? [{ type: 'chat' }] : []), { type: 'quality' }, { type: 'audio' }, { type: 'subtitles' }];
    const settings = [];
    for (const s of list.slice(0, 12)) {
      if (!s || !SECTION_TYPES.includes(s.type)) continue;
      if (s.type === 'chat' && !hasChat) continue;
      if (s.type === 'actions' && !hasAction) continue;
      const out = { id: safeId(s.id) || s.type, type: s.type, title: text(s.title, 40) };
      if (s.type === 'choice' || s.type === 'actions') {
        out.options = (Array.isArray(s.options) ? s.options : [])
          .map((o) => ({ id: safeId(o?.id), label: text(o?.label, 60) }))
          .filter((o) => o.id && o.label)
          .slice(0, 20);
        if (!out.options.length) continue;
        if (s.type === 'choice') out.default = out.options.some((o) => o.id === s.default) ? s.default : out.options[0].id;
      }
      if (settings.some((x) => x.id === out.id)) continue;
      settings.push(out);
    }
    // overlay: a view drawn on top of the video (building blocks bound to media/player/room), or null for the app's own.
    const overlay = raw.overlay && typeof raw.overlay === 'object' && !Array.isArray(raw.overlay) ? this.view(id, raw.overlay) : null;
    // upNextBefore: "next" shows this many seconds before the end and the next item follows straight on, without
    // waiting for everyone (the apps buffer it in advance) – for music. 0 = the usual countdown after the end.
    const upNextBefore = Math.min(30, Math.max(0, Math.round(Number(raw.upNextBefore) || 0)));
    return { keys, settings, channels, guide, queue, overlay, upNextBefore };
  }

  /** Choices the player sent (?opt.<id>=<value>): only 'choice' settings the plugin declared, only valid values. */
  playerOptions(id, params) {
    const options = {};
    for (const s of this.playerSpec(id)?.settings || []) {
      if (s.type !== 'choice') continue;
      const v = str(params.get(`opt.${s.id}`));
      options[s.id] = s.options.some((o) => o.id === v) ? v : s.default;
    }
    return options;
  }

  // ------------------------------------------------------------ admin listing

  list() {
    return [...this.plugins.values()].map((p) => ({
      id: p.id,
      name: p.meta?.name || p.id,
      version: p.meta?.version || '',
      description: p.meta?.description || '',
      requires: p.meta?.requires || null,
      homepage: p.meta?.homepage || null,
      enabled: p.enabled,
      repository: this.repoOf(p),
      needs: (p.meta?.needs || []).map((n) => ({ ...n, installed: this.plugins.has(n.id), enabled: Boolean(this.plugins.get(n.id)?.enabled) })),
      autoUpdate: Boolean(p.autoUpdate),
      update: p.update ? { version: p.update.version, notes: p.update.notes, url: p.update.url } : null,
      updateError: p.updateError || null,
      updateCheckedAt: p.updateCheckedAt || null,
      error: p.error,
      menu: p.enabled && p.source ? this.menu().filter((m) => m.plugin === p.id).map((m) => (typeof m.title === 'object' ? m.title[T] : m.title)) : [],
      links: p.links || [],
      events: [...(p.handlers?.keys() || [])],
      settings: (p.meta?.settings || []).map((s) => ({
        ...s,
        value: s.type === 'secret' ? undefined : p.settings[s.key],
        isSet: s.type === 'secret' ? Boolean(p.settings[s.key]) : undefined,
      })),
    }));
  }
}
