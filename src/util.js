// Small helpers shared by the server modules.

import fs from 'node:fs';
import path from 'node:path';

export const str = (v) => (v === null || v === undefined ? '' : String(v));
/** Single-line text without control characters, trimmed and capped. */
export const clean = (v, max) => str(v).replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
export const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Item ids inside a plugin: letters, digits and a few separators. */
export const ITEM_ID = /^[A-Za-z0-9_.:@~-]{1,160}$/;

export function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Request body is too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req, limit = 100_000) {
  const raw = (await readBody(req, limit)).toString();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error('Invalid JSON'); }
}

/** A JSON file on disk that is loaded once and written (debounced, atomically) on change. */
export class JsonFile {
  constructor(file, fallback, { delay = 500, log = console.log } = {}) {
    this.file = file;
    this.delay = delay;
    this.log = log;
    this.timer = null;
    try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.data = fallback; }
    if (this.data === null || typeof this.data !== typeof fallback || Array.isArray(this.data) !== Array.isArray(fallback)) this.data = fallback;
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.delay);
    this.timer.unref?.();
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.log(`[data] could not save ${path.basename(this.file)}: ${e.message}`);
    }
  }
}

/** Runs fn with a timeout; rejects with `message` if it takes too long. */
export async function withTimeout(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
