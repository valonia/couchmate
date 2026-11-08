// Sammanslagen tablå (XMLTV) med prioritet:
//   1. originalet (leverantörens tablå) används alltid när det finns program,
//   2. reservkällan fyller BARA luckorna – tider där originalet saknar program för en kanal.
// Originalets kanal-id behålls, så alla kopplingar i Dispatcharr fortsätter att fungera.
// Kanaler matchas mellan källorna på namn ("V Sport Motor FHD SE" ≈ "[VIASMHD] V Sport Motor HD"),
// och bara inom samma land (kanal-id:ts ändelse, t.ex. ".se" eller ".no"), så att t.ex. svenska och
// norska "Eurosport 1" aldrig blandas ihop. Det kan finnas flera reservkällor (en per land).

import zlib from 'node:zlib';
import { promisify } from 'node:util';

const gunzip = promisify(zlib.gunzip);

async function fetchText(url, timeoutMs = 180000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'Couchmates-EPG/1.0' } });
  if (!r.ok) throw new Error(`${new URL(url).host} svarade ${r.status}`);
  let buf = Buffer.from(await r.arrayBuffer());
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = await gunzip(buf);
  return buf.toString('utf8');
}

/** "20261108054400 +0100" → millisekunder (UTC). */
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

// Ord som inte säger något om vilken kanal det är (kvalitet, extra taggar).
const NOISE = new Set(['hd', 'fhd', 'uhd', 'sd', '4k', '8k', 'hevc', 'h265', 'h264', 'backup', 'raw', '50fps', '60fps', 'tv', 'sweden', 'sverige']);

/** Landet i ett kanal-id: "viasatmotor.se" → "se", "[VIASMHD].V.Sport.Motor.HD.se" → "se". */
export const countryOf = (id) => ((/\.([a-z]{2,3})$/i.exec(id) || [])[1] || '').toLowerCase();

/** Normaliserat kanalnamn för matchning: "V Sport Motor FHD SE [Viaplay]" → "vsportmotor". */
export function normName(name, country = '') {
  const words = decode(name)
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9åäöæøüß]+/g, ' ')
    .split(' ')
    .filter((w) => w && !NOISE.has(w));
  // Landskoden sist i namnet ("… SE") är inte en del av kanalens namn.
  while (words.length > 1 && (words[words.length - 1] === country || /^(se|no|dk|fi|uk|de|nl|pl|us|fr|es|it)$/.test(words[words.length - 1]))) words.pop();
  return words.join('');
}

/** Kanaler (id → visningsnamn) i en XMLTV-fil. */
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
 * @param primaryUrl   originalet (leverantörens XMLTV)
 * @param fallbackUrls reservkällor; de som inte går att hämta hoppas över
 */
export async function buildMergedEpg({ primaryUrl, fallbackUrls = [], extraMap = {}, log = console.log }) {
  const t0 = Date.now();
  const [primary, ...fallbackTexts] = await Promise.all([
    fetchText(primaryUrl),
    ...fallbackUrls.map((u) => fetchText(u).catch((e) => { log(`[epg] reservkälla hoppas över (${e.message})`); return ''; })),
  ]);
  const fallback = fallbackTexts.filter(Boolean).join('\n');

  // ---- matcha kanaler: originalets id → reservkällans id (bara inom samma land)
  const pCh = channels(fallback ? primary : '');
  const fCh = channels(fallback);
  const fByName = new Map(); // "se|vsportmotor" → reservid
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

  // ---- vilka tider originalet redan täcker, per kanal
  const covered = new Map(); // primärt id → [[start, slut], …]
  const wanted = new Set(match.keys());
  for (const m of primary.matchAll(/<programme\b([^>]*)>/g)) {
    const ch = decode(attr(m[1], 'channel'));
    if (!wanted.has(ch)) continue;
    const s = xmltvTime(attr(m[1], 'start')), e = xmltvTime(attr(m[1], 'stop'));
    if (!(e > s)) continue;
    if (!covered.has(ch)) covered.set(ch, []);
    covered.get(ch).push([s, e]);
  }

  // ---- fyll luckorna med reservkällans program
  const byFallback = new Map(); // reservid → [primära id]
  for (const [p, f] of match) { if (!byFallback.has(f)) byFallback.set(f, []); byFallback.get(f).push(p); }
  const cutoff = Date.now() - 6 * 3600 * 1000;
  const extras = [];
  const filled = new Map(); // primärt id → antal tillagda program
  for (const m of fallback.matchAll(/<programme\b([^>]*)>[\s\S]*?<\/programme>/g)) {
    const fid = decode(attr(m[1], 'channel'));
    const targets = byFallback.get(fid);
    if (!targets) continue;
    const s = xmltvTime(attr(m[1], 'start')), e = xmltvTime(attr(m[1], 'stop'));
    if (!(e > s) || e < cutoff) continue;
    for (const pid of targets) {
      const iv = covered.get(pid) || [];
      if (iv.some(([a, b]) => s < b && e > a)) continue; // originalet har redan något här
      extras.push(m[0].replace(/\bchannel="[^"]*"/, `channel="${pid.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`));
      filled.set(pid, (filled.get(pid) || 0) + 1);
    }
  }

  const end = primary.lastIndexOf('</tv>');
  if (end < 0) throw new Error('Originaltablån är ofullständig (saknar </tv>)');
  const xml = primary.slice(0, end) + '\n<!-- Luckor ifyllda från reservkällan av Couchmates -->\n' + extras.join('\n') + '\n</tv>\n';
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
  log(`[epg] sammanslagen tablå: ${stats.matchedChannels} kanaler matchade, ${stats.addedProgrammes} program ifyllda i ${stats.filledChannels} kanaler (${stats.seconds} s)`);
  return { xml, stats };
}
