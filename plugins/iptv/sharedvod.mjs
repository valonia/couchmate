// Shared on-demand cache: fetches a movie/an episode over ONE connection to Dispatcharr
// and hands it out to every viewer. What has been downloaded is kept in a temporary file,
// so everyone (who watches at the same place anyway) reads the same data.

import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const CHUNK = 256 * 1024;

function writeAsync(res, buf) {
  return new Promise((resolve) => {
    if (res.write(buf)) return resolve(true);
    const done = (ok) => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      resolve(ok);
    };
    const onDrain = () => done(true);
    const onClose = () => done(false);
    res.once('drain', onDrain);
    res.once('close', onClose);
  });
}

export class SharedVod extends EventEmitter {
  constructor(key, url, dir, { lookahead = 16 * 1024 * 1024, log = console.log } = {}) {
    super();
    this.setMaxListeners(0);
    this.key = key;
    this.url = url;
    this.lookahead = lookahead;
    this.log = log;
    this.file = path.join(dir, key.replace(/[^A-Za-z0-9_-]/g, '_') + '.part');
    this.ranges = []; // downloaded ranges [start, end)
    this.size = null;
    this.type = 'application/octet-stream';
    this.dl = null; // active download { ac, pos, finished }
    this.lastRepoint = 0;
    this.noRange = false;
    this.unusable = false;
    this.failed = null;
    this.complete = false;
    this.closed = false;
    this.fh = null;
    this.opened = fsp.open(this.file, 'w+').then((fh) => { this.fh = fh; });
  }

  // ------------------------------------------------------------ ranges

  addRange(s, e) {
    const out = [];
    let placed = false;
    for (const r of this.ranges) {
      if (r[1] < s) out.push(r);
      else if (r[0] > e) {
        if (!placed) { out.push([s, e]); placed = true; }
        out.push(r);
      } else {
        s = Math.min(s, r[0]);
        e = Math.max(e, r[1]);
      }
    }
    if (!placed) out.push([s, e]);
    this.ranges = out;
  }

  /** The (exclusive) end of the downloaded range that contains pos, otherwise -1. */
  availableEnd(pos) {
    for (const [s, e] of this.ranges) {
      if (s <= pos && pos < e) return e;
      if (s > pos) break;
    }
    return -1;
  }

  nextMissing(from) {
    let p = from;
    for (const [s, e] of this.ranges) {
      if (e <= p) continue;
      if (s > p) break;
      p = e;
    }
    return this.size == null || p < this.size ? p : null;
  }

  downloadedBytes() {
    return this.ranges.reduce((n, [s, e]) => n + (e - s), 0);
  }

  // ------------------------------------------------------------ download

  startDownload(pos) {
    if (this.closed) return;
    const prev = this.dl;
    prev?.ac.abort();
    const dl = { ac: new AbortController(), pos, sockets: [] };
    this.dl = dl;
    this.lastRepoint = Date.now();
    dl.finished = (async () => {
      // Wait until the previous connection really is closed – never two at once to the provider.
      if (prev) {
        await prev.finished;
        await Promise.all(prev.sockets);
        await new Promise((r) => setTimeout(r, 250));
      }
      if (dl.ac.signal.aborted) return;
      await this.opened;
      await this.run(dl);
    })().catch((e) => {
      if (!dl.ac.signal.aborted) this.onError(dl, e);
    });
  }

  /** Opens a connection (follows redirects). Every socket is registered so we can wait for it to close. */
  async open(dl) {
    const headers = { 'user-agent': 'Couchmate' };
    if (dl.pos > 0) headers.range = `bytes=${dl.pos}-`;
    let url = new URL(this.url);
    for (let hops = 0; hops < 5; hops++) {
      const res = await new Promise((resolve, reject) => {
        const mod = url.protocol === 'https:' ? https : http;
        const req = mod.get(url, { headers, agent: false });
        dl.sockets.push(new Promise((r) => req.on('close', r)));
        const kill = () => req.destroy();
        dl.ac.signal.addEventListener('abort', kill, { once: true });
        req.on('close', () => dl.ac.signal.removeEventListener('abort', kill));
        req.on('response', resolve);
        req.on('error', reject);
        if (dl.ac.signal.aborted) kill();
      });
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        res.destroy();
        url = new URL(res.headers.location, url);
        continue;
      }
      return res;
    }
    throw new Error('Too many redirects');
  }

  async run(dl) {
    const r = await this.open(dl);
    if (r.statusCode >= 400) {
      r.destroy();
      throw Object.assign(new Error(`Dispatcharr answered ${r.statusCode}`), { status: r.statusCode });
    }

    if (this.size == null) {
      const cr = r.headers['content-range'];
      const m = cr && /\/(\d+)\s*$/.exec(cr);
      const len = Number(r.headers['content-length']) || 0;
      const size = m ? Number(m[1]) : r.statusCode === 200 && len ? len : 0;
      if (!size) {
        // Unknown size – cannot be cached, let the caller proxy as usual.
        this.unusable = true;
        this.emit('meta');
        dl.ac.abort();
        return;
      }
      this.size = size;
      this.type = r.headers['content-type'] || this.type;
      this.emit('meta');
    }
    if (dl.pos > 0 && r.statusCode === 200) {
      // The server ignores Range – we have to take everything from the start.
      this.noRange = true;
      dl.pos = 0;
    }

    let offset = dl.pos;
    for await (const chunk of r) {
      if (dl.ac.signal.aborted || this.closed) return;
      await this.fh.write(chunk, 0, chunk.length, offset);
      this.addRange(offset, offset + chunk.length);
      offset += chunk.length;
      dl.pos = offset;
      this.emit('data');
      if (!this.noRange && this.availableEnd(offset) > offset) {
        // We already have the next part – jump to the next gap.
        dl.ac.abort();
        if (this.dl === dl) this.continueOrFinish(offset);
        return;
      }
    }
    if (this.dl === dl) this.continueOrFinish(offset);
  }

  continueOrFinish(from) {
    const next = this.nextMissing(from) ?? this.nextMissing(0);
    if (next == null) {
      this.dl = null;
      this.complete = true;
      this.log(`[vod] ${this.key} fully downloaded (${(this.size / 1048576).toFixed(0)} MB)`);
    } else {
      this.startDownload(next);
    }
  }

  onError(dl, e) {
    if (this.dl !== dl || this.closed) return;
    if (this.size == null) {
      this.failed = e;
      this.dl = null;
      this.emit('meta');
      return;
    }
    this.log(`[vod] ${this.key}: ${e.message} – trying again`);
    setTimeout(() => {
      if (this.dl === dl && !this.closed) this.startDownload(this.nextMissing(dl.pos) ?? this.nextMissing(0) ?? 0);
    }, 2000);
  }

  /** A viewer needs byte pos – make sure the download gets there. */
  want(pos) {
    if (this.closed || this.complete || this.unusable || this.failed) return;
    if (this.size != null && pos >= this.size) return;
    if (this.availableEnd(pos) > pos) return;
    const dl = this.dl;
    if (dl) {
      if (this.noRange) return;
      if (pos >= dl.pos && pos <= dl.pos + this.lookahead) return; // coming soon, wait
      if (Date.now() - this.lastRepoint < 1000) return; // avoid jumping back and forth
    }
    this.startDownload(pos);
  }

  waitMeta() {
    if (this.size != null || this.unusable || this.failed) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, 20000);
      this.once('meta', () => { clearTimeout(t); resolve(); });
    });
  }

  waitData(ms) {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); this.off('data', done); resolve(); };
      const t = setTimeout(done, ms);
      this.once('data', done);
    });
  }

  // ------------------------------------------------------------ serving

  /** Answers an HTTP request. Returns false if the cache cannot be used (the caller then proxies). */
  async serve(req, res) {
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
    let start = range && range[1] !== '' ? Number(range[1]) : 0;
    const suffix = range && range[1] === '' && range[2] !== '' ? Number(range[2]) : null;

    this.want(suffix == null ? start : 0);
    await this.waitMeta();
    if (this.size == null) return false;
    await this.opened;

    const size = this.size;
    if (suffix != null) {
      start = Math.max(0, size - suffix);
      this.want(start);
    }
    if (start >= size) {
      res.writeHead(416, { 'content-range': `bytes */${size}` });
      res.end();
      return true;
    }
    const end = range && range[1] !== '' && range[2] !== '' ? Math.min(Number(range[2]), size - 1) : size - 1;
    const headers = { 'content-type': this.type, 'accept-ranges': 'bytes', 'content-length': String(end - start + 1) };
    if (range) headers['content-range'] = `bytes ${start}-${end}/${size}`;
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }

    let gone = false;
    res.on('close', () => { gone = true; });
    let pos = start;
    try {
      while (pos <= end && !gone && !this.closed) {
        const avail = this.availableEnd(pos);
        if (avail > pos) {
          const n = Math.min(avail, end + 1, pos + CHUNK) - pos;
          const buf = Buffer.allocUnsafe(n);
          const { bytesRead } = await this.fh.read(buf, 0, n, pos);
          if (!bytesRead) break;
          if (!(await writeAsync(res, buf.subarray(0, bytesRead)))) break;
          pos += bytesRead;
        } else {
          this.want(pos);
          await this.waitData(1000);
        }
      }
    } catch {
      // the file was closed (media changed) or the client went away
    }
    if (pos > end) res.end();
    else res.destroy();
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.dl?.ac.abort();
    this.emit('data');
    this.emit('meta');
    // Give ongoing reads a moment to finish before the file is removed.
    setTimeout(async () => {
      await this.opened.catch(() => {});
      await this.fh?.close().catch(() => {});
      await fsp.rm(this.file, { force: true }).catch(() => {});
    }, 3000);
  }
}
