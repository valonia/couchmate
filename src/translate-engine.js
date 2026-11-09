// The translation engine: open Opus-MT models run on this server with Transformers.js.
// Free, no account, nothing leaves the server. A language's model (≈ 75–300 MB) is downloaded the first
// time a device asks for that language and kept in data/models, so it is only downloaded once.
//
// English → a language with its own model (sv, da, de, es, fi, fr, …) uses that model. Other languages
// use the multilingual model (en-mul) with a ">>xxx<<" target token – rougher, but better than English.

import path from 'node:path';

/** Languages with their own English → X model. */
const DIRECT = new Set(['af', 'ar', 'cs', 'da', 'de', 'es', 'fi', 'fr', 'hi', 'hu', 'id', 'it', 'nl', 'ro', 'ru', 'sv', 'uk', 'vi', 'xh', 'zh']);

/** ISO 639-1 → the target token the multilingual model expects. */
const MUL = {
  no: 'nob', nb: 'nob', nn: 'nno', pl: 'pol', pt: 'por', el: 'ell', tr: 'tur', ko: 'kor', ja: 'jpn', he: 'heb',
  th: 'tha', bg: 'bul', hr: 'hrv', sr: 'srp_Cyrl', sk: 'slk', sl: 'slv', et: 'est', lv: 'lav', lt: 'lit', is: 'isl',
  ca: 'cat', gl: 'glg', eu: 'eus', ga: 'gle', cy: 'cym', sq: 'sqi', mk: 'mkd', be: 'bel', ka: 'kat', hy: 'hye',
  fa: 'pes', ur: 'urd', bn: 'ben', ta: 'tam', te: 'tel', ms: 'zsm_Latn', tl: 'tgl', sw: 'swh',
};

/**
 * Builds the engine for the Translator: async (texts, lang) => translations (same order).
 * Returns null when Transformers.js is not installed (the server then simply shows English).
 */
export async function createEngine({ dataDir, log = console.log }) {
  let transformers;
  try {
    transformers = await import('@huggingface/transformers');
  } catch {
    log('[translate] Transformers.js is not installed – the apps are shown in English');
    return null;
  }
  transformers.env.cacheDir = path.join(dataDir, 'models');
  transformers.env.allowLocalModels = false;

  const loading = new Map(); // model id → Promise<pipeline>
  const failed = new Set(); // model ids that could not be loaded

  function modelFor(lang) {
    if (DIRECT.has(lang)) return { id: `Xenova/opus-mt-en-${lang}`, prefix: '' };
    if (MUL[lang]) return { id: 'Xenova/opus-mt-en-mul', prefix: `>>${MUL[lang]}<< ` };
    return null;
  }

  function pipelineFor(id) {
    if (!loading.has(id)) {
      log(`[translate] loading ${id} (downloaded the first time, then kept on the server)`);
      const t0 = Date.now();
      loading.set(id, transformers.pipeline('translation', id, { dtype: 'q8' }).then((p) => {
        log(`[translate] ${id} ready (${Math.round((Date.now() - t0) / 1000)} s)`);
        return p;
      }).catch((e) => {
        failed.add(id);
        loading.delete(id);
        throw e;
      }));
    }
    return loading.get(id);
  }

  async function translate(texts, lang) {
    const model = modelFor(lang);
    // No model for this language: keep the English (it is cached, so it is not asked for again).
    if (!model || failed.has(model.id)) return texts;
    const translator = await pipelineFor(model.id);
    const out = [];
    for (const text of texts) out.push(await translateParts(translator, model.prefix, text));
    return out;
  }
  /** Starts loading a language's model ahead of time (when a device connects with that language). */
  translate.prepare = (lang) => {
    const model = lang && modelFor(lang);
    if (model && !failed.has(model.id)) pipelineFor(model.id).catch((e) => log(`[translate] ${model.id}: ${e.message}`));
  };
  return translate;
}

/** Hints like "OK  –  watch   ·   Hold OK  –  favorite" are translated part by part, keeping the separators. */
async function translateParts(translator, prefix, text) {
  // Several sentences: one at a time (the model sometimes drops a short first sentence otherwise).
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z])/);
  if (sentences.length > 1) {
    const out = [];
    for (const s of sentences) out.push(await translateOne(translator, prefix, s));
    return out.join(' ');
  }
  const parts = text.split(/(\s{2,}[·–]\s{2,})/);
  if (parts.length === 1) return translateOne(translator, prefix, text);
  const out = [];
  for (const p of parts) out.push(/^\s{2,}[·–]\s{2,}$/.test(p) ? p : await translateOne(translator, prefix, p));
  return out.join('');
}

/**
 * Translates one UI text. Placeholders like {n} are swapped for numbers the model leaves alone, and text in
 * CAPITALS is translated in normal case and put back in capitals (models handle "ON NOW" badly).
 */
// Placeholders become something the model treats naturally: numbers for counts, first names for everything else
// ("{name} paused the video" → "Anna paused the video" → "Anna gjorde en paus i videon" → "{name} gjorde …").
const NUMERIC = new Set(['n', 'm', 'h', 's', 'count', 'code', 'version', 'number']);
const PEOPLE = ['Anna', 'Erik', 'Maria', 'Johan', 'Sara', 'Lars'];

async function translateOne(translator, prefix, text) {
  const names = [];
  const tokens = [];
  let src = text.replace(/\{(\w+)\}/g, (_, name) => {
    const token = NUMERIC.has(name) ? String(7301 + tokens.length) : PEOPLE[tokens.length % PEOPLE.length];
    names.push(name);
    tokens.push(token);
    return token;
  });
  const upper = /[A-Z]/.test(src) && src === src.toUpperCase();
  if (upper) src = src.charAt(0) + src.slice(1).toLowerCase();
  // Keep leading/trailing spaces and symbols such as "→" or "·" out of the model's way.
  const lead = /^[\s→·•–\-★☆▶◀▲▼‹›]*/.exec(src)[0];
  const trail = /[\s.…:]*$/.exec(src.slice(lead.length))[0];
  const core = src.slice(lead.length, src.length - trail.length);
  if (!/[A-Za-z]/.test(core)) return text;
  // Short texts (menu entries, buttons) get context, otherwise e.g. "History" can come back as "Background".
  // "Menu item: History" → "Menyalternativ: Historik" – the part after the colon is kept.
  const short = core.split(/\s+/).length <= 3 && !/[.!?:]/.test(core);
  let t;
  if (short) {
    const [res] = await translator(`${prefix}Menu item: ${core}`, { max_new_tokens: 64 });
    const r = String(res?.translation_text ?? '');
    const i = r.indexOf(':');
    if (i > 0 && r.slice(i + 1).trim()) t = r.slice(i + 1).trim().replace(/^["“”«»]|["“”«»]$/g, '');
  }
  if (!t) {
    const [res] = await translator(prefix + core, { max_new_tokens: 256 });
    t = String(res?.translation_text ?? core).trim();
  }
  if (!t) return text;
  // The model often adds its own full stop; keep the original's ending instead.
  if (!/[.!?…]$/.test(core)) t = t.replace(/[.!?]+$/, '');
  t = lead + t.replace(/[.…]+$/, (m) => (trail.trim() ? '' : m)) + (trail.trim() ? trail.trim() : trail);
  if (upper) t = t.toUpperCase();
  names.forEach((name, i) => { t = t.split(upper ? tokens[i].toUpperCase() : tokens[i]).join(`{${name}}`); });
  // A placeholder the model dropped, or digits that were not in the English (e.g. "/50"): keep the English.
  if (names.some((name) => !t.includes(`{${name}}`))) return text;
  const digits = (x) => (x.replace(/\{\w+\}/g, '').match(/\d+/g) || []).join(',');
  if (digits(t) && digits(t) !== digits(text)) return text;
  // Keep the English's first letter case ("hide chat" → "dölj chatt", not "Dölj chatt").
  const first = text.trimStart().charAt(0);
  if (first && first === first.toLowerCase() && first !== first.toUpperCase()) {
    t = t.replace(/^(\s*)(\S)/, (_, sp, c) => sp + c.toLowerCase());
  }
  return t;
}
