// The admin panel (/admin) and the download page (/download).
// The very first time, whoever opens /admin creates the admin password. After that the panel needs it.
// The PIN code the apps use is set in the panel.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { logSince, onLog } from './logbuf.js';
import { GROUPS } from './settings.js';
import { json, readBody, readJson } from './util.js';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'admin');
const STATIC = {
  '/admin': ['index.html', 'text/html; charset=utf-8'],
  '/admin/': ['index.html', 'text/html; charset=utf-8'],
  '/admin/admin.js': ['admin.js', 'text/javascript; charset=utf-8'],
  '/admin/admin.css': ['admin.css', 'text/css; charset=utf-8'],
};
const SESSION_MS = 7 * 24 * 3600 * 1000;
const MAX_UPLOAD = 400 * 1024 * 1024; // app files can be large
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,120}$/;

const hash = (password, salt = randomBytes(16).toString('hex')) => ({ salt, hash: scryptSync(password, salt, 64).toString('hex') });
const cookie = (req, name) => {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : null;
};
const fmtSize = (n) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function createAdmin(ctx) {
  const { dataDir, settings, plugins, room, roomApi } = ctx;
  const authFile = path.join(dataDir, 'admin.json');
  const downloadsDir = path.join(dataDir, 'downloads');
  const metaFile = path.join(downloadsDir, '.descriptions.json');
  fs.mkdirSync(downloadsDir, { recursive: true });
  const sessions = new Map(); // token → expiry
  const attempts = new Map(); // ip → [times]
  const startedAt = Date.now();

  const readAuth = () => { try { return JSON.parse(fs.readFileSync(authFile, 'utf8')); } catch { return null; } };
  const writeAuth = (password) => fs.writeFileSync(authFile, JSON.stringify(hash(password)));
  const checkPassword = (password) => {
    const a = readAuth();
    if (!a) return false;
    return timingSafeEqual(scryptSync(String(password), a.salt, 64), Buffer.from(a.hash, 'hex'));
  };
  const tooMany = (ip) => {
    const t = Date.now();
    const list = (attempts.get(ip) || []).filter((x) => t - x < 5 * 60 * 1000);
    attempts.set(ip, list);
    return list.length >= 10;
  };
  const failed = (ip) => attempts.get(ip)?.push(Date.now());
  const newSession = (res) => {
    const token = randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + SESSION_MS);
    res.setHeader('set-cookie', `cm_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`);
  };
  const isAdmin = (req) => {
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

  // ---------------------------------------------------------------- download page (public)
  function downloadPage(req, res) {
    const files = downloadList();
    const host = req.headers.host || 'this-server';
    const name = settings.get('serverName') || 'Couchmate';
    const guess = (f) => (/\.apk$/i.test(f) ? 'Android TV' : /\.ipa$/i.test(f) ? 'Apple TV' : /windows|\.zip$|\.exe$|\.msix$/i.test(f) ? 'Windows' : 'File');
    const rows = files.map((f) => `
      <a class="file" href="/download/${encodeURIComponent(f.name)}" download>
        <span class="kind">${esc(guess(f.name))}</span>
        <span class="name">${esc(f.name)}</span>
        ${f.description ? `<span class="desc">${esc(f.description)}</span>` : ''}
        <span class="size">${fmtSize(f.size)}</span>
      </a>`).join('') || '<p class="empty">No files uploaded yet.</p>';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)} – download</title><link rel="stylesheet" href="/admin/admin.css"></head>
<body class="dl"><main>
<h1><span class="b">Couch</span><span class="a">mate</span></h1>
<p class="lead">Watch together. Download the app for your device and connect to ${esc(name)}.</p>
<section class="files">${rows}</section>
<section class="howto">
  <h2>How to connect</h2>
  <ol>
    <li><b>Server address:</b> <code>http://${esc(host)}</code></li>
    <li><b>PIN code:</b> ask whoever runs the server.</li>
    <li><b>Name:</b> what the others will see.</li>
  </ol>
  <h2>Install</h2>
  <ul>
    <li><b>Android TV / Google TV:</b> install the APK, e.g. with the <i>Downloader</i> or <i>Send Files to TV</i> app.</li>
  </ul>
</section></main></body></html>`);
  }

  function serveDownload(res, name) {
    if (!SAFE_FILE.test(name)) return json(res, 400, { error: 'Invalid file name' });
    const file = path.join(downloadsDir, name);
    let st;
    try { st = fs.statSync(file); } catch { return json(res, 404, { error: 'No such file' }); }
    res.writeHead(200, {
      'content-type': 'application/octet-stream', 'content-length': st.size,
      'content-disposition': `attachment; filename="${name.replace(/"/g, '')}"`,
    });
    fs.createReadStream(file).pipe(res);
  }

  // ---------------------------------------------------------------- admin API
  async function api(req, res, sub) {
    const method = req.method;
    const ip = req.socket.remoteAddress || '';

    if (sub === '/session' && method === 'GET') return json(res, 200, { setupNeeded: !readAuth(), loggedIn: isAdmin(req) });

    if (sub === '/setup' && method === 'POST') {
      if (readAuth()) return json(res, 409, { error: 'The admin password has already been created' });
      if (tooMany(ip)) return json(res, 429, { error: 'Too many attempts – wait a few minutes' });
      const b = await readJson(req, 10000);
      if (String(b.password || '').length < 8) return json(res, 400, { error: 'The password must be at least 8 characters' });
      writeAuth(String(b.password));
      newSession(res);
      console.log('[admin] admin password created');
      return json(res, 200, { ok: true });
    }

    if (sub === '/login' && method === 'POST') {
      if (tooMany(ip)) return json(res, 429, { error: 'Too many attempts – wait a few minutes' });
      const b = await readJson(req, 10000);
      if (!checkPassword(b.password || '')) { failed(ip); return json(res, 401, { error: 'Wrong password' }); }
      newSession(res);
      return json(res, 200, { ok: true });
    }

    if (!isAdmin(req)) return json(res, 401, { error: 'Not logged in' });

    if (sub === '/logout' && method === 'POST') {
      sessions.delete(cookie(req, 'cm_admin'));
      res.setHeader('set-cookie', 'cm_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      return json(res, 200, { ok: true });
    }
    if (sub === '/password' && method === 'POST') {
      const b = await readJson(req, 10000);
      if (!checkPassword(b.current || '')) return json(res, 401, { error: 'The current password is wrong' });
      if (String(b.password || '').length < 8) return json(res, 400, { error: 'The password must be at least 8 characters' });
      writeAuth(String(b.password));
      sessions.clear();
      newSession(res);
      return json(res, 200, { ok: true });
    }

    // ---- overview
    if (sub === '/overview' && method === 'GET') {
      const mem = process.memoryUsage();
      return json(res, 200, {
        state: roomApi.state(),
        serverNow: Date.now(),
        members: roomApi.members(),
        server: { version: ctx.version, uptime: Math.round((Date.now() - startedAt) / 1000), node: process.version, rss: mem.rss, host: os.hostname() },
        setup: { pin: Boolean(settings.get('pin')), plugins: plugins.list().some((p) => p.enabled) },
        counts: { favorites: ctx.favorites.list().length, reminders: ctx.reminders.list().length, history: ctx.history.list().length },
        plugins: plugins.list().map((p) => ({ id: p.id, name: p.name, enabled: p.enabled, error: p.error })),
      });
    }

    // ---- control the room
    const roomCmd = /^\/room\/(play|pause|stop|seek|kick|rename)$/.exec(sub);
    if (roomCmd && method === 'POST') {
      const b = await readJson(req, 10000);
      const c = roomCmd[1];
      if (c === 'seek') roomApi.seek(Number(b.position) || 0);
      else if (c === 'rename') { if (!roomApi.rename(String(b.id || ''), String(b.name || ''))) return json(res, 404, { error: 'Device not found' }); }
      else if (c === 'kick') { if (!roomApi.kick(String(b.id || ''))) return json(res, 404, { error: 'Device not found' }); }
      else roomApi[c]();
      return json(res, 200, { ok: true });
    }

    // ---- the app menu
    if (sub === '/menu' && method === 'GET') {
      const names = Object.fromEntries(plugins.list().map((p) => [p.id, p.name]));
      return json(res, 200, { entries: ctx.menuLayout.forAdmin(plugins.menu(), names) });
    }
    if (sub === '/menu' && method === 'PUT') {
      ctx.menuLayout.update(await readJson(req));
      ctx.menuChanged();
      const names = Object.fromEntries(plugins.list().map((p) => [p.id, p.name]));
      return json(res, 200, { entries: ctx.menuLayout.forAdmin(plugins.menu(), names) });
    }

    // ---- the order of the groups on the Favorites screen
    if (sub === '/favorite-groups' && method === 'GET') {
      const names = Object.fromEntries(plugins.list().map((p) => [p.id, p.name]));
      return json(res, 200, { groups: ctx.favoriteGroupOrder.forAdmin(plugins.favoriteGroupList(), names) });
    }
    if (sub === '/favorite-groups' && method === 'PUT') {
      ctx.favoriteGroupOrder.update(await readJson(req));
      ctx.room.broadcastFavorites(); // the apps show the new order straight away
      const names = Object.fromEntries(plugins.list().map((p) => [p.id, p.name]));
      return json(res, 200, { groups: ctx.favoriteGroupOrder.forAdmin(plugins.favoriteGroupList(), names) });
    }

    // ---- translations
    if (sub === '/translations' && method === 'GET') return json(res, 200, { languages: ctx.translator.forAdmin() });
    if (sub === '/translations' && method === 'PUT') {
      const b = await readJson(req);
      try {
        ctx.translator.correct(String(b.lang || ''), b.text, b.translation);
        return json(res, 200, { languages: ctx.translator.forAdmin() });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    // ---- settings
    if (sub === '/settings' && method === 'GET') return json(res, 200, { groups: GROUPS, settings: settings.forAdmin() });
    if (sub === '/settings' && method === 'PUT') {
      const b = await readJson(req);
      try {
        const changed = settings.update(b);
        if (changed.length) console.log(`[admin] settings changed: ${changed.join(', ')}`);
        return json(res, 200, { ok: true, changed, settings: settings.forAdmin() });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    // ---- data
    if (sub === '/data' && method === 'GET') {
      return json(res, 200, { reminders: ctx.reminders.list(), favorites: ctx.favorites.list(), history: ctx.history.list() });
    }
    const del = /^\/data\/(reminders|favorites|history)(?:\/(.+))?$/.exec(sub);
    if (del && method === 'DELETE') {
      const key = del[2] ? decodeURIComponent(del[2]) : null;
      if (del[1] === 'reminders' && key) {
        if (ctx.reminders.remove(key)) room.broadcastReminders();
        if (room.state.reminder?.key === key) room.clearReminder(true);
      } else if (del[1] === 'favorites' && key) {
        if (ctx.favorites.remove(key)) room.broadcastFavorites();
      } else if (del[1] === 'history') {
        if (key) ctx.history.remove(key); else ctx.history.clear();
        room.broadcastHistory();
      }
      return json(res, 200, { ok: true });
    }

    // ---- log
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

    // ---- downloads
    if (sub === '/downloads' && method === 'GET') return json(res, 200, downloadList());
    const dl = /^\/downloads\/(.+)$/.exec(sub);
    if (dl) {
      const name = decodeURIComponent(dl[1]);
      if (!SAFE_FILE.test(name)) return json(res, 400, { error: 'Invalid file name (letters, digits, dot, dash)' });
      const file = path.join(downloadsDir, name);
      if (method === 'PUT') {
        const body = await readBody(req, MAX_UPLOAD);
        fs.writeFileSync(file, body);
        console.log(`[admin] uploaded ${name} (${fmtSize(body.length)})`);
        return json(res, 200, downloadList());
      }
      if (method === 'PATCH') {
        const b = await readJson(req, 10000);
        const d = descriptions();
        d[name] = String(b.description || '').slice(0, 300);
        fs.writeFileSync(metaFile, JSON.stringify(d, null, 1));
        return json(res, 200, downloadList());
      }
      if (method === 'DELETE') {
        try { fs.unlinkSync(file); } catch { /* already gone */ }
        return json(res, 200, downloadList());
      }
    }

    // ---- plugins
    const pluginList = () => ({ plugins: plugins.list() });
    if (sub === '/plugins' && method === 'GET') return json(res, 200, pluginList());
    if (sub === '/plugins/upload' && method === 'PUT') {
      const name = new URL(req.url, 'http://x').searchParams.get('name') || '';
      if (!/\.zip$/i.test(name)) return json(res, 400, { error: 'Upload the plugin as a .zip file' });
      try {
        const p = await plugins.installZip(name, await readBody(req, 50 * 1024 * 1024));
        console.log(`[admin] plugin installed: ${p.id}`);
        return json(res, 200, pluginList());
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    // Plugins to get from GitHub, and installing one (from the list or any "owner/repo").
    if (sub === '/plugins/catalog' && method === 'GET') {
      try {
        return json(res, 200, { catalog: await plugins.catalog(new URL(req.url, 'http://x').searchParams.has('fresh')) });
      } catch (e) { return json(res, 502, { error: `Could not reach GitHub: ${e.message}` }); }
    }
    if (sub === '/plugins/github' && method === 'POST') {
      try {
        const b = await readJson(req);
        const p = await plugins.installFromGitHub(b.repo, { withNeeds: Boolean(b.withNeeds) });
        console.log(`[admin] plugin installed: ${p.id}`);
        return json(res, 200, pluginList());
      } catch (e) {
        // 409: it needs other plugins first – the page asks, then sends withNeeds: true.
        if (e.needs) return json(res, 409, { error: e.message, needs: e.needs, plugin: e.plugin });
        return json(res, 400, { error: e.message });
      }
    }
    if (sub === '/plugins/check-updates' && method === 'POST') {
      await plugins.checkUpdates();
      return json(res, 200, pluginList());
    }
    const upd = /^\/plugins\/([a-z0-9_-]+)\/(update|auto-update)$/.exec(sub);
    if (upd) {
      try {
        if (upd[2] === 'update' && method === 'POST') await plugins.installUpdate(upd[1]);
        else if (upd[2] === 'auto-update' && method === 'PUT') plugins.setAutoUpdate(upd[1], (await readJson(req)).on);
        else return json(res, 404, { error: 'Unknown request' });
        return json(res, 200, pluginList());
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    const pl = /^\/plugins\/([a-z0-9_-]+)(\/enable|\/disable|\/settings)?$/.exec(sub);
    if (pl) {
      try {
        if (pl[2] === '/enable' && method === 'POST') await plugins.setEnabled(pl[1], true);
        else if (pl[2] === '/disable' && method === 'POST') await plugins.setEnabled(pl[1], false);
        else if (pl[2] === '/settings' && method === 'PUT') await plugins.setSettings(pl[1], await readJson(req));
        else if (!pl[2] && method === 'DELETE') plugins.remove(pl[1]);
        else return json(res, 404, { error: 'Unknown request' });
        return json(res, 200, pluginList());
      } catch (e) { return json(res, 400, { error: e.message }); }
    }

    return json(res, 404, { error: 'Unknown request' });
  }

  /** Returns true if the request was handled here. */
  async function handle(req, res, pathname) {
    if (STATIC[pathname] && req.method === 'GET') {
      const [file, type] = STATIC[pathname];
      try {
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
        res.end(fs.readFileSync(path.join(UI_DIR, file)));
      } catch {
        json(res, 404, { error: 'The admin panel is missing' });
      }
      return true;
    }
    if (pathname === '/download' || pathname === '/download/') { downloadPage(req, res); return true; }
    if (pathname.startsWith('/download/') && req.method === 'GET') { serveDownload(res, decodeURIComponent(pathname.slice(10))); return true; }
    if (pathname.startsWith('/admin/api/')) {
      try { await api(req, res, pathname.slice(10)); } catch (e) { if (!res.headersSent) json(res, 500, { error: e.message }); }
      return true;
    }
    return false;
  }

  return { handle, isAdmin, hasPassword: () => Boolean(readAuth()) };
}
