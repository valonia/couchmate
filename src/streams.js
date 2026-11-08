// Streams: the room's media always points at /stream/<plugin>/<item id>. On each request the server asks
// the plugin where the stream is (resolve), remembers the answer for a while, and then
//   - redirects to the plugin's own endpoint (/plugins/<id>/…, e.g. an IPTV proxy), or
//   - passes an HLS playlist on with absolute addresses (optionally only one quality, for players
//     that cannot choose themselves), or
//   - redirects to any other http(s) address.
// That way stream addresses that expire (Twitch tokens) keep working for people who join later.

import { Readable } from 'node:stream';
import { json, str, ITEM_ID } from './util.js';

const RESOLVE_TTL = 8 * 60 * 1000;

export class Streams {
  constructor({ plugins, log = console.log }) {
    this.plugins = plugins;
    this.log = log;
    this.cache = new Map(); // "plugin:id:options" → { r, t }
  }

  /** The plugin's answer for an item: { url, type: 'hls' | 'file', live, title, subtitle, image, kind, player }. */
  async resolve(plugin, id, options = {}, fresh = false) {
    const key = `${plugin}:${id}:${JSON.stringify(options)}`;
    const hit = this.cache.get(key);
    if (!fresh && hit && Date.now() - hit.t < RESOLVE_TTL) return hit.r;
    const raw = await this.plugins.call(plugin, 'resolve', [id, { options }], 30000);
    const url = str(raw?.url);
    if (!/^https?:\/\//.test(url) && !url.startsWith(`/plugins/${plugin}/`)) throw new Error('The plugin returned no stream (is it on air right now?)');
    const type = raw.type === 'hls' || raw.type === 'file' ? raw.type : /\.m3u8(\?|$)/i.test(url) ? 'hls' : 'file';
    const r = { ...raw, url, type };
    this.cache.set(key, { r, t: Date.now() });
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value);
    return r;
  }

  /** The room changed what plays – forget answers for anything else (they may hold provider connections). */
  playing(media) {
    const keep = media ? `${media.plugin}:${media.id}:` : null;
    for (const k of this.cache.keys()) if (!keep || !k.startsWith(keep)) this.cache.delete(k);
  }

  /** GET /stream/<plugin>/<id>?pin=…&quality=…&opt.<id>=… */
  async serve(req, res, plugin, id, params) {
    if (!ITEM_ID.test(id)) return json(res, 400, { error: 'Invalid item' });
    const options = this.plugins.playerOptions(plugin, params);
    try {
      const r = await this.resolve(plugin, id, options);
      if (r.url.startsWith('/')) return redirect(res, withPin(r.url, params.get('pin')));
      if (r.type !== 'hls') return redirect(res, r.url);
      const { lines, variants, all } = await this.playlist(plugin, id, options);
      const pick = params.get('quality') && variants.find((v) => v.id === params.get('quality'));
      let out = lines;
      if (pick) {
        // Drop the other variants (the STREAM-INF line + the address line after it).
        const drop = new Set();
        for (const v of all) if (v.line !== pick.line) { drop.add(v.line); drop.add(v.line + 1); }
        out = lines.filter((_, i) => !drop.has(i));
      }
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' });
      res.end(out.join('\n'));
    } catch (e) {
      this.log(`[stream] ${plugin}:${id} – ${e.message}`);
      if (!res.headersSent) json(res, 502, { error: e.message });
    }
  }

  /** Qualities in an HLS stream (for players that cannot pick one themselves). */
  async qualities(plugin, id, params) {
    const r = await this.resolve(plugin, id, this.plugins.playerOptions(plugin, params));
    if (r.type !== 'hls' || r.url.startsWith('/')) return [];
    const { variants } = await this.playlist(plugin, id, this.plugins.playerOptions(plugin, params));
    return variants.map(({ id: vid, name, height }) => ({ id: vid, name, height }));
  }

  /** Fetches the plugin's HLS master playlist with absolute addresses and lists its variants. */
  async playlist(plugin, id, options) {
    let { url } = await this.resolve(plugin, id, options);
    let r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) {
      // The address has probably expired – get a new one.
      ({ url } = await this.resolve(plugin, id, options, true));
      r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    }
    if (!r.ok) throw new Error(`the stream answered ${r.status}`);
    const base = r.url || url;
    const abs = (u) => { try { return new URL(u, base).href; } catch { return u; } };
    const lines = (await r.text()).split('\n').map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (!t.startsWith('#')) return abs(t);
      return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${abs(u)}"`);
    });
    const groupNames = {};
    for (const l of lines) if (l.startsWith('#EXT-X-MEDIA:') && hlsAttr(l, 'TYPE') === 'VIDEO') groupNames[hlsAttr(l, 'GROUP-ID')] = hlsAttr(l, 'NAME');
    const variants = [];
    lines.forEach((l, i) => {
      if (!l.startsWith('#EXT-X-STREAM-INF:')) return;
      const height = Number((hlsAttr(l, 'RESOLUTION') || '').split('x')[1]) || 0;
      const fps = Number(hlsAttr(l, 'FRAME-RATE')) || 0;
      const vid = height ? `${height}p${fps >= 49 ? Math.round(fps) : ''}` : 'audio';
      const dup = variants.some((v) => v.id === vid);
      let name = groupNames[hlsAttr(l, 'VIDEO')] || (height ? vid : 'Audio only');
      if (name === 'audio_only') name = 'Audio only';
      variants.push({ id: vid, name, height, line: i, dup });
    });
    return { lines, variants: variants.filter((v) => !v.dup).sort((a, b) => b.height - a.height), all: variants };
  }
}

/** Reads an attribute from an HLS line, e.g. RESOLUTION=1280x720 or NAME="720p60". */
function hlsAttr(line, key) {
  const m = new RegExp(`[:,]${key}=(?:"([^"]*)"|([^,]*))`).exec(line);
  return m ? (m[1] ?? m[2]) : undefined;
}

function redirect(res, location) {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}

function withPin(url, pin) {
  if (!pin) return url;
  return `${url}${url.includes('?') ? '&' : '?'}pin=${encodeURIComponent(pin)}`;
}

/**
 * Passes an upstream response on to the client, with Range support (seeking in files).
 * Available to plugins as api.proxy(req, res, url, extraHeaders).
 */
export async function proxy(req, res, target, extraHeaders = {}, { userAgent = 'Couchmate' } = {}) {
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const headers = { 'user-agent': req.headers['user-agent'] || userAgent };
  if (req.headers.range) headers.range = req.headers.range;
  let up;
  try {
    up = await fetch(target, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers, signal: ac.signal });
  } catch {
    if (!res.headersSent && !ac.signal.aborted) json(res, 502, { error: 'Could not reach the source' });
    return;
  }
  const out = {};
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
    const v = up.headers.get(h);
    if (v) out[h] = v;
  }
  res.writeHead(up.status, { ...out, ...extraHeaders });
  if (!up.body || req.method === 'HEAD') return res.end();
  Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
}
