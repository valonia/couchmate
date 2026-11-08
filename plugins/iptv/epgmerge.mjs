// Merged programme guide (XMLTV), in order of priority:
//   1. the primary guide (your provider's) is always used where it has programmes,
//   2. the fallback sources ONLY fill the gaps – times where the primary has nothing for a channel.
// The primary channel ids are kept, so every mapping in Dispatcharr keeps working.
// Channels are matched between sources by name ("V Sport Motor FHD SE" ≈ "[VIASMHD] V Sport Motor HD"),
// and only within the same country (the channel id's suffix, e.g. ".se" or ".no"), so that e.g. the
// Swedish and Norwegian "Eurosport 1" are never mixed up. There can be several fallback sources (one per country).

import zlib from 'node:zlib';
import { promisify } from 'node:util';

const gunzip = promisify(zlib.gunzip);

async function fetchText(url, timeoutMs = 180000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'Couchmate-EPG/1.0' } });
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
  let buf = Buffer.from(await r.arrayBuffer());
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = await gunzip(buf);
  return buf.toString('utf8');
}

/** "20261108054400 +0100" → milliseconds (UTC). */
function xmltvTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/.exec(s || '');
  if (!m) return NaN;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  if (!m[7]) return t;
  const sign = m[7][0] === '-' ? -1 : 1;
  return t - sign * (Number(m[7].slice(1, 3)) * 60 + Number(m[7].slice(3, 5))) * 60000;
}

const attr = (tag, name) => (new RegExp(`\\b${name}="([^"]*)"`).exec(tag) || [])[1] || '';
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

// Words that say nothing about which channel it is (quality, extra tags).
const NOISE = new Set(['hd', 'fhd', 'uhd', 'sd', '4k', '8k', 'hevc', 'h265', 'h264', 'backup', 'raw', '50fps', '60fps', 'tv', 'sweden', 'sverige']);

/** The country in a channel id: "viasatmotor.se" → "se", "[VIASMHD].V.Sport.Motor.HD.se" → "se". */
export const countryOf = (id) => ((/\.([a-z]{2,3})$/i.exec(id) || [])[1] || '').toLowerCase();

/** Normalised channel name for matching: "V Sport Motor FHD SE [Viaplay]" → "vsportmotor". */
export function normName(name, country = '') {
  const words = decode(name)
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9åäöæøüß]+/g, ' ')
    .split(' ')
    .filter((w) => w && !NOISE.has(w));
  // A country code at the end of the name ("… SE") is not part of the channel's name.
  while (words.length > 1 && (words[words.length - 1] === country || /^(se|no|dk|fi|uk|de|nl|pl|us|fr|es|it)$/.test(words[words.length - 1]))) words.pop();
  return words.join('');
}

/** Channels (id → display names) in an XMLTV file. */
function channels(xml) {
  const out = new Map();
  const re = /<channel\b([^>]*)>([\s\S]*?)<\/channel>/g;
  let m;
  while ((m = re.exec(xml))) {
    const id = decode(attr(m[1], 'id'));
    const names = [...m[2].matchAll(/<display-name[^>]*>([^<]*)</g)].map((x) => x[1].replace(/^\s*\[[^\]]*\]\s*/, ''));
    if (!id) continue;
    if (!out.has(id)) out.set(id, new Set());
    for (const n of names) out.get(id).add(n);
  }
  return out;
}

/**
 * @param primaryUrl   the primary guide (your provider's XMLTV)
 * @param fallbackUrls fallback sources; those that cannot be fetched are skipped
 */
export async function buildMergedEpg({ primaryUrl, fallbackUrls = [], extraMap = {}, log = console.log }) {
  const t0 = Date.now();
  const [primary, ...fallbackTexts] = await Promise.all([
    fetchText(primaryUrl),
    ...fallbackUrls.map((u) => fetchText(u).catch((e) => { log(`[epg] skipping a fallback source (${e.message})`); return ''; })),
  ]);
  const fallback = fallbackTexts.filter(Boolean).join('\n');

  // ---- match channels: primary id → fallback id (only within the same country)
  const pCh = channels(fallback ? primary : '');
  const fCh = channels(fallback);
  const fByName = new Map(); // "se|vsportmotor" → fallback id
  for (const [id, names] of fCh) {
    const cc = countryOf(id);
    for (const n of names) { const k = normName(n, cc); if (k && !fByName.has(`${cc}|${k}`)) fByName.set(`${cc}|${k}`, id); }
  }
  const match = new Map();
  for (const [id, names] of pCh) {
    const cc = countryOf(id);
    if (!cc) continue;
    for (const n of names) {
      const f = fByName.get(`${cc}|${normName(n, cc)}`);
      if (f) { match.set(id, f); break; }
    }
  }
  for (const [p, f] of Object.entries(extraMap)) if (fCh.has(f)) match.set(p, f);
  const byCountry = {};
  for (const id of match.keys()) byCountry[countryOf(id)] = (byCountry[countryOf(id)] || 0) + 1;

  // ---- which times the primary already covers, per channel
  const covered = new Map(); // primary id → [[start, end], …]
  const wanted = new Set(match.keys());
  for (const m of primary.matchAll(/<programme\b([^>]*)>/g)) {
    const ch = decode(attr(m[1], 'channel'));
    if (!wanted.has(ch)) continue;
    const s = xmltvTime(attr(m[1], 'start')), e = xmltvTime(attr(m[1], 'stop'));
    if (!(e > s)) continue;
    if (!covered.has(ch)) covered.set(ch, []);
    covered.get(ch).push([s, e]);
  }

  // ---- fill the gaps with the fallback programmes
  const byFallback = new Map(); // fallback id → [primary ids]
  for (const [p, f] of match) { if (!byFallback.has(f)) byFallback.set(f, []); byFallback.get(f).push(p); }
  const cutoff = Date.now() - 6 * 3600 * 1000;
  const extras = [];
  const filled = new Map(); // primary id → number of programmes added
  for (const m of fallback.matchAll(/<programme\b([^>]*)>[\s\S]*?<\/programme>/g)) {
    const fid = decode(attr(m[1], 'channel'));
    const targets = byFallback.get(fid);
    if (!targets) continue;
    const s = xmltvTime(attr(m[1], 'start')), e = xmltvTime(attr(m[1], 'stop'));
    if (!(e > s) || e < cutoff) continue;
    for (const pid of targets) {
      const iv = covered.get(pid) || [];
      if (iv.some(([a, b]) => s < b && e > a)) continue; // the primary already has something here
      extras.push(m[0].replace(/\bchannel="[^"]*"/, `channel="${pid.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`));
      filled.set(pid, (filled.get(pid) || 0) + 1);
    }
  }

  const end = primary.lastIndexOf('</tv>');
  if (end < 0) throw new Error('The primary guide is incomplete (no </tv>)');
  const xml = primary.slice(0, end) + '\n<!-- Gaps filled from fallback sources by Couchmate -->\n' + extras.join('\n') + '\n</tv>\n';
  const stats = {
    builtAt: new Date().toISOString(),
    seconds: Math.round((Date.now() - t0) / 100) / 10,
    primaryChannels: pCh.size,
    fallbackChannels: fCh.size,
    fallbackSources: fallbackTexts.filter(Boolean).length,
    matchedChannels: match.size,
    matchedByCountry: byCountry,
    filledChannels: filled.size,
    addedProgrammes: extras.length,
    filled: Object.fromEntries([...filled].sort((a, b) => b[1] - a[1])),
    bytes: Buffer.byteLength(xml),
  };
  log(`[epg] merged guide: ${stats.matchedChannels} channels matched, ${stats.addedProgrammes} programmes filled in ${stats.filledChannels} channels (${stats.seconds} s)`);
  return { xml, stats };
}
