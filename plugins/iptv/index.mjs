// IPTV plugin for Couchmate: live TV, movies and series from Dispatcharr over the Xtream API.
//
// - Three menu entries: Live TV (channels with a programme guide), Movies and Series.
// - Search finds channels, movies and series.
// - Streams go through this plugin (proxy mode), so the apps never see the Xtream login.
//   Movies and episodes are downloaded once and shared by every viewer (sharedvod.mjs).
// - The next episode starts automatically, and favourite series report new episodes.
// - A merged programme guide for Dispatcharr: the provider's guide first, fallback sources fill the gaps.
//
// Item ids: "live:<stream id>", "movie:<stream id>:<ext>", "series:<series id>",
//           "episode:<episode id>:<ext>:<series id>".

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { SharedVod } from './sharedvod.mjs';
import { buildMergedEpg } from './epgmerge.mjs';
import { liveView, postersView, seriesView, liveOverlay } from './views.mjs';

const ICONS = {
  live: 'M21 6h-7.59l3.29-3.29L16 2l-4 4-4-4-.71.71L10.59 6H3c-1.1 0-2 .89-2 2v12c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V8c0-1.11-.9-2-2-2zm0 14H3V8h18v12zM9 10v8l7-4z',
  movies: 'M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z',
  series: 'M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8 12.5v-9l6 4.5-6 4.5z',
};
const KINDS = {
  live: { cats: 'get_live_categories', items: 'get_live_streams' },
  movies: { cats: 'get_vod_categories', items: 'get_vod_streams' },
  series: { cats: 'get_series_categories', items: 'get_series' },
};
const SEARCH_TTL = 30 * 60 * 1000;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const EXT = /^[A-Za-z0-9]{1,8}$/;

const str = (v) => (v === null || v === undefined ? '' : String(v));
const clean = (v, max) => str(v).replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
const asArray = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []);
const pad2 = (n) => String(n).padStart(2, '0');
const trimSlash = (s) => str(s).trim().replace(/\/+$/, '');
/** Xtream sends guide titles base64-encoded. */
const b64 = (v) => {
  const s = str(v);
  if (!s || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return s;
  const d = Buffer.from(s, 'base64').toString('utf8');
  return d.includes('�') ? s : d;
};
const fold = (s) => str(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
// Tags like [4K], (2018), |SE| do not count when matching.
/** Removes typical IPTV tags from titles: "Film [PRE] (2018)" → "Film". */
const cleanTitle = (name) => str(name).replace(/\s*[\[(][^\])]*[\])]/g, '').replace(/\s{2,}/g, ' ').trim() || str(name);
const searchable = (name) => fold(name).replace(/[\[(|][^\])|]*[\])|]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

export default function setup(api) {
  const s = api.settings;
  const cfg = {
    url: trimSlash(s.xtreamUrl),
    user: str(s.user),
    pass: str(s.pass),
    mode: s.streamMode === 'direct' ? 'direct' : 'proxy',
    publicUrl: trimSlash(s.publicXtreamUrl) || trimSlash(s.xtreamUrl),
    sharedVod: s.sharedVod !== false,
    liveExt: EXT.test(str(s.liveExt)) ? s.liveExt : 'ts',
    cacheMs: Math.max(0, Number(s.cacheSeconds) || 0) * 1000,
  };
  const configured = Boolean(cfg.url && cfg.user && cfg.pass);
  const timers = [];
  const every = (ms, fn) => { const t = setInterval(fn, ms); t.unref?.(); timers.push(t); };
  const later = (ms, fn) => { const t = setTimeout(fn, ms); t.unref?.(); timers.push(t); };

  // ---------------------------------------------------------------- Xtream

  const cache = new Map();
  async function xtream(params, { fresh = false } = {}) {
    if (!configured) throw new Error('IPTV is not set up yet – fill in the Dispatcharr settings in the admin panel.');
    const qs = new URLSearchParams({ username: cfg.user, password: cfg.pass, ...params });
    const key = qs.toString();
    const hit = cache.get(key);
    if (!fresh && hit && Date.now() - hit.t < cfg.cacheMs) return hit.data;
    const r = await fetch(`${cfg.url}/player_api.php?${qs}`, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`Dispatcharr answered ${r.status}`);
    const data = await r.json();
    cache.set(key, { t: Date.now(), data });
    return data;
  }

  // Images on Dispatcharr (logos, covers) are fetched through this plugin – Dispatcharr often
  // reports an address (e.g. Tailscale) that the TV cannot reach.
  const IMG_PATH = /^\/api\/(channels\/logos|vod)\//;
  function img(v) {
    const raw = clean(v, 1000);
    if (!raw) return null;
    try {
      const u = new URL(raw);
      if (IMG_PATH.test(u.pathname)) return `/plugins/${api.id}/img${u.pathname}${u.search}`;
      return /^https?:$/.test(u.protocol) ? raw : null;
    } catch {
      return null;
    }
  }

  const rating = (v) => (Number(v) > 0 ? Number(v) : null);

  // Turns Xtream entries into Couchmate items.
  const toItem = {
    live: (x) => ({
      id: `live:${str(x.stream_id)}`, kind: 'channel', live: true, title: clean(x.name, 200),
      image: img(x.stream_icon), number: Number(x.num) || null,
    }),
    movies: (x) => ({
      id: `movie:${str(x.stream_id)}:${EXT.test(str(x.container_extension)) ? x.container_extension : 'mp4'}`, kind: 'movie',
      title: cleanTitle(clean(x.name, 200)), image: img(x.stream_icon), description: clean(x.plot, 1000) || null,
      year: clean(x.year, 8) || (/[\[(]((?:19|20)\d{2})[\])]/.exec(str(x.name)) || [])[1] || null, genre: clean(x.genre, 100) || null, rating: rating(x.rating),
    }),
    series: (x) => ({
      id: `series:${str(x.series_id)}`, kind: 'series', action: 'open', view: 'show',
      title: cleanTitle(clean(x.name, 200)), image: img(x.cover), backdrop: img(asArray(x.backdrop_path)[0]),
      description: clean(x.plot, 1000) || null, year: clean(x.releaseDate || x.release_date, 10).slice(0, 4) || null,
      genre: clean(x.genre, 100) || null, rating: rating(x.rating),
    }),
  };

  const categories = async (kind) => asArray(await xtream({ action: KINDS[kind].cats }))
    .map((c) => ({ id: str(c.category_id), title: clean(c.category_name, 200) || 'Unknown' }))
    .filter((c) => ID.test(c.id));

  async function groupItems(kind, group) {
    const params = { action: KINDS[kind].items };
    if (group && group !== 'all') params.category_id = group;
    return asArray(await xtream(params)).map(toItem[kind]);
  }

  // ---------------------------------------------------------------- the whole catalogue (search, zapping)

  const lists = new Map(); // kind → { t, list, loading }
  async function catalog(kind) {
    const hit = lists.get(kind);
    if (hit?.list && Date.now() - hit.t < SEARCH_TTL) return hit.list;
    if (hit?.loading) return hit.loading;
    const loading = (async () => {
      const list = asArray(await xtream({ action: KINDS[kind].items })).map((x) => {
        const item = toItem[kind](x);
        return { item, category: str(x.category_id) || null, key: searchable(item.title) };
      });
      lists.set(kind, { t: Date.now(), list });
      return list;
    })();
    lists.set(kind, { ...hit, loading });
    try {
      return await loading;
    } catch (e) {
      lists.delete(kind);
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

  async function search(q, limit = 40) {
    const phrase = searchable(q);
    const words = phrase.split(' ').filter(Boolean);
    if (!words.length) return { live: [], movies: [], series: [] };
    const out = {};
    await Promise.all(Object.keys(KINDS).map(async (kind) => {
      const list = await catalog(kind).catch(() => []);
      const seen = new Set();
      out[kind] = list
        .map((e) => ({ e, r: rank(e.key, words, phrase) }))
        .filter((x) => x.r >= 0 && !seen.has(x.e.item.id) && seen.add(x.e.item.id))
        .sort((a, b) => a.r - b.r || a.e.key.length - b.e.key.length)
        .slice(0, limit)
        .map((x) => x.e.item);
    }));
    return out;
  }

  // ---------------------------------------------------------------- programme guide

  async function shortEpg(streamId, limit = 6) {
    const d = await xtream({ action: 'get_short_epg', stream_id: streamId, limit });
    return asArray(d.epg_listings).map((e) => ({
      title: clean(b64(e.title), 200),
      description: clean(b64(e.description), 1000) || null,
      start: Number(e.start_timestamp) || 0,
      end: Number(e.stop_timestamp) || 0,
    }));
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

  const liveId = (id) => (/^live:([A-Za-z0-9_-]{1,64})$/.exec(str(id)) || [])[1] || null;

  /** Now and next for many channels: { "live:1": [programmes] }. */
  async function epgFor(ids) {
    const nowSec = Date.now() / 1000;
    const wanted = ids.map((id) => [id, liveId(id)]).filter(([, sid]) => sid).slice(0, 200);
    const lists = await mapLimit(wanted, 12, ([, sid]) => shortEpg(sid));
    const out = {};
    wanted.forEach(([id], k) => {
      const l = (lists[k] || []).filter((e) => e.end > nowSec).sort((a, b) => a.start - b.start).slice(0, 4);
      if (l.length) out[id] = l;
    });
    return out;
  }

  /** The full schedule for one channel (whatever Dispatcharr has, usually a couple of days). */
  async function guideFor(id) {
    const sid = liveId(id);
    if (!sid) return [];
    const nowSec = Date.now() / 1000;
    return (await shortEpg(sid, 200)).filter((e) => e.end > nowSec).slice(0, 120);
  }

  // ---------------------------------------------------------------- series

  async function seriesInfo(seriesId, { fresh = false } = {}) {
    const d = await xtream({ action: 'get_series_info', series_id: seriesId }, { fresh });
    const info = d.info || {};
    const eps = d.episodes;
    const groups = Array.isArray(eps) ? eps.map((v) => [null, v]) : Object.entries(eps || {});
    const seasons = new Map();
    for (const [key, value] of groups) {
      const list = Array.isArray(value) ? value : value && typeof value === 'object' && 'id' in value ? [value] : [];
      for (const e of list) {
        const season = Number(e.season ?? key ?? 0) || 0;
        const num = Number(e.episode_num) || 0;
        const ext = EXT.test(str(e.container_extension)) ? e.container_extension : 'mp4';
        if (!ID.test(str(e.id))) continue;
        if (!seasons.has(season)) seasons.set(season, []);
        seasons.get(season).push({
          id: `episode:${str(e.id)}:${ext}:${seriesId}`,
          season,
          episode: num,
          label: `S${pad2(season)}E${pad2(num)}`,
          name: clean(e.title, 200) || null,
          image: img(e.info?.movie_image),
          description: clean(e.info?.plot, 1000) || null,
          duration: Number(e.info?.duration_secs) || null,
        });
      }
    }
    return {
      id: seriesId,
      title: clean(info.name, 200),
      image: img(info.cover),
      backdrop: img(asArray(info.backdrop_path)[0]),
      description: clean(info.plot, 1500) || null,
      year: clean(info.releaseDate || info.release_date, 10).slice(0, 4) || null,
      genre: clean(info.genre, 100) || null,
      rating: rating(info.rating),
      seasons: [...seasons.entries()].sort((a, b) => a[0] - b[0]).map(([season, list]) => ({ season, episodes: list.sort((a, b) => a.episode - b.episode) })),
    };
  }

  const episodeItem = (info, e) => ({
    id: e.id,
    kind: 'episode',
    title: e.name || api.t('Episode {n}', { n: e.episode }),
    subtitle: e.label,
    image: e.image || info.image,
    description: e.description,
    duration: e.duration,
  });

  /** The episode after this one (continues with the next season after the last episode). */
  async function nextEpisode(id) {
    const m = /^episode:([^:]+):[^:]+:([A-Za-z0-9_-]{1,64})$/.exec(id);
    if (!m) return null;
    const info = await seriesInfo(m[2]);
    const all = info.seasons.flatMap((x) => x.episodes);
    const i = all.findIndex((e) => e.id === id);
    if (i < 0 || i + 1 >= all.length) return null;
    const e = all[i + 1];
    return { ...episodeItem(info, e), title: info.title, subtitle: [e.label, e.name].filter(Boolean).join(' · ') };
  }

  // ---------------------------------------------------------------- streams

  const upstream = (seg, id, ext, base = cfg.url) => `${base}/${seg}/${encodeURIComponent(cfg.user)}/${encodeURIComponent(cfg.pass)}/${id}.${ext}`;

  /** Where the apps fetch the stream: through this plugin (proxy) or straight from Dispatcharr (direct). */
  const streamUrl = (seg, id, ext) => (cfg.mode === 'direct' ? upstream(seg, id, ext, cfg.publicUrl) : `/plugins/${api.id}/stream/${seg}/${id}.${ext}`);

  // The movie/episode playing in the room is downloaded ONCE and shared with every viewer.
  let shared = null;
  function sharedFor(seg, id, ext) {
    if (!cfg.sharedVod || cfg.mode !== 'proxy' || seg === 'live') return null;
    const m = api.room.state().media;
    const itemId = seg === 'movie' ? `movie:${id}:${ext}` : null;
    const playing = m?.plugin === api.id && (m.id === itemId || (seg === 'series' && m.id.startsWith(`episode:${id}:${ext}:`)));
    if (!playing) return null;
    const key = `${seg}-${id}`;
    if (shared?.key !== key) {
      shared?.close();
      shared = new SharedVod(key, upstream(seg, id, ext), api.cacheDir, { lookahead: 16 * 1024 * 1024, log: api.log });
    }
    return shared;
  }
  api.on('state', ({ state }) => {
    const m = state.media;
    if (!shared) return;
    const [seg, id] = shared.key.split('-');
    const still = m?.plugin === api.id && (seg === 'movie' ? m.id.startsWith(`movie:${id}:`) : m.id.startsWith(`episode:${id}:`));
    if (!still) { shared.close(); shared = null; }
  });

  api.route('GET', '/stream/*', async (req, res, { path: rest }) => {
    const m = /^(live|movie|series)\/([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9]{1,8})$/.exec(rest);
    if (!m) { res.writeHead(400); return res.end(); }
    const sv = sharedFor(m[1], m[2], m[3]);
    if (sv && (await sv.serve(req, res))) return;
    return api.proxy(req, res, upstream(m[1], m[2], m[3]));
  });

  api.route('GET', '/img/*', (req, res, { path: rest, query }) => {
    const upPath = `/${rest}`;
    if (!IMG_PATH.test(upPath) || upPath.includes('..')) { res.writeHead(400); return res.end(); }
    const q = new URLSearchParams(query);
    q.delete('pin');
    const qs = q.toString();
    return api.proxy(req, res, cfg.url + upPath + (qs ? `?${qs}` : ''), { 'cache-control': 'public, max-age=86400' });
  });

  // ---------------------------------------------------------------- merged programme guide (for Dispatcharr)

  const epg = {
    primaryUrl: str(s.epgPrimaryUrl),
    countries: str(s.epgFallbackCountries || 'auto').toLowerCase(),
    template: str(s.epgFallbackTemplate),
    extraUrls: str(s.epgFallbackUrl).split(',').map((u) => u.trim()).filter(Boolean),
    refreshMs: Math.max(1, Number(s.epgMergeHours) || 3) * 3600 * 1000,
    extraMap: Object.fromEntries(str(s.epgFallbackMap).split(',').map((x) => x.split('=').map((y) => y.trim())).filter((x) => x.length === 2 && x[0] && x[1])),
  };
  const epgFile = path.join(api.dataDir, 'merged-epg.xml.gz');
  const merge = { gz: null, stats: null, builtAt: 0, building: null, error: null };
  try {
    merge.gz = fs.readFileSync(epgFile);
    merge.builtAt = fs.statSync(epgFile).mtimeMs;
  } catch { /* not built yet */ }

  /** The countries among the channels, from the end of their names ("V Sport Motor FHD SE" → "se"). */
  async function epgCountries() {
    if (epg.countries !== 'auto') return epg.countries.split(',').map((c) => c.trim()).filter(Boolean);
    try {
      const counts = {};
      for (const x of asArray(await xtream({ action: 'get_live_streams' }))) {
        const m = /\b([A-Z]{2})\s*(?:\[[^\]]*\]\s*)*$/.exec(clean(x.name, 200));
        if (m) counts[m[1].toLowerCase()] = (counts[m[1].toLowerCase()] || 0) + 1;
      }
      // Countries with at least three channels (a single name that happens to end in two capitals does not count).
      const list = Object.entries(counts).filter(([, n]) => n >= 3).map(([c]) => c);
      return list.length ? list : ['se'];
    } catch {
      return ['se'];
    }
  }

  async function rebuildEpg() {
    if (!epg.primaryUrl) return;
    if (merge.building) return merge.building;
    merge.building = (async () => {
      try {
        const countries = await epgCountries();
        const fallbackUrls = [...new Set([...countries.map((c) => epg.template.replace('{CC}', c.toUpperCase())), ...epg.extraUrls])];
        const { xml, stats } = await buildMergedEpg({ primaryUrl: epg.primaryUrl, fallbackUrls, extraMap: epg.extraMap, log: api.log });
        stats.countries = countries;
        const gz = zlib.gzipSync(xml);
        fs.writeFileSync(epgFile, gz);
        Object.assign(merge, { gz, stats, builtAt: Date.now(), error: null });
      } catch (e) {
        merge.error = e.message;
        api.log(`could not build the merged guide: ${e.message}`);
      } finally {
        merge.building = null;
      }
    })();
    return merge.building;
  }

  api.route('GET', '/epg/merged.xml.gz', async (req, res) => {
    if (!epg.primaryUrl) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('No primary guide is set in the IPTV plugin settings.'); }
    if (!merge.gz) await rebuildEpg();
    else if (Date.now() - merge.builtAt > epg.refreshMs) rebuildEpg();
    if (!merge.gz) { res.writeHead(503, { 'content-type': 'text/plain' }); return res.end('The guide is being built – try again in a moment.'); }
    res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8', 'content-encoding': 'gzip', 'cache-control': 'no-store', 'content-length': merge.gz.length });
    res.end(merge.gz);
  });

  if (epg.primaryUrl) {
    later(5000, () => { if (!merge.gz || Date.now() - merge.builtAt > epg.refreshMs) rebuildEpg(); });
    every(epg.refreshMs, rebuildEpg);
  }

  // Status page for the admin panel.
  const esc = (v) => str(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  api.route('GET', '/admin', (req, res) => {
    const st = merge.stats;
    const ago = merge.builtAt ? new Date(merge.builtAt).toLocaleString('en-GB') : 'never';
    const rows = st ? Object.entries(st.filled || {}).slice(0, 25).map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td class="num">${v} programmes</td></tr>`).join('') : '';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>IPTV – Couchmate</title><link rel="stylesheet" href="/admin/admin.css"></head><body><main class="main" style="max-width:900px;margin:0 auto">
<div class="page-head"><h2>IPTV</h2><p>Connection to Dispatcharr and the merged programme guide.</p></div>
<div class="grid">
<section class="card"><h3>Dispatcharr</h3><dl class="kv">
  <dt>Address</dt><dd>${esc(cfg.url || 'not set')}</dd><dt>Stream mode</dt><dd>${esc(cfg.mode)}</dd>
  <dt>Shared download</dt><dd>${shared ? `${(shared.downloadedBytes() / 1e6).toFixed(0)} MB${shared.size ? ` of ${(shared.size / 1e6).toFixed(0)} MB` : ''}` : 'nothing right now'}</dd>
</dl></section>
<section class="card"><h3>Merged guide</h3>${!epg.primaryUrl ? '<p class="muted">No primary guide is set. Add your provider\'s XMLTV link in the plugin settings.</p>' : `<dl class="kv">
  <dt>Built</dt><dd>${merge.building ? 'building now…' : esc(ago)}</dd>
  <dt>For Dispatcharr</dt><dd><code>/plugins/${api.id}/epg/merged.xml.gz?pin=&lt;PIN&gt;</code></dd>
  ${st ? `<dt>Countries</dt><dd>${esc((st.countries || []).join(', ').toUpperCase())}</dd><dt>Matched channels</dt><dd>${st.matchedChannels}</dd><dt>Programmes filled</dt><dd>${st.addedProgrammes}</dd>` : ''}
  ${merge.error ? `<dt>Error</dt><dd class="error">${esc(merge.error)}</dd>` : ''}
</dl><form method="post" action="admin/rebuild" style="margin-top:12px"><button class="btn primary">Rebuild now</button></form>`}</section>
${rows ? `<section class="card wide"><h3>Channels with the most filled in</h3><div class="table-wrap"><table><tbody>${rows}</tbody></table></div></section>` : ''}
</div></main></body></html>`);
  }, { auth: 'admin' });
  api.route('POST', '/admin/rebuild', async (req, res) => {
    await rebuildEpg();
    res.writeHead(303, { location: `/plugins/${api.id}/admin` });
    res.end();
  }, { auth: 'admin' });
  api.link('Status and merged guide', `/plugins/${api.id}/admin`);

  // ---------------------------------------------------------------- what the apps see

  const LIVE_PLAYER = {
    keys: { ok: 'channels', up: 'channel_up', down: 'channel_down', left: 'channels', right: 'settings' },
    channels: true,
    guide: true,
    settings: [{ type: 'audio', title: api.t('Audio') }, { type: 'subtitles', title: api.t('Subtitles') }],
    overlay: liveOverlay(api.t),
  };
  const VOD_PLAYER = {
    keys: { ok: 'pause', up: 'info', down: 'settings', left: 'seek_back', right: 'seek_forward' },
    settings: [{ type: 'audio', title: api.t('Audio') }, { type: 'subtitles', title: api.t('Subtitles') }],
  };

  api.source({
    name: 'IPTV',
    icon: ICONS.live,
    // Only the entries that have something to show (none until Dispatcharr is set up).
    async menu() {
      if (!configured) return [];
      const entries = [
        { id: 'live', title: api.t('Live TV'), icon: ICONS.live },
        { id: 'movies', title: api.t('Movies'), icon: ICONS.movies },
        { id: 'series', title: api.t('Series'), icon: ICONS.series },
      ];
      const counts = await Promise.all(entries.map((e) => catalog(e.id).then((l) => l.length).catch(() => 0)));
      return entries.filter((_, i) => counts[i] > 0);
    },
    player: VOD_PLAYER,

    /** The plugin's own views: live, movies, series (the menu entries) and show (one series). */
    async view(id, params) {
      const message = (text) => ({ type: 'column', padding: 20, children: [{ type: 'text', text, style: 'dim' }] });
      if (!configured) return message(api.t('IPTV is not set up yet. Fill in the Dispatcharr settings in the admin panel.'));
      if (id === 'live') return liveView(api.t, await categories('live'));
      if (id === 'movies' || id === 'series') return postersView(api.t, id, await categories(id));
      if (id === 'show') {
        const m = /^series:([A-Za-z0-9_-]{1,64})$/.exec(str(params.id));
        if (!m) return message(api.t('Nothing here.'));
        const info = await seriesInfo(m[1]);
        const item = { id: params.id, kind: 'series', action: 'open', view: 'show', title: info.title, image: info.image, backdrop: info.backdrop, description: info.description, year: info.year, genre: info.genre, rating: info.rating };
        return seriesView(api.t, {
          seasons: info.seasons.map((x) => ({
            id: String(x.season),
            title: x.season ? api.t('Season {n}', { n: x.season }) : api.t('Extras'),
            items: x.episodes.map((e) => ({ ...episodeItem(info, e), minutes: e.duration ? Math.max(1, Math.round(e.duration / 60)) : null })),
          })),
        }, item);
      }
      return message(api.t('Nothing here.'));
    },

    async data(name, params) {
      if (name === 'group') {
        if (!KINDS[params.menu]) return [];
        return groupItems(params.menu, str(params.group));
      }
      if (name === 'epg') return epgFor(str(params.ids).split(',').slice(0, 200));
      if (name === 'guide') return guideFor(str(params.id));
      if (name === 'now') {
        // For the player's overlay: the channel's number and what is on now and next.
        const id = str(params.id);
        const nowSec = Date.now() / 1000;
        const list = (await epgFor([id]))[id] || [];
        const hit = (await catalog('live').catch(() => [])).find((e) => e.item.id === id)?.item;
        return { number: hit?.number || null, now: list.find((p) => p.start <= nowSec && p.end > nowSec) || null, next: list.find((p) => p.start > nowSec) || null };
      }
      if (name === 'channels') {
        // The channels to zap between: the same category as the channel that is playing.
        const list = await catalog('live');
        const cat = list.find((e) => e.item.id === str(params.id))?.category;
        return cat ? list.filter((e) => e.category === cat).map((e) => e.item) : [];
      }
      return null;
    },

    async search(q) {
      const r = await search(q);
      return {
        sections: [
          { id: 'live', title: api.t('Live TV'), style: 'channels', items: r.live },
          { id: 'movies', title: api.t('Movies'), style: 'poster', items: r.movies },
          { id: 'series', title: api.t('Series'), style: 'poster', items: r.series },
        ],
      };
    },

    async resolve(id) {
      let m;
      if ((m = /^live:([A-Za-z0-9_-]{1,64})$/.exec(id))) {
        const hit = (await catalog('live').catch(() => [])).find((e) => e.item.id === id)?.item;
        return { url: streamUrl('live', m[1], cfg.liveExt), type: cfg.liveExt === 'm3u8' ? 'hls' : 'file', live: true, kind: 'channel', title: hit?.title, image: hit?.image, player: LIVE_PLAYER };
      }
      if ((m = /^movie:([A-Za-z0-9_-]{1,64}):([A-Za-z0-9]{1,8})$/.exec(id))) {
        const hit = (await catalog('movies').catch(() => [])).find((e) => e.item.id === id)?.item;
        return { url: streamUrl('movie', m[1], m[2]), type: 'file', live: false, kind: 'movie', title: hit?.title, image: hit?.image, player: VOD_PLAYER };
      }
      if ((m = /^episode:([A-Za-z0-9_-]{1,64}):([A-Za-z0-9]{1,8}):([A-Za-z0-9_-]{1,64})$/.exec(id))) {
        const info = await seriesInfo(m[3]).catch(() => null);
        const e = info?.seasons.flatMap((x) => x.episodes).find((x) => x.id === id);
        return {
          url: streamUrl('series', m[1], m[2]), type: 'file', live: false, kind: 'episode',
          title: info?.title, subtitle: e ? [e.label, e.name].filter(Boolean).join(' · ') : undefined, image: e?.image || info?.image,
          player: VOD_PLAYER,
        };
      }
      throw new Error('Unknown item');
    },

    next: (id) => nextEpisode(id),

    /** Episodes of a favourite series, so the server can flag new ones. */
    async episodes(id) {
      const m = /^series:([A-Za-z0-9_-]{1,64})$/.exec(id);
      if (!m) return [];
      const info = await seriesInfo(m[1], { fresh: true });
      return info.seasons.flatMap((x) => x.episodes.map((e) => ({ id: e.id, label: e.label })));
    },
  });

  // Warm up the search catalogue so the first search is quick (and keep it warm).
  if (configured) {
    // When the catalogue changes (e.g. the first movies appear), the menu follows.
    const warm = () => Promise.all(Object.keys(KINDS).map((kind) => catalog(kind).catch((e) => api.log(`catalogue ${kind}: ${e.message}`))))
      .then(() => api.menuChanged());
    later(2000, warm);
    every(SEARCH_TTL - 60_000, warm);
  } else {
    api.log('not set up yet – fill in the Dispatcharr settings in the admin panel');
  }

  return () => {
    timers.forEach((t) => { clearInterval(t); clearTimeout(t); });
    shared?.close();
    shared = null;
  };
}
