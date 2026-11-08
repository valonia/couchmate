// Translation of what the apps show.
//
// Plugins and apps write everything in English. Text that may be translated is marked:
//   - by plugins with api.t('Live TV')  →  { "$t": "Live TV" }   (plain strings are never translated,
//     e.g. plugin names, channel names, programme titles)
//   - by the apps by sending their own UI strings to POST /api/i18n
// Before a response goes to an app, localize() swaps every marker for the text in that device's language.
// Translations are cached in data/translations.json per language, so each text is translated once and
// then shared by every device. Until a translation is ready, the English text is used.

import { JsonFile } from './util.js';

export const T = '$t';

const LANG = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;

/** Fills {name} placeholders. */
const fillVars = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s);

export class Translator {
  /**
   * @param engine  async (texts: string[], lang) => string[]  – null means "English only"
   */
  constructor(file, { engine = null, enabled = () => true, log = console.log } = {}) {
    this.store = new JsonFile(file, {}, { delay: 3000 });
    this.engine = engine;
    this.enabled = enabled;
    this.log = log;
    this.queue = new Map(); // lang → Set of texts waiting
    this.running = false;
  }

  /** "sv-SE" → "sv". English (or anything unknown) means no translation. */
  static normalize(lang) {
    const l = String(lang || '').trim();
    if (!LANG.test(l)) return null;
    const base = l.split('-')[0].toLowerCase();
    return base === 'en' ? null : base;
  }

  cached(text, lang) { return this.store.data[lang]?.[text]; }

  /** The translation if it is ready; otherwise English now and a translation in the background. */
  translate(text, lang) {
    if (!lang || !text || !this.engine || !this.enabled()) return text;
    const hit = this.cached(text, lang);
    if (hit !== undefined) return hit;
    this.enqueue(text, lang);
    return text;
  }

  enqueue(text, lang) {
    if (!this.queue.has(lang)) this.queue.set(lang, new Set());
    this.queue.get(lang).add(text);
    if (!this.running) this.drain();
  }

  async drain() {
    this.running = true;
    try {
      for (const [lang, set] of this.queue) {
        const texts = [...set];
        this.queue.delete(lang);
        try {
          const out = await this.engine(texts, lang);
          const dict = (this.store.data[lang] ||= {});
          texts.forEach((t, i) => { if (typeof out[i] === 'string' && out[i].trim()) dict[t] = out[i]; });
          this.store.save();
        } catch (e) {
          this.log(`[translate] ${lang}: ${e.message}`);
        }
      }
    } finally {
      this.running = false;
      if (this.queue.size) this.drain();
    }
  }

  /** Waits up to `ms` for pending translations, so a first visit can already be translated. */
  async settle(ms) {
    const until = Date.now() + ms;
    while ((this.running || this.queue.size) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  }

  /** Swaps every { $t } marker in a response for text in `lang` (deep copy). */
  localize(value, lang) {
    if (Array.isArray(value)) return value.map((v) => this.localize(v, lang));
    if (value && typeof value === 'object') {
      if (typeof value[T] === 'string') return fillVars(this.translate(value[T], lang), value.vars);
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.localize(v, lang);
      return out;
    }
    return value;
  }

  /** Does the response contain text that still has no translation? */
  pending(value, lang) {
    if (!lang || !this.engine || !this.enabled()) return false;
    if (Array.isArray(value)) return value.some((v) => this.pending(v, lang));
    if (value && typeof value === 'object') {
      if (typeof value[T] === 'string') return this.cached(value[T], lang) === undefined;
      return Object.values(value).some((v) => this.pending(v, lang));
    }
    return false;
  }

  /** For the apps' own UI strings: { text: translation } for everything already translated. */
  strings(texts, lang) {
    const out = {};
    for (const t of texts) out[t] = this.translate(t, lang);
    return out;
  }

  flush() { this.store.flush(); }
}
