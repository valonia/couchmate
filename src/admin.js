// Adminpanelen (/admin) och nedladdningssidan (/download).
// Inloggning med ett eget adminlösenord (inte rummets PIN). Första gången skapas lösenordet,
// och då krävs rummets PIN så att ingen utomstående hinner före.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { logSince, onLog } from './logbuf.js';
import { GROUPS } from './settings.js';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'admin');
const EXAMPLES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugin-examples');
const STATIC = {
  '/admin': ['index.html', 'text/html; charset=utf-8'],
  '/admin/': ['index.html', 'text/html; charset=utf-8'],
  '/admin/admin.js': ['admin.js', 'text/javascript; charset=utf-8'],
  '/admin/admin.css': ['admin.css', 'text/css; charset=utf-8'],
};
const SESSION_MS = 7 * 24 * 3600 * 1000;
const MAX_UPLOAD = 400 * 1024 * 1024; // appar (Windows-zip) kan vara stora
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,120}$/;

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Filen är för stor')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

function hash(password, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(password, salt, 64).toString('hex') };
}

function cookie(req, name) {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : null;
}

const fmtSize = (n) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * @param ctx  allt adminpanelen behöver från servern (rummet, data, inställningar, plugins …)
 */
export function createAdmin(ctx) {
  const { dataDir, settings, plugins } = ctx;
  const authFile = path.join(dataDir, 'admin.json');
  const downloadsDir = path.join(dataDir, 'downloads');
  const metaFile = path.join(downloadsDir, '.descriptions.json');
  fs.mkdirSync(downloadsDir, { recursive: true });
  const sessions = new Map(); // token → utgång
  const attempts = new Map(); // ip → [tider]
  const startedAt = Date.now();

  const readAuth = () => { try { return JSON.parse(fs.readFileSync(authFile, 'utf8')); } catch { return null; } };
  const writeAuth = (password) => fs.writeFileSync(authFile, JSON.stringify(hash(password)));
  const checkPassword = (password) => {
    const a = readAuth();
    if (!a) return false;
    const h = scryptSync(String(password), a.salt, 64);
    return timingSafeEqual(h, Buffer.from(a.hash, 'hex'));
  };
  const tooMany = (ip) => {
    const t = Date.now();
    const list = (attempts.get(ip) || []).filter((x) => t - x < 5 * 60 * 1000);
    attempts.set(ip, list);
    return list.length >= 10;
  };
  const newSession = (res) => {
    const token = randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + SESSION_MS);
    res.setHeader('set-cookie', `cm_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`);
  };
  const loggedIn = (req) => {
    const t = cookie(req, 'cm_admin');
    const exp = t && sessions.get(t);
    if (!exp || exp < Date.now()) { if (t) sessions.delete(t); return false; }
    return true;
  };

  const descriptions = () => { try { return JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { return {}; } };
  const downloadList = () => {
    const desc = descriptions();
    return fs.readdirSync(downloadsDir)
      .filter((f) => !f.startsWith('.'))
      .map((f) => {
        const st = fs.statSync(path.join(downloadsDir, f));
        return { name: f, size: st.size, modified: st.mtimeMs, description: desc[f] || '' };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  };

  // ---------------------------------------------------------------- nedladdningssidan (publik)
  function downloadPage(req, res) {
    const files = downloadList();
    const host = req.headers.host || 'servern';
    const guess = (f) => /\.apk$/i.test(f) ? 'Android TV' : /\.ipa$/i.test(f) ? 'Apple TV' : /windows|\.zip$|\.exe$/i.test(f) ? 'Windows' : 'Fil';
    const rows = files.map((f) => `
      <a class="file" href="/download/${encodeURIComponent(f.name)}" download>
        <span class="kind">${esc(guess(f.name))}</span>
        <span class="name">${esc(f.name)}</span>
        ${f.description ? `<span class="desc">${esc(f.description)}</span>` : ''}
        <span class="size">${fmtSize(f.size)}</span>
      </a>`).join('') || '<p class="empty">Inga filer uppladdade än.</p>';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(`<!doctype html><html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Couchmates – ladda ner</title><link rel="stylesheet" href="/admin/admin.css"></head>
<body class="dl"><main>
<h1><span class="b">Couch</span><span class="a">mates</span></h1>
<p class="lead">Titta på samma sak samtidigt. Ladda ner appen för din enhet och anslut till servern.</p>
<section class="files">${rows}</section>
<section class="howto">
  <h2>Så ansluter du</h2>
  <ol>
    <li><b>Serveradress:</b> <code>http://${esc(host)}</code></li>
    <li><b>PIN-kod:</b> fråga den som har servern.</li>
    <li><b>Namn:</b> det du vill att de andra ska se.</li>
  </ol>
  <h2>Installera</h2>
  <ul>
    <li><b>Windows:</b> packa upp zip-filen och starta <code>Couchmates.exe</code>. Säger Windows "skyddade datorn": välj <i>Mer info → Kör ändå</i>.</li>
    <li><b>Android TV / Google TV:</b> installera APK-filen, t.ex. med appen <i>Downloader</i> eller <i>Send Files to TV</i>.</li>
    <li><b>Apple TV:</b> installeras med <i>tvsign</i> (eller Sideloadly) och ditt Apple-ID.</li>
  </ul>
</section></main></body></html>`);
  }

  function serveDownload(res, name) {
    if (!SAFE_FILE.test(name)) return json(res, 400, { error: 'Ogiltigt filnamn' });
    const file = path.join(downloadsDir, name);
    let st;
    try { st = fs.statSync(file); } catch { return json(res, 404, { error: 'Filen finns inte' }); }
    res.writeHead(200, {
      'content-type': 'application/octet-stream', 'content-length': st.size,
      'content-disposition': `attachment; filename="${name.replace(/"/g, '')}"`,
    });
    fs.createReadStream(file).pipe(res);
  }

  // ---------------------------------------------------------------- admin-API
  async function api(req, res, sub) {
    const method = req.method;
    const ip = req.socket.remoteAddress || '';

    if (sub === '/session' && method === 'GET') return json(res, 200, { setupNeeded: !readAuth(), loggedIn: loggedIn(req) });

    if (sub === '/setup' && method === 'POST') {
      if (readAuth()) return json(res, 409, { error: 'Lösenordet är redan skapat' });
      if (tooMany(ip)) return json(res, 429, { error: 'För många försök – vänta några minuter' });
      const b = JSON.parse((await readBody(req, 10000)).toString() || '{}');
      if (!ctx.pinOk(b.pin)) { attempts.get(ip).push(Date.now()); return json(res, 401, { error: 'Fel PIN-kod' }); }
      if (String(b.password || '').length < 8) return json(res, 400, { error: 'Lösenordet måste vara minst 8 tecken' });
      writeAuth(String(b.password));
      newSession(res);
      console.log('[admin] adminlösenord skapat');
      return json(res, 200, { ok: true });
    }

    if (sub === '/login' && method === 'POST') {
      if (tooMany(ip)) return json(res, 429, { error: 'För många försök – vänta några minuter' });
      const b = JSON.parse((await readBody(req, 10000)).toString() || '{}');
      if (!checkPassword(b.password || '')) { attempts.get(ip).push(Date.now()); return json(res, 401, { error: 'Fel lösenord' }); }
      newSession(res);
      return json(res, 200, { ok: true });
    }

    if (!loggedIn(req)) return json(res, 401, { error: 'Inte inloggad' });

    if (sub === '/logout' && method === 'POST') {
      sessions.delete(cookie(req, 'cm_admin'));
      res.setHeader('set-cookie', 'cm_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      return json(res, 200, { ok: true });
    }
    if (sub === '/password' && method === 'POST') {
      const b = JSON.parse((await readBody(req, 10000)).toString() || '{}');
      if (!checkPassword(b.current || '')) return json(res, 401, { error: 'Nuvarande lösenord stämmer inte' });
      if (String(b.password || '').length < 8) return json(res, 400, { error: 'Lösenordet måste vara minst 8 tecken' });
      writeAuth(String(b.password));
      sessions.clear();
      newSession(res);
      return json(res, 200, { ok: true });
    }

    // ---- översikt
    if (sub === '/overview' && method === 'GET') {
      const mem = process.memoryUsage();
      return json(res, 200, {
        state: ctx.room.state(),
        serverNow: Date.now(),
        members: ctx.room.members(),
        server: {
          uptime: Math.round((Date.now() - startedAt) / 1000), node: process.version, rss: mem.rss,
          host: os.hostname(), load: os.loadavg()[0], dispatcharr: settings.get('xtreamUrl'), streamMode: settings.get('streamMode'),
        },
        counts: { favorites: ctx.favorites.list().length, reminders: ctx.reminders.list().length, history: ctx.history.list().length },
        epg: ctx.epgStatus(),
        cache: ctx.cacheStatus(),
        plugins: plugins.list().map((p) => ({ id: p.id, name: p.name, enabled: p.enabled, error: p.error })),
      });
    }

    // ---- styr rummet
    const roomCmd = /^\/room\/(play|pause|stop|seek|kick)$/.exec(sub);
    if (roomCmd && method === 'POST') {
      const b = JSON.parse((await readBody(req, 10000)).toString() || '{}');
      const c = roomCmd[1];
      if (c === 'seek') ctx.room.seek(Number(b.position) || 0);
      else if (c === 'kick') { if (!ctx.room.kick(String(b.id || ''))) return json(res, 404, { error: 'Hittade inte enheten' }); }
      else ctx.room[c]();
      return json(res, 200, { ok: true });
    }

    // ---- inställningar
    if (sub === '/settings' && method === 'GET') return json(res, 200, { groups: GROUPS, settings: settings.forAdmin() });
    if (sub === '/settings' && method === 'PUT') {
      const b = JSON.parse((await readBody(req, 100000)).toString() || '{}');
      try {
        const changed = settings.update(b);
        if (changed.length) console.log(`[admin] inställningar ändrade: ${changed.join(', ')}`);
        return json(res, 200, { ok: true, changed, settings: settings.forAdmin() });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    // ---- data
    if (sub === '/data' && method === 'GET') {
      return json(res, 200, { reminders: ctx.reminders.list(), favorites: ctx.favorites.list(), history: ctx.history.list() });
    }
    const del = /^\/data\/(reminders|favorites|history)\/(.+)$/.exec(sub);
    if (del && method === 'DELETE') {
      const key = decodeURIComponent(del[2]);
      ctx.removeData(del[1], key);
      return json(res, 200, { ok: true });
    }
    if (sub === '/data/history' && method === 'DELETE') { ctx.removeData('history', null); return json(res, 200, { ok: true }); }

    // ---- tablå
    if (sub === '/epg/rebuild' && method === 'POST') {
      await ctx.rebuildEpg();
      return json(res, 200, ctx.epgStatus());
    }

    // ---- logg
    if (sub === '/logs' && method === 'GET') {
      const since = Number(new URL(req.url, 'http://x').searchParams.get('since')) || 0;
      return json(res, 200, logSince(since));
    }
    if (sub === '/logs/stream' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': ok\n\n');
      const off = onLog((line) => res.write(`data: ${JSON.stringify(line)}\n\n`));
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { off(); clearInterval(ping); });
      return;
    }

    // ---- nedladdningar
    if (sub === '/downloads' && method === 'GET') return json(res, 200, downloadList());
    const dl = /^\/downloads\/(.+)$/.exec(sub);
    if (dl) {
      const name = decodeURIComponent(dl[1]);
      if (!SAFE_FILE.test(name)) return json(res, 400, { error: 'Ogiltigt filnamn (bokstäver, siffror, punkt, bindestreck)' });
      const file = path.join(downloadsDir, name);
      if (method === 'PUT') {
        const body = await readBody(req, MAX_UPLOAD);
        fs.writeFileSync(file, body);
        console.log(`[admin] laddade upp ${name} (${fmtSize(body.length)})`);
        return json(res, 200, downloadList());
      }
      if (method === 'PATCH') {
        const b = JSON.parse((await readBody(req, 10000)).toString() || '{}');
        const d = descriptions();
        d[name] = String(b.description || '').slice(0, 300);
        fs.writeFileSync(metaFile, JSON.stringify(d, null, 1));
        return json(res, 200, downloadList());
      }
      if (method === 'DELETE') {
        try { fs.unlinkSync(file); } catch { /* redan borta */ }
        return json(res, 200, downloadList());
      }
    }

    // ---- plugins
    if (sub === '/plugins' && method === 'GET') {
      const examples = fs.existsSync(EXAMPLES_DIR) ? fs.readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith('.mjs')) : [];
      return json(res, 200, { plugins: plugins.list(), examples });
    }
    if (sub === '/plugins/upload' && method === 'PUT') {
      const name = new URL(req.url, 'http://x').searchParams.get('name') || '';
      const code = (await readBody(req, 2 * 1024 * 1024)).toString('utf8');
      try {
        const p = await plugins.install(name, code);
        console.log(`[admin] plugin installerat: ${p.id}`);
        return json(res, 200, { plugins: plugins.list() });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (sub === '/plugins/example' && method === 'POST') {
      const b = JSON.parse((await readBody(req, 10000)).toString() || '{}');
      const f = path.basename(String(b.file || ''));
      if (!f.endsWith('.mjs') || !fs.existsSync(path.join(EXAMPLES_DIR, f))) return json(res, 404, { error: 'Exemplet finns inte' });
      await plugins.install(f, fs.readFileSync(path.join(EXAMPLES_DIR, f), 'utf8'));
      return json(res, 200, { plugins: plugins.list() });
    }
    const pl = /^\/plugins\/([a-z0-9_-]+)(\/enable|\/disable|\/settings)?$/.exec(sub);
    if (pl) {
      try {
        if (pl[2] === '/enable' && method === 'POST') await plugins.setEnabled(pl[1], true);
        else if (pl[2] === '/disable' && method === 'POST') await plugins.setEnabled(pl[1], false);
        else if (pl[2] === '/settings' && method === 'PUT') await plugins.setSettings(pl[1], JSON.parse((await readBody(req, 100000)).toString() || '{}'));
        else if (!pl[2] && method === 'DELETE') plugins.remove(pl[1]);
        else return json(res, 404, { error: 'Okänt anrop' });
        return json(res, 200, { plugins: plugins.list() });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    return json(res, 404, { error: 'Okänt anrop' });
  }

  /** Returnerar true om anropet hanterades här. */
  async function handle(req, res, pathname) {
    if (STATIC[pathname] && req.method === 'GET') {
      const [file, type] = STATIC[pathname];
      try {
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
        res.end(fs.readFileSync(path.join(UI_DIR, file)));
      } catch {
        json(res, 404, { error: 'Adminpanelen saknas' });
      }
      return true;
    }
    if (pathname === '/download' || pathname === '/download/') { downloadPage(req, res); return true; }
    if (pathname.startsWith('/download/') && req.method === 'GET') { serveDownload(res, decodeURIComponent(pathname.slice(10))); return true; }
    if (pathname.startsWith('/admin/api/')) {
      try { await api(req, res, pathname.slice(10)); } catch (e) { json(res, 500, { error: e.message }); }
      return true;
    }
    return false;
  }

  return { handle };
}
