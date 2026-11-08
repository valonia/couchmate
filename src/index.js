// Couchmates-server
// - Hämtar katalog (live/filmer/serier) från Dispatcharr via Xtream API och normaliserar den.
// - Proxar strömmar så att klienterna aldrig ser Xtream-inloggningen (STREAM_MODE=proxy).
// - Håller ETT gemensamt "rum": vad som spelas, paus/play och position. Alla klienter synkas via WebSocket.

import http from 'node:http';
import { Readable } from 'node:stream';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { SharedVod } from './sharedvod.js';
import { History } from './history.js';
import { Favorites } from './favorites.js';
import { Reminders } from './reminders.js';
import { fileURLToPath } from 'node:url';

// Webbklienten (hemsidan) ligger i ../web och serveras av samma server.
const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/vendor/mpegts.js': [path.join('..', 'node_modules', 'mpegts.js', 'dist', 'mpegts.js'), 'text/javascript; charset=utf-8'],
};

const env = process.env;
const trimSlash = (s) => String(s || '').replace(/\/+$/, '');

const cfg = {
  port: Number(env.PORT || 8787),
  xtreamUrl: trimSlash(env.XTREAM_URL || 'http://localhost:9191'),
  user: env.XTREAM_USER || '',
  pass: env.XTREAM_PASS || '',
  pin: env.ROOM_PIN || '',
  streamMode: (env.STREAM_MODE || 'proxy').toLowerCase(),
  publicXtreamUrl: trimSlash(env.PUBLIC_XTREAM_URL || env.XTREAM_URL || 'http://localhost:9191'),
  liveExt: env.LIVE_EXT || 'ts',
  cacheMs: Number(env.CACHE_SECONDS || 300) * 1000,
  startTimeoutMs: Number(env.START_TIMEOUT_MS || 12000),
  startDelayMs: Number(env.START_DELAY_MS || 800),
  sharedVod: (env.SHARED_VOD || 'true').toLowerCase() !== 'false',
  cacheDir: env.CACHE_DIR || path.join(os.tmpdir(), 'synctv-cache'),
  lookaheadBytes: Number(env.SHARED_LOOKAHEAD_MB || 16) * 1024 * 1024,
  dataDir: env.DATA_DIR || path.join(process.cwd(), 'data'),
};

if (!cfg.user || !cfg.pass) {
  console.error('XTREAM_USER och XTREAM_PASS måste sättas (Xtream-inloggning från Dispatcharr).');
  process.exit(1);
}
if (!cfg.pin) console.warn('VARNING: ROOM_PIN är inte satt – alla som når servern kan använda den.');
if (cfg.sharedVod) {
  // Rensa rester från tidigare körningar (bara innehållet – mappen kan vara en Docker-volym).
  fs.mkdirSync(cfg.cacheDir, { recursive: true });
  for (const f of fs.readdirSync(cfg.cacheDir)) fs.rmSync(path.join(cfg.cacheDir, f), { recursive: true, force: true });
}

// Delad VOD: den film/det avsnitt som spelas i rummet hämtas EN gång från Dispatcharr
// och delas ut till alla tittare (se sharedvod.js).
let shared = null;

const history = new History(path.join(cfg.dataDir, 'history.json'));
const favorites = new Favorites(path.join(cfg.dataDir, 'favorites.json'));
const reminders = new Reminders(path.join(cfg.dataDir, 'reminders.json'));

function sharedFor(type, id, ext) {
  const m = state.media;
  if (!cfg.sharedVod || cfg.streamMode !== 'proxy') return null;
  if (!m || m.type !== type || m.id !== id || m.ext !== ext || type === 'live') return null;
  const key = `${type}-${id}`;
  if (shared?.key !== key) {
    shared?.close();
    shared = new SharedVod(key, upstreamUrl(type, id, ext), cfg.cacheDir, { lookahead: cfg.lookaheadBytes });
  }
  return shared;
}

function dropSharedIfStale() {
  const m = state.media;
  if (shared && (!m || shared.key !== `${m.type}-${m.id}`)) {
    shared.close();
    shared = null;
  }
}

// ---------------------------------------------------------------- hjälpare

const str = (v) => (v === null || v === undefined ? '' : String(v));
const clean = (v, max) => str(v).replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
// Bilder som ligger hos Dispatcharr (logotyper, omslag) skrivs om så att de hämtas via
// sync-servern – Dispatcharr anger ofta en adress (t.ex. Tailscale) som TV:n inte når.
const IMG_PATH = /^\/api\/(channels\/logos|vod)\//;
const img = (v) => {
  const s = str(v).trim().slice(0, 1000);
  if (!s) return null;
  try {
    const u = new URL(s);
    if (IMG_PATH.test(u.pathname)) {
      const q = new URLSearchParams(u.search);
      if (cfg.pin) q.set('pin', cfg.pin);
      return `/img${u.pathname}?${q}`;
    }
  } catch {
    // relativ adress (redan omskriven) – lämna som den är
  }
  return s;
};
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const b64 = (v) => {
  const s = str(v);
  if (!s || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return s;
  const d = Buffer.from(s, 'base64').toString('utf8');
  return d.includes('�') ? s : d;
};
const asArray = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);

function pinOk(given) {
  if (!cfg.pin) return true;
  const a = Buffer.from(str(given));
  const b = Buffer.from(cfg.pin);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}

// ---------------------------------------------------------------- Xtream

const cache = new Map();

async function xtream(params) {
  const qs = new URLSearchParams({ username: cfg.user, password: cfg.pass, ...params });
  const key = qs.toString();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < cfg.cacheMs) return hit.data;
  const r = await fetch(`${cfg.xtreamUrl}/player_api.php?${qs}`, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`Dispatcharr svarade ${r.status}`);
  const data = await r.json();
  cache.set(key, { t: Date.now(), data });
  return data;
}

const normCats = (d) =>
  asArray(d).map((c) => ({ id: str(c.category_id), name: clean(c.category_name, 200) || 'Okänd' }));

const KINDS = {
  live: {
    cats: 'get_live_categories',
    items: 'get_live_streams',
    map: (s) => ({
      id: str(s.stream_id),
      name: clean(s.name, 200),
      icon: img(s.stream_icon),
      ext: cfg.liveExt,
      num: num(s.num),
    }),
  },
  vod: {
    cats: 'get_vod_categories',
    items: 'get_vod_streams',
    map: (s) => ({
      id: str(s.stream_id),
      name: clean(s.name, 200),
      icon: img(s.stream_icon),
      ext: clean(s.container_extension, 8) || 'mp4',
      plot: clean(s.plot, 1000) || null,
      year: clean(s.year, 8) || null,
      genre: clean(s.genre, 100) || null,
      rating: Number(s.rating) > 0 ? Number(s.rating) : null,
    }),
  },
  series: {
    cats: 'get_series_categories',
    items: 'get_series',
    map: (s) => ({
      id: str(s.series_id),
      name: clean(s.name, 200),
      icon: img(s.cover),
      ext: '',
      plot: clean(s.plot, 1000) || null,
      year: clean(s.releaseDate || s.release_date, 10).slice(0, 4) || null,
      genre: clean(s.genre, 100) || null,
      rating: Number(s.rating) > 0 ? Number(s.rating) : null,
      backdrop: img(asArray(s.backdrop_path)[0]),
    }),
  },
};

// EPG (nu/nästa) per kanal via get_short_epg. Titlar är base64-kodade i Xtream.
async function shortEpg(id, limit = 6) {
  const d = await xtream({ action: 'get_short_epg', stream_id: id, limit });
  const seen = new Set();
  return asArray(d.epg_listings)
    .map((e) => ({
      title: clean(b64(e.title), 200),
      desc: clean(b64(e.description), 600) || null,
      start: Number(e.start_timestamp) || 0,
      end: Number(e.stop_timestamp) || 0,
    }))
    .filter((e) => e.title && e.end > e.start && !seen.has(e.start) && seen.add(e.start))
    .sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------- Sök

// Hela katalogen per typ (alla kategorier), sparad 30 min så att sökningar går snabbt.
const SEARCH_TTL = 30 * 60 * 1000;
const searchLists = new Map(); // kind -> { t, list, loading }

const fold = (s) => str(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
// Taggar som [4K], (2018), |SE| räknas inte vid matchning.
const searchable = (name) => fold(name).replace(/[\[(|][^\])|]*[\])|]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

async function catalog(kind) {
  const hit = searchLists.get(kind);
  if (hit?.list && Date.now() - hit.t < SEARCH_TTL) return hit.list;
  if (hit?.loading) return hit.loading;
  const loading = (async () => {
    const [items, cats] = await Promise.all([
      xtream({ action: KINDS[kind].items }),
      xtream({ action: KINDS[kind].cats }),
    ]);
    const catNames = new Map(normCats(cats).map((c) => [c.id, c.name]));
    const list = asArray(items).map((s) => {
      const item = KINDS[kind].map(s);
      item.categoryId = str(s.category_id) || null;
      item.categoryName = catNames.get(item.categoryId) || null;
      return { item, key: searchable(item.name) };
    });
    searchLists.set(kind, { t: Date.now(), list });
    return list;
  })();
  searchLists.set(kind, { ...hit, loading });
  try {
    return await loading;
  } catch (e) {
    searchLists.delete(kind);
    throw e;
  }
}

function rank(key, words, phrase) {
  if (!words.every((w) => key.includes(w))) return -1;
  if (key === phrase) return 0;
  if (key.startsWith(phrase)) return 1;
  if (words.every((w) => key.startsWith(w) || key.includes(' ' + w))) return 2;
  return 3;
}

async function search(q, limit) {
  const phrase = searchable(q);
  const words = phrase.split(' ').filter(Boolean);
  if (!words.length) return { live: [], vod: [], series: [] };
  const out = {};
  await Promise.all(
    ['live', 'vod', 'series'].map(async (kind) => {
      const list = await catalog(kind).catch(() => []);
      const seen = new Set();
      out[kind] = list
        .map((e) => ({ e, r: rank(e.key, words, phrase) }))
        .filter((x) => x.r >= 0 && !seen.has(x.e.item.id) && seen.add(x.e.item.id))
        .sort((a, b) => a.r - b.r || a.e.key.length - b.e.key.length)
        .slice(0, limit)
        .map((x) => x.e.item);
    })
  );
  return out;
}

async function mapLimit(list, n, fn) {
  const out = new Array(list.length);
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const k = i++;
      try { out[k] = await fn(list[k]); } catch { out[k] = null; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, worker));
  return out;
}

async function epgFor(ids) {
  const nowSec = Date.now() / 1000;
  const lists = await mapLimit(ids, 12, (id) => shortEpg(id));
  const out = {};
  ids.forEach((id, k) => {
    const l = (lists[k] || []).filter((e) => e.end > nowSec).slice(0, 4);
    if (l.length) out[id] = l;
  });
  return out;
}

/** Hela tablån för en kanal: pågående och kommande program (det Dispatcharr har, oftast ett par dygn). */
async function guideFor(id) {
  const nowSec = Date.now() / 1000;
  return (await shortEpg(id, 200)).filter((e) => e.end > nowSec).slice(0, 80);
}

async function seriesInfo(id) {
  const d = await xtream({ action: 'get_series_info', series_id: id });
  const info = d.info || {};
  const eps = d.episodes;
  const groups = Array.isArray(eps) ? eps.map((v) => [null, v]) : Object.entries(eps || {});
  const seasons = new Map();
  for (const [key, value] of groups) {
    const list = Array.isArray(value) ? value : value && typeof value === 'object' && 'id' in value ? [value] : [];
    for (const e of list) {
      const season = Number(e.season ?? key ?? 0) || 0;
      const num = Number(e.episode_num) || 0;
      if (!seasons.has(season)) seasons.set(season, []);
      seasons.get(season).push({
        id: str(e.id),
        title: clean(e.title, 200) || `Avsnitt ${num}`,
        episode: num,
        ext: clean(e.container_extension, 8) || 'mp4',
        icon: img(e.info?.movie_image),
      });
    }
  }
  return {
    name: clean(info.name, 200),
    icon: img(info.cover),
    plot: clean(info.plot, 1500) || null,
    year: clean(info.releaseDate || info.release_date, 10).slice(0, 4) || null,
    genre: clean(info.genre, 100) || null,
    rating: Number(info.rating) > 0 ? Number(info.rating) : null,
    backdrop: img(asArray(info.backdrop_path)[0]),
    seasons: [...seasons.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([season, episodes]) => ({ season, episodes: episodes.sort((a, b) => a.episode - b.episode) })),
  };
}

function upstreamUrl(type, id, ext, base = cfg.xtreamUrl) {
  const seg = { live: 'live', movie: 'movie', episode: 'series' }[type];
  return `${base}/${seg}/${encodeURIComponent(cfg.user)}/${encodeURIComponent(cfg.pass)}/${id}.${ext}`;
}

function mediaUrl(m) {
  if (cfg.streamMode === 'direct') return upstreamUrl(m.type, m.id, m.ext, cfg.publicXtreamUrl);
  return `/stream/${m.type}/${m.id}.${m.ext}` + (cfg.pin ? `?pin=${encodeURIComponent(cfg.pin)}` : '');
}

// Strömproxy med stöd för Range (spolning i filmer/avsnitt).
async function proxyStream(req, res, target, extraHeaders = {}) {
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const headers = { 'user-agent': req.headers['user-agent'] || 'SyncTV' };
  if (req.headers.range) headers.range = req.headers.range;
  let up;
  try {
    up = await fetch(target, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers, signal: ac.signal });
  } catch (e) {
    if (!res.headersSent && !ac.signal.aborted) json(res, 502, { error: 'Kunde inte nå Dispatcharr' });
    return;
  }
  const out = {};
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
    const v = up.headers.get(h);
    if (v) out[h] = v;
  }
  res.writeHead(up.status, { ...out, ...extraHeaders });
  if (!up.body || req.method === 'HEAD') return res.end();
  Readable.fromWeb(up.body)
    .on('error', () => res.destroy())
    .pipe(res);
}

// ---------------------------------------------------------------- HTTP

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p === '/health') return json(res, 200, { ok: true });
    if (STATIC[p] && req.method === 'GET') {
      const [file, type] = STATIC[p];
      try {
        const body = fs.readFileSync(path.join(WEB_DIR, file));
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
        return res.end(body);
      } catch {
        return json(res, 404, { error: 'Webbklienten saknas' });
      }
    }
    if (!pinOk(url.searchParams.get('pin') ?? req.headers['x-pin'])) return json(res, 401, { error: 'Fel PIN-kod' });

    let m;
    if ((m = p.match(/^\/api\/(live|vod|series)\/categories$/))) {
      return json(res, 200, normCats(await xtream({ action: KINDS[m[1]].cats })));
    }
    if ((m = p.match(/^\/api\/(live|vod|series)\/items$/))) {
      const params = { action: KINDS[m[1]].items };
      const cat = url.searchParams.get('category_id');
      if (cat) params.category_id = cat;
      return json(res, 200, asArray(await xtream(params)).map(KINDS[m[1]].map));
    }
    if (p === '/api/series/info') {
      const id = str(url.searchParams.get('id'));
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return json(res, 400, { error: 'Ogiltigt id' });
      return json(res, 200, await seriesInfo(id));
    }
    if (p === '/api/history') return json(res, 200, history.list());

    if (p === '/api/favorites') return json(res, 200, favorites.list());
    if (p === '/api/reminders') return json(res, 200, reminders.list());
    if (p === '/api/live/guide') {
      const id = str(url.searchParams.get('id'));
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return json(res, 400, { error: 'Ogiltig kanal' });
      return json(res, 200, await guideFor(id));
    }
    if (p === '/api/search') {
      const q = clean(url.searchParams.get('q'), 100);
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 40));
      return json(res, 200, await search(q, limit));
    }
    if (p === '/api/live/epg') {
      // ?ids=1,2,3  eller  ?category_id=X (alla kanaler i kategorin)
      let ids = str(url.searchParams.get('ids')).split(',').filter((s) => /^[A-Za-z0-9_-]{1,64}$/.test(s)).slice(0, 100);
      const cat = url.searchParams.get('category_id');
      if (!ids.length && cat) {
        ids = asArray(await xtream({ action: 'get_live_streams', category_id: cat })).map((s) => str(s.stream_id)).slice(0, 2000);
      }
      return json(res, 200, await epgFor(ids));
    }
    if (p.startsWith('/img/api/')) {
      const upPath = p.slice(4);
      if (!IMG_PATH.test(upPath) || upPath.includes('..')) return json(res, 400, { error: 'Ogiltig bild' });
      const q = new URLSearchParams(url.search);
      q.delete('pin');
      const qs = q.toString();
      return proxyStream(req, res, cfg.xtreamUrl + upPath + (qs ? `?${qs}` : ''), { 'cache-control': 'public, max-age=86400' });
    }
    if (p === '/api/state') {
      const cache = shared && { key: shared.key, size: shared.size, downloaded: shared.downloadedBytes(), complete: shared.complete };
      return json(res, 200, { state, members: memberList(), cache });
    }
    if ((m = p.match(/^\/stream\/(live|movie|episode)\/([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9]{1,8})$/))) {
      const sv = sharedFor(m[1], m[2], m[3]);
      if (sv && (await sv.serve(req, res))) return;
      return proxyStream(req, res, upstreamUrl(m[1], m[2], m[3]));
    }
    json(res, 404, { error: 'Hittades inte' });
  } catch (e) {
    console.error(`[http] ${p}:`, e.message);
    if (!res.headersSent) json(res, 502, { error: e.message });
    else res.destroy();
  }
});

// ---------------------------------------------------------------- Rummet

// position = sekunder in i mediet vid tidpunkten refTime (serverns klocka, ms).
// paused+waiting = servern väntar på att alla klienter buffrat klart innan uppspelning startar.
const state = {
  media: null,
  paused: true,
  waiting: false,
  position: 0,
  refTime: Date.now(),
  version: 0,
  changedBy: null,
  action: null,
  upNext: null, // { media, startsAt } – nästa avsnitt startar automatiskt vid startsAt
  reminder: null, // { key, title, start, channel, switchAt } – byter kanal för alla vid switchAt
};

const clients = new Map(); // ws -> klientinfo
let waitTimer = null;

// ---- Rummet sparas till fil så att det överlever omstarter (t.ex. när servern uppdateras).
// Efter omstart läggs filmer/avsnitt tillbaka PAUSADE på samma ställe; live fortsätter direkt.
const ROOM_FILE = path.join(cfg.dataDir, 'room.json');
let saveRoomTimer = null;

function writeRoom() {
  try {
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    const live = state.media?.type === 'live';
    fs.writeFileSync(ROOM_FILE, JSON.stringify({
      media: state.media,
      position: live ? 0 : currentPosition(),
      paused: state.paused && !state.waiting,
      changedBy: state.changedBy,
      savedAt: Date.now(),
    }));
  } catch (e) {
    console.warn('[rum] kunde inte spara:', e.message);
  }
}
function saveRoom() {
  clearTimeout(saveRoomTimer);
  saveRoomTimer = setTimeout(writeRoom, 300);
}

function restoreRoom() {
  let r;
  try { r = JSON.parse(fs.readFileSync(ROOM_FILE, 'utf8')); } catch { return; }
  const media = r?.media && sanitizeMedia(r.media);
  if (!media) return;
  state.media = media;
  state.refTime = Date.now();
  state.changedBy = r.changedBy || null;
  state.action = 'restore';
  if (media.type === 'live') {
    state.position = 0;
    state.paused = false;
  } else {
    state.position = Math.max(0, Number(r.position) || 0);
    state.paused = true;
  }
  console.log(`[rum] återställde "${media.title}" (${media.type === 'live' ? 'live' : `pausad på ${Math.round(state.position)} s`})`);
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    clearTimeout(saveRoomTimer);
    writeRoom();
    process.exit(0);
  });
}

const now = () => Date.now();

function currentPosition() {
  if (state.paused) return state.position;
  return state.position + Math.max(0, now() - state.refTime) / 1000;
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of clients.keys()) if (ws.readyState === 1) ws.send(data);
}

const stateMsg = () => ({ type: 'state', state, serverTime: now() });
const broadcastState = () => broadcast(stateMsg());

function memberList() {
  return [...clients.values()]
    .filter((c) => c.name)
    .map((c) => ({
      id: c.id, name: c.name, device: c.device, watching: c.watching,
      // Senaste rapport från enheten: position och avvikelse (s) mot där den borde vara.
      position: c.position ?? null, drift: c.drift ?? null, status: c.status ?? null,
      reportAge: c.reportedAt ? Math.round((now() - c.reportedAt) / 1000) : null,
    }));
}
const broadcastMembers = () => broadcast({ type: 'members', members: memberList() });

function mutate(by, action, fn) {
  clearUpNext(); // varje ändring (byte, paus, spolning, stopp) avbryter "nästa avsnitt"
  clearTimeout(waitTimer);
  waitTimer = null;
  // Spara var vi var innan något ändras (för 'fortsätt titta').
  if (state.media) history.progress(state.media, currentPosition());
  fn();
  if (action === 'load' && state.media) {
    history.touch(state.media, by, state.position);
    if (state.media.type === 'episode' && state.media.seriesId && favorites.markEpisodeSeen(state.media.seriesId, state.media.id)) broadcastFavorites();
  }
  dropSharedIfStale();
  state.version++;
  state.changedBy = by;
  state.action = action;
  if (state.waiting) waitTimer = setTimeout(() => startPlayback('timeout'), cfg.startTimeoutMs);
  broadcastState();
  checkReady();
  saveRoom();
}

function startPlayback(reason) {
  if (!state.waiting) return;
  clearTimeout(waitTimer);
  waitTimer = null;
  state.waiting = false;
  state.paused = false;
  state.refTime = now() + cfg.startDelayMs;
  state.version++;
  state.action = 'start';
  if (reason === 'timeout') console.log('[rum] alla blev inte redo i tid – startar ändå');
  broadcastState();
  saveRoom();
}

function checkReady() {
  if (!state.waiting) return;
  const required = [...clients.values()].filter((c) => c.name && c.watching);
  if (required.every((c) => c.readyVersion === state.version)) startPlayback('ready');
}

function sanitizeMedia(m) {
  if (!m || !['live', 'movie', 'episode'].includes(m.type)) return null;
  const id = str(m.id);
  const ext = str(m.ext) || (m.type === 'live' ? cfg.liveExt : 'mp4');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || !/^[A-Za-z0-9]{1,8}$/.test(ext)) return null;
  const media = {
    type: m.type,
    id,
    ext,
    title: clean(m.title, 200) || id,
    subtitle: clean(m.subtitle, 200) || null,
    icon: img(m.icon),
    categoryId: clean(m.categoryId, 64) || null,
    // Serie-id behövs för att kunna spela nästa avsnitt automatiskt.
    seriesId: m.type === 'episode' && /^[A-Za-z0-9_-]{1,64}$/.test(str(m.seriesId)) ? str(m.seriesId) : null,
  };
  media.url = mediaUrl(media);
  return media;
}

function handle(c, msg) {
  const isLive = state.media?.type === 'live';
  switch (msg.type) {
    case 'hello':
      c.name = clean(msg.name, 40) || 'Gäst';
      c.device = clean(msg.device, 40);
      send(c.ws, stateMsg());
      send(c.ws, { type: 'favorites', favorites: favorites.list() });
      send(c.ws, { type: 'reminders', reminders: reminders.list() });
      broadcastMembers();
      console.log(`[rum] ${c.name} (${c.device || 'okänd enhet'}) anslöt`);
      break;

    case 'ping':
      send(c.ws, { type: 'pong', t: msg.t, s: now() });
      break;

    case 'watching':
      c.watching = !!msg.value;
      broadcastMembers();
      checkReady();
      break;

    case 'ready':
      if (Number(msg.duration) > 0) history.setDuration(state.media, Number(msg.duration));
      if (msg.version === state.version) {
        c.readyVersion = msg.version;
        checkReady();
      }
      break;

    case 'load': {
      const media = sanitizeMedia(msg.media);
      if (!media) return;
      const pos = Math.max(0, Number(msg.position) || 0);
      // Alla anslutna hoppar automatiskt in i spelaren när något nytt laddas.
      for (const o of clients.values()) if (o.name) o.watching = true;
      mutate(c.name, 'load', () => {
        state.media = media;
        state.refTime = now();
        if (media.type === 'live') {
          state.position = 0;
          state.paused = false;
          state.waiting = false;
        } else {
          state.position = pos;
          state.paused = true;
          state.waiting = true;
        }
      });
      broadcastMembers();
      console.log(`[rum] ${c.name} startade ${media.type} "${media.title}"`);
      break;
    }

    case 'toggle':
      if (!state.media) return;
      return handle(c, { type: state.paused && !state.waiting ? 'play' : 'pause' });

    case 'play':
      if (!state.media) return;
      if (isLive) {
        if (state.paused) mutate(c.name, 'play', () => { state.paused = false; state.refTime = now(); });
      } else if (state.paused && !state.waiting) {
        mutate(c.name, 'play', () => { state.waiting = true; });
      }
      break;

    case 'pause':
      if (!state.media) return;
      if (!state.paused || state.waiting) {
        mutate(c.name, 'pause', () => {
          state.position = currentPosition();
          state.paused = true;
          state.waiting = false;
        });
      }
      break;

    case 'seek': {
      if (!state.media || isLive) return;
      const p = Math.max(0, Number(msg.position) || 0);
      const wasPlaying = !state.paused || state.waiting;
      mutate(c.name, 'seek', () => {
        state.position = p;
        state.paused = true;
        state.waiting = wasPlaying;
      });
      break;
    }

    case 'report': {
      const pos = Number(msg.position);
      const at = Number(msg.at) || now();
      if (!Number.isFinite(pos)) return;
      c.position = pos;
      c.status = clean(msg.status, 60) || null;
      c.reportedAt = now();
      if (state.media && state.media.type !== 'live' && !state.waiting) {
        const expected = state.paused || at < state.refTime ? state.position : state.position + (at - state.refTime) / 1000;
        c.drift = Math.round((pos - expected) * 1000) / 1000;
      } else c.drift = null;
      break;
    }

    case 'fav_add': {
      const it = msg.item || {};
      const type = str(it.type);
      const id = str(it.id);
      if (!['series', 'movie', 'live'].includes(type) || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return;
      const added = favorites.add({
        type, id,
        name: clean(it.name, 200) || id,
        icon: img(it.icon),
        ext: clean(it.ext, 8),
        categoryId: clean(it.categoryId, 64) || null,
        categoryName: clean(it.categoryName, 200) || null,
      }, c.name);
      if (added) {
        console.log(`[favoriter] ${c.name} lade till ${added.name}`);
        broadcastFavorites();
        if (type === 'series') checkFavorite(added.key);
      }
      break;
    }

    case 'fav_remove':
      if (favorites.remove(str(msg.key))) broadcastFavorites();
      break;

    case 'fav_seen':
      if (favorites.markSeen(str(msg.key))) broadcastFavorites();
      break;

    case 'next_now':
      if (state.upNext) playUpNext(c.name);
      break;

    case 'next_cancel':
      if (state.upNext) {
        mutate(c.name, 'pause', () => {
          state.position = currentPosition();
          state.paused = true;
          state.waiting = false;
        });
        console.log(`[rum] ${c.name} avbröt nästa avsnitt`);
      }
      break;

    case 'duration':
      if (Number(msg.value) > 0) history.setDuration(state.media, Number(msg.value));
      break;

    case 'reminder_add': {
      const ch = msg.channel || {};
      const pr = msg.program || {};
      const id = str(ch.id);
      const start = Math.floor(Number(pr.start));
      const end = Math.floor(Number(pr.end));
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || !(start > 0) || !(end > start) || end <= now() / 1000) return;
      const added = reminders.add({
        channel: {
          id,
          name: clean(ch.name, 200) || id,
          icon: img(ch.icon),
          ext: /^[A-Za-z0-9]{1,8}$/.test(str(ch.ext)) ? str(ch.ext) : cfg.liveExt,
          categoryId: clean(ch.categoryId, 64) || null,
          categoryName: clean(ch.categoryName, 200) || null,
        },
        title: clean(pr.title, 200) || '?',
        desc: clean(pr.desc, 600) || null,
        start,
        end,
      }, c.name);
      if (added) {
        broadcastReminders();
        checkReminders();
      }
      break;
    }

    case 'reminder_remove': {
      const key = str(msg.key);
      if (reminders.remove(key)) broadcastReminders();
      if (state.reminder?.key === key) clearReminder(true);
      break;
    }

    case 'reminder_now':
      if (state.reminder) playReminder(c.name);
      break;

    case 'reminder_cancel':
      if (state.reminder) {
        console.log(`[påminnelse] ${c.name} avbröt "${state.reminder.title}"`);
        reminders.remove(state.reminder.key);
        clearReminder(true);
        broadcastReminders();
      }
      break;

    case 'history_remove':
      history.remove(str(msg.key));
      break;

    case 'history_clear':
      history.clear();
      console.log(`[rum] ${c.name} rensade historiken`);
      break;

    case 'stop':
      if (!state.media) return;
      mutate(c.name, 'stop', () => {
        state.media = null;
        state.paused = true;
        state.waiting = false;
        state.position = 0;
      });
      console.log(`[rum] ${c.name} stoppade uppspelningen`);
      break;
  }
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') return socket.destroy();
  if (!pinOk(url.searchParams.get('pin'))) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const c = { id: randomUUID().slice(0, 8), ws, name: null, device: '', watching: false, readyVersion: -1, alive: true };
    clients.set(ws, c);
    ws.on('pong', () => { c.alive = true; });
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      try { handle(c, msg); } catch (e) { console.error('[ws]', e); }
    });
    ws.on('close', () => {
      clients.delete(ws);
      if (c.name) console.log(`[rum] ${c.name} lämnade`);
      broadcastMembers();
      checkReady();
    });
  });
});

// ---------------------------------------------------------------- Nästa avsnitt

const UPNEXT_SECONDS = Number(env.UPNEXT_SECONDS || 10);
let upNextTimer = null;
let checkingNext = false;
const pad2 = (n) => String(n).padStart(2, '0');

function clearUpNext() {
  clearTimeout(upNextTimer);
  upNextTimer = null;
  state.upNext = null;
}

/** Nästa avsnitt i serien (fortsätter med nästa säsong efter sista avsnittet). */
/** Serie-id för ett avsnitt. Saknas det (äldre historik) letas serien upp via namnet. */
async function seriesIdFor(media) {
  if (media.seriesId) return media.seriesId;
  const key = searchable(media.title);
  const hit = (await catalog('series')).find((e) => e.key === key);
  return hit?.item.id || null;
}

async function nextEpisode(media) {
  if (media?.type !== 'episode') return null;
  const seriesId = await seriesIdFor(media);
  if (!seriesId) return null;
  const info = await seriesInfo(seriesId);
  const all = info.seasons.flatMap((s) => s.episodes.map((e) => ({ ...e, season: s.season })));
  const i = all.findIndex((e) => e.id === media.id);
  if (i < 0 || i + 1 >= all.length) return null;
  const e = all[i + 1];
  return sanitizeMedia({
    type: 'episode', id: e.id, ext: e.ext, title: media.title,
    subtitle: `S${pad2(e.season)}E${pad2(e.episode)} · ${e.title}`,
    icon: e.icon || info.icon || media.icon,
    categoryId: media.categoryId, seriesId,
  });
}

function playUpNext(by) {
  const next = state.upNext?.media;
  if (!next) return;
  for (const o of clients.values()) if (o.name) o.watching = true;
  mutate(by, 'load', () => {
    state.media = next;
    state.position = 0;
    state.refTime = now();
    state.paused = true;
    state.waiting = true;
  });
  broadcastMembers();
  console.log(`[rum] nästa avsnitt: ${next.title} ${next.subtitle}`);
}

/** Körs varje sekund: när ett avsnitt tagit slut visas "nästa avsnitt" och det startar efter en stund. */
async function checkEnded() {
  const cur = state.media;
  if (checkingNext || !cur || cur.type !== 'episode' || state.paused || state.waiting || state.upNext) return;
  const dur = history.durationOf(cur);
  if (!(dur > 0) || currentPosition() < dur - 1) return;
  checkingNext = true;
  try {
    const next = await nextEpisode(cur).catch(() => null);
    if (state.media !== cur || state.paused || state.upNext) return;
    if (!next) {
      // Sista avsnittet – stanna i slutet.
      mutate(null, 'ended', () => { state.position = dur; state.paused = true; });
      return;
    }
    state.upNext = { media: next, startsAt: now() + UPNEXT_SECONDS * 1000 };
    state.version++;
    state.action = 'upnext';
    broadcastState();
    upNextTimer = setTimeout(() => playUpNext(null), UPNEXT_SECONDS * 1000);
  } finally {
    checkingNext = false;
  }
}
setInterval(checkEnded, 1000).unref();

// ---------------------------------------------------------------- Påminnelser

// Kanalen byts så här långt innan programmet börjar, och kortet "byter kanal om …" visas så här långt innan bytet.
const REMINDER_SWITCH_SECONDS = Number(env.REMINDER_SWITCH_SECONDS || 30);
const REMINDER_WARN_SECONDS = Number(env.REMINDER_WARN_SECONDS || 30);

function broadcastReminders() {
  broadcast({ type: 'reminders', reminders: reminders.list() });
}

function clearReminder(announce) {
  if (!state.reminder) return;
  state.reminder = null;
  if (announce) {
    state.version++;
    state.action = 'reminder_clear';
    broadcastState();
  }
}

function playReminder(by) {
  const r = (state.reminder && reminders.get(state.reminder.key)) || state.reminder;
  if (!r) return;
  const ch = r.channel;
  const media = sanitizeMedia({ type: 'live', id: ch.id, ext: ch.ext || cfg.liveExt, title: ch.name, subtitle: ch.categoryName, icon: ch.icon, categoryId: ch.categoryId });
  reminders.remove(r.key);
  state.reminder = null;
  broadcastReminders();
  if (!media) return;
  for (const o of clients.values()) if (o.name) o.watching = true;
  mutate(by, 'load', () => {
    state.media = media;
    state.position = 0;
    state.refTime = now();
    state.paused = false;
    state.waiting = false;
  });
  broadcastMembers();
  console.log(`[påminnelse] bytte till ${ch.name} för "${r.title}"`);
}

/** Körs varje sekund: visar kortet när det närmar sig och byter kanal i tid. */
function checkReminders() {
  const nowMs = now();
  const nowSec = nowMs / 1000;
  if (reminders.prune(nowSec)) broadcastReminders();

  if (state.reminder) {
    if (nowMs >= state.reminder.switchAt) playReminder(null);
    return;
  }
  for (const r of reminders.list()) {
    const switchAt = (r.start - REMINDER_SWITCH_SECONDS) * 1000;
    if (nowMs < switchAt - REMINDER_WARN_SECONDS * 1000) break; // sorterad lista – resten ligger längre fram
    if (r.end <= nowSec) continue;
    // Spelas kanalen redan behövs inget byte.
    if (state.media?.type === 'live' && state.media.id === r.channel.id) {
      reminders.remove(r.key);
      broadcastReminders();
      continue;
    }
    state.reminder = {
      key: r.key, title: r.title, start: r.start, addedBy: r.addedBy,
      channel: { id: r.channel.id, name: r.channel.name, icon: r.channel.icon },
      // Har servern varit nere och tiden redan passerat: byt om några sekunder.
      switchAt: Math.max(switchAt, nowMs + 5000),
    };
    state.version++;
    state.action = 'reminder';
    broadcastState();
    console.log(`[påminnelse] "${r.title}" börjar snart – byter till ${r.channel.name}`);
    return;
  }
}
setInterval(checkReminders, 1000).unref();

// ---------------------------------------------------------------- Favoriter: nya avsnitt

const FAV_CHECK_MS = Number(env.FAV_CHECK_MINUTES || 30) * 60 * 1000;

function broadcastFavorites() {
  broadcast({ type: 'favorites', favorites: favorites.list() });
}

/** Hämtar seriens avsnitt (förbi cachen) och markerar nya. */
async function checkFavorite(key) {
  const fav = favorites.get(key);
  if (!fav || fav.type !== 'series') return;
  try {
    const params = { action: 'get_series_info', series_id: fav.id };
    cache.delete(new URLSearchParams({ username: cfg.user, password: cfg.pass, ...params }).toString());
    const info = await seriesInfo(fav.id);
    const episodes = info.seasons.flatMap((s) => s.episodes.map((e) => ({ id: e.id, label: `S${pad2(s.season)}E${pad2(e.episode)}` })));
    if (favorites.updateEpisodes(key, episodes)) broadcastFavorites();
  } catch (e) {
    console.warn(`[favoriter] kunde inte kolla ${fav.name}: ${e.message}`);
  }
}

async function checkAllFavorites() {
  for (const key of favorites.seriesKeys()) await checkFavorite(key);
}
setTimeout(checkAllFavorites, 15_000).unref();
setInterval(checkAllFavorites, FAV_CHECK_MS).unref();

// Uppdatera positionen i historiken medan något spelas.
setInterval(() => {
  if (state.media && !state.paused) history.progress(state.media, currentPosition());
  if (state.media && !state.paused) writeRoom();
}, 15000).unref();

setInterval(() => {
  for (const [ws, c] of clients) {
    if (!c.alive) { ws.terminate(); continue; }
    c.alive = false;
    ws.ping();
  }
}, 20000);

restoreRoom();

server.listen(cfg.port, () => {
  console.log(`Couchmates-server lyssnar på port ${cfg.port}`);
  console.log(`Dispatcharr: ${cfg.xtreamUrl}  (strömläge: ${cfg.streamMode})`);
  // Värm upp sökkatalogen så att första sökningen går snabbt (och håll den varm).
  const warm = () => {
    for (const kind of ['live', 'vod', 'series']) catalog(kind).catch((e) => console.warn(`[sök] ${kind}: ${e.message}`));
  };
  warm();
  setInterval(warm, SEARCH_TTL - 60_000).unref();
});
