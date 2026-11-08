// Couchmate server
// - The room: one shared playback that every app follows (room.js).
// - Favourites, history, reminders and new-episode checks for the whole room.
// - Plugins provide everything that is shown and played (plugins.js, plugins/PLUGINS.md).
// - The admin panel at /admin and the download page at /download (admin.js).

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { installLogCapture, setLogSecrets } from './logbuf.js';
import { Settings } from './settings.js';
import { History } from './history.js';
import { Favorites } from './favorites.js';
import { Reminders } from './reminders.js';
import { PluginHost } from './plugins.js';
import { Streams } from './streams.js';
import { Room } from './room.js';
import { Translator } from './i18n.js';
import { MenuLayout } from './menu.js';
import { createAdmin } from './admin.js';
import { json, readJson, clean, str, SAFE_ID } from './util.js';

installLogCapture();

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const env = process.env;
const cfg = {
  port: Number(env.PORT || 8787),
  dataDir: env.DATA_DIR || path.join(process.cwd(), 'data'),
  cacheDir: env.CACHE_DIR || path.join(os.tmpdir(), 'couchmate-cache'),
};
fs.mkdirSync(cfg.dataDir, { recursive: true });
fs.mkdirSync(cfg.cacheDir, { recursive: true });
// Leftovers from earlier runs (only the contents – the folder may be a Docker volume).
for (const f of fs.readdirSync(cfg.cacheDir)) fs.rmSync(path.join(cfg.cacheDir, f), { recursive: true, force: true });

const settings = new Settings(path.join(cfg.dataDir, 'settings.json'));
const pin = () => str(settings.get('pin'));
const updateSecrets = () => setLogSecrets([pin(), encodeURIComponent(pin())]);
updateSecrets();

const history = new History(path.join(cfg.dataDir, 'history.json'));
const favorites = new Favorites(path.join(cfg.dataDir, 'favorites.json'));
const reminders = new Reminders(path.join(cfg.dataDir, 'reminders.json'));
const menuLayout = new MenuLayout(path.join(cfg.dataDir, 'menu.json'));
const translator = new Translator(path.join(cfg.dataDir, 'translations.json'), {
  engine: null, // the translation engine is plugged in here (see i18n.js)
  enabled: () => Boolean(settings.get('translation')),
});

// The room and the plugins need each other: plugins control the room, the room plays from plugins.
const roomApi = {};
const plugins = new PluginHost({
  dir: path.join(cfg.dataDir, 'plugins'),
  bundledDir: path.join(ROOT, 'plugins'),
  stateFile: path.join(cfg.dataDir, 'plugins.json'),
  dataDir: path.join(cfg.dataDir, 'plugin-data'),
  cacheDir: cfg.cacheDir,
  room: roomApi,
});
const streams = new Streams({ plugins });
const room = new Room({ settings, plugins, streams, history, favorites, reminders, translator, roomFile: path.join(cfg.dataDir, 'room.json') });
Object.assign(roomApi, room.api());

plugins.onChange(() => {
  room.pluginsChanged();
  room.broadcast({ type: 'menu_changed' }); // the apps reload their menu straight away
});

const admin = createAdmin({
  dataDir: cfg.dataDir, settings, plugins, room, roomApi, favorites, reminders, history, menuLayout, version: VERSION,
  menuChanged: () => room.broadcast({ type: 'menu_changed' }),
});

settings.onChange((changed) => {
  if (changed.includes('pin')) {
    updateSecrets();
    room.disconnectAll(4001, 'The PIN code has changed');
  }
});

// ---------------------------------------------------------------- access

/** null = ok, otherwise [status, error, code]. The apps cannot connect until a PIN is set in the admin panel. */
function pinCheck(given) {
  if (!pin()) return [503, 'The server is not set up yet. Set a PIN code in the admin panel.', 'setup'];
  const a = Buffer.from(str(given));
  const b = Buffer.from(pin());
  if (a.length !== b.length || !timingSafeEqual(a, b)) return [401, 'Wrong PIN code', 'pin'];
  return null;
}
const givenPin = (req, url) => url.searchParams.get('pin') ?? req.headers['x-pin'];

// ---------------------------------------------------------------- responses for the apps

/** Translates a response into the device's language (waits a moment for new translations). */
async function localized(res, url, body) {
  const lang = Translator.normalize(url.searchParams.get('lang'));
  if (translator.pending(body, lang)) {
    translator.localize(body, lang); // queues the missing texts
    await translator.settle(1500);
  }
  json(res, 200, translator.localize(body, lang));
}

const ctxOf = (url) => ({ lang: Translator.normalize(url.searchParams.get('lang')) || 'en' });

/** Search every plugin at once (those that do not answer within 8 s are skipped). */
async function searchAll(q, ctx) {
  if (str(q).trim().length < 2) return [];
  const list = [...new Set(plugins.menu().map((m) => m.plugin))].filter((id) => plugins.has(id, 'search'));
  const results = await Promise.all(list.map(async (id) => {
    try {
      const sections = plugins.searchResults(id, await plugins.call(id, 'search', [q, ctx], 8000));
      return sections.length ? { plugin: id, name: plugins.plugins.get(id)?.meta?.name || id, sections } : null;
    } catch (e) {
      console.warn(`[search] ${id}: ${e.message}`);
      return null;
    }
  }));
  return results.filter(Boolean);
}

/** Lazy data for a screen. Known names are checked so the apps can rely on their shape. */
async function pluginData(id, name, url) {
  const params = Object.fromEntries([...url.searchParams].filter(([k]) => k !== 'pin' && k !== 'lang').map(([k, v]) => [k, v.slice(0, 2000)]));
  const d = await plugins.call(id, 'data', [name, params, ctxOf(url)], 30000);
  if (name === 'group') return { message: d?.message ?? null, items: plugins.items(id, Array.isArray(d) ? d : d?.items, 5000) };
  if (name === 'channels') return plugins.items(id, Array.isArray(d) ? d : d?.items, 5000);
  if (name === 'guide') return plugins.programmes(Array.isArray(d) ? d : d?.programmes);
  if (name === 'epg') {
    const out = {};
    for (const [k, v] of Object.entries(d && typeof d === 'object' ? d : {}).slice(0, 2000)) {
      const list = plugins.programmes(v, 6);
      if (list.length) out[k] = list;
    }
    return out;
  }
  return d ?? null;
}

// ---------------------------------------------------------------- HTTP

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p === '/health') return json(res, 200, { ok: true });
    if (p === '/' && req.method === 'GET') { res.writeHead(302, { location: '/download' }); return res.end(); }
    // What the app's connect screen asks first (no PIN needed).
    if (p === '/api/info') return json(res, 200, { app: 'Couchmate', name: settings.get('serverName') || 'Couchmate', version: VERSION, ready: Boolean(pin()) });
    if (await admin.handle(req, res, p)) return;

    // Plugin endpoints: /plugins/<id>/… – PIN, admin login or public, as the plugin chose.
    if (p.startsWith('/plugins/')) {
      const hit = plugins.findRoute(req.method, p);
      if (!hit) return json(res, 404, { error: 'Not found' });
      if (hit.route.auth === 'admin' && !admin.isAdmin(req)) return json(res, 401, { error: 'Log in to the admin panel first' });
      if (hit.route.auth === 'pin') {
        const bad = pinCheck(givenPin(req, url));
        if (bad && !admin.isAdmin(req)) return json(res, bad[0], { error: bad[1], code: bad[2] });
      }
      return await hit.route.handler(req, res, { path: hit.rest, query: url.searchParams });
    }

    const bad = pinCheck(givenPin(req, url));
    if (bad) return json(res, bad[0], { error: bad[1], code: bad[2] });

    let m;
    if (p === '/api/auth') return json(res, 200, { ok: true, name: settings.get('serverName') || 'Couchmate' });
    if (p === '/api/menu') return localized(res, url, menuLayout.apply(plugins.menu()));
    if ((m = p.match(/^\/api\/screen\/([a-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,32})$/))) {
      if (!plugins.has(m[1], 'screen')) return json(res, 404, { error: 'No such screen' });
      return localized(res, url, plugins.screen(m[1], await plugins.call(m[1], 'screen', [m[2], ctxOf(url)], 30000)));
    }
    if ((m = p.match(/^\/api\/open\/([a-z0-9_-]{1,64})$/))) {
      const id = str(url.searchParams.get('id'));
      if (!plugins.has(m[1], 'open')) return json(res, 404, { error: 'This plugin has no detail pages' });
      return localized(res, url, plugins.screen(m[1], await plugins.call(m[1], 'open', [id, ctxOf(url)], 30000)));
    }
    if ((m = p.match(/^\/api\/data\/([a-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,32})$/))) {
      if (!plugins.has(m[1], 'data')) return json(res, 404, { error: 'No such data' });
      return localized(res, url, await pluginData(m[1], m[2], url));
    }
    if (p === '/api/search') return localized(res, url, await searchAll(clean(url.searchParams.get('q'), 100), ctxOf(url)));
    if (p === '/api/history') return json(res, 200, history.list());
    if (p === '/api/favorites') return json(res, 200, favorites.list());
    if (p === '/api/reminders') return json(res, 200, reminders.list());
    if (p === '/api/state') return localized(res, url, { state: room.state, members: room.members() });
    if ((m = p.match(/^\/api\/qualities\/([a-z0-9_-]{1,64})$/))) {
      return json(res, 200, await streams.qualities(m[1], str(url.searchParams.get('id')), url.searchParams));
    }
    // The apps' own UI strings: POST { texts: [...] } → { text: translation }.
    if (p === '/api/i18n' && req.method === 'POST') {
      const lang = Translator.normalize(url.searchParams.get('lang'));
      const texts = ((await readJson(req, 200_000)).texts || []).filter((t) => typeof t === 'string' && t.length <= 500).slice(0, 1000);
      if (lang) { translator.strings(texts, lang); await translator.settle(3000); }
      return json(res, 200, { lang: lang || 'en', translations: lang ? translator.strings(texts, lang) : {}, complete: !translator.pending(texts.map((t) => ({ $t: t })), lang) });
    }
    if ((m = p.match(/^\/stream\/([a-z0-9_-]{1,64})\/([^/]{1,500})$/))) {
      if (!SAFE_ID.test(m[1])) return json(res, 400, { error: 'Invalid plugin' });
      return streams.serve(req, res, m[1], decodeURIComponent(m[2]), url.searchParams);
    }
    json(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(`[http] ${p}:`, e.message);
    if (!res.headersSent) json(res, 502, { error: e.message });
    else res.destroy();
  }
});

// ---------------------------------------------------------------- WebSocket (the room)

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') return socket.destroy();
  const bad = pinCheck(url.searchParams.get('pin'));
  if (bad) {
    socket.write(`HTTP/1.1 ${bad[0]} ${bad[0] === 401 ? 'Unauthorized' : 'Service Unavailable'}\r\nConnection: close\r\n\r\n`);
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => room.attach(ws));
});

// ---------------------------------------------------------------- start / stop

function shutdown() {
  room.shutdown();
  for (const s of [history, favorites, reminders, translator]) s.flush();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(cfg.port, async () => {
  console.log(`Couchmate ${VERSION} listening on port ${cfg.port}  (admin: /admin, downloads: /download)`);
  if (!admin.hasPassword()) console.warn('Open /admin in a browser to create the admin password.');
  if (!pin()) console.warn('No PIN code set yet – the apps cannot connect until you set one in the admin panel.');
  await plugins.loadAll().catch((e) => console.warn('[plugin]', e.message));
  await room.restore();
});
