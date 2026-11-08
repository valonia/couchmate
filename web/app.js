// Couchmates – webbklient. Samma rum, samma synk och samma design som TV-apparna.
'use strict';

// ============================================================ hjälpare

const $ = (s) => document.querySelector(s);
const enc = encodeURIComponent;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** Skapar ett DOM-element. Text läggs alltid in som text (aldrig HTML). */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const hhmm = (sec) => new Date(sec * 1000).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', hour12: false });
const nowSec = () => Date.now() / 1000;

function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return hh > 0 ? `${hh}:${p(mm)}:${p(ss)}` : `${mm}:${p(ss)}`;
}

/** "Film [PRE] [2018]" -> "Film" */
function cleanTitle(name) {
  const s = String(name || '').replace(/\s*[[(][^\])]*[\])]/g, '').replace(/\s{2,}/g, ' ').trim();
  return s || name;
}
const yearFromTitle = (name) => (/[[(]((?:19|20)\d{2})[\])]/.exec(name || '') || [])[1] || null;
const metaLine = (year, genre, rating) =>
  [year, genre, rating > 0 ? `★ ${Number(rating).toFixed(1)}` : null].filter(Boolean).join('  ·  ');

const progNow = (list, t) => (list || []).find((p) => t >= p.start && t < p.end) || null;
const progNext = (list, t) => (list || []).find((p) => p.start > t) || null;
const progFrac = (p, t) => (p.end > p.start ? clamp((t - p.start) / (p.end - p.start), 0, 1) : 0);

function bar(frac, cls = 'bar') {
  return h('div', { class: cls }, h('i', { style: { width: `${clamp(frac, 0, 1) * 100}%` } }));
}

/** Bild med reserv: logotyper får initialer, affischer (cover) hela titeln. */
function thumb(url, fallback, { cover = false, cls = '' } = {}) {
  const box = h('div', { class: `thumb ${cover ? 'cover' : ''} ${cls}` });
  const showFallback = () => {
    box.replaceChildren(h('div', { class: 'fallback' },
      cover ? cleanTitle(fallback) : String(fallback || '').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase()));
  };
  if (url) {
    const img = h('img', { src: url, alt: '', loading: 'lazy', decoding: 'async' });
    img.addEventListener('error', showFallback, { once: true });
    box.append(img);
  } else showFallback();
  return box;
}

/** Ersätter innehållet, hoppar över null/false och plattar ut listor. */
function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((c) => c != null && c !== false));
  return el;
}

const sized = (el, w, hgt) => { el.style.width = `${w}px`; el.style.height = `${hgt}px`; return el; };

const ICONS = {
  tv: '<path d="M21 6h-7.59l3.29-3.29L16 2l-4 4-4-4-.71.71L10.59 6H3c-1.1 0-2 .89-2 2v12c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V8c0-1.11-.9-2-2-2zm0 14H3V8h18v12zM9 10v8l7-4z"/>',
  vod: '<path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z"/>',
  series: '<path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8 12.5v-9l6 4.5-6 4.5z"/>',
  favorites: '<path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>',
  history: '<path d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/>',
  play: '<path d="M8 5v14l11-7z"/>',
  stop: '<path d="M6 6h12v12H6z"/>',
  guide: '<path d="M19 3h-1V1h-2v2H8V1H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 16H5V8h14v11zM7 10h5v5H7z"/>',
  bell: '<path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4a1.5 1.5 0 0 0-3 0v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2zm-2 1H8v-6c0-2.48 1.51-4.5 4-4.5s4 2.02 4 4.5v6z"/>',
  bellOn: '<path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4a1.5 1.5 0 0 0-3 0v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/>',
  search: '<path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>',
  settings: '<path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87a.47.47 0 0 0 .12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.47.47 0 0 0-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"/>',
};
function icon(name, size = 20) {
  const el = document.createElement('span');
  el.className = 'icon';
  el.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" aria-hidden="true">${ICONS[name]}</svg>`;
  return el;
}

const msg = (text, error = false) => h('div', { class: `msg ${error ? 'error' : ''}` }, text);
const label = (text) => h('div', { class: 'label' }, text);

const store = {
  get(k) { try { return localStorage.getItem(`synctv.${k}`) || ''; } catch { return ''; } },
  set(k, v) { try { localStorage.setItem(`synctv.${k}`, v); } catch {} },
};

// ============================================================ språk

/** Appens namn – ändra här för att byta namn överallt på hemsidan. */
const APP_NAME = 'Couchmates';

// "auto" följer webbläsarens språk (svenska om den är på svenska, annars engelska).
const resolveLang = (pref) => (pref === 'sv' || pref === 'en' ? pref : (navigator.language || '').toLowerCase().startsWith('sv') ? 'sv' : 'en');
let langPref = store.get('lang') || 'auto';
let lang = resolveLang(langPref);
const tr = (sv, en) => (lang === 'sv' ? sv : en);
const locale = () => (lang === 'sv' ? 'sv-SE' : 'en-GB');

function setLanguage(pref) {
  langPref = pref;
  lang = resolveLang(pref);
  store.set('lang', pref);
  document.documentElement.lang = lang;
  applyStaticTexts();
  if (app.view === 'browse') { renderTop(); renderMain(); }
  if (app.view === 'player') buildPlayerUI();
}

/** Texter som står direkt i index.html (inloggningssidan). */
function applyStaticTexts() {
  document.title = APP_NAME;
  $('#login h1').replaceChildren(h('span', { class: 'brand-b' }, 'Couch'), h('span', { class: 'brand-a' }, 'mates'));
  $('#login .muted').textContent = tr('Titta tillsammans. Alla som är anslutna ser samma sak samtidigt.', 'Watch together. Everyone who is connected sees the same thing at the same time.');
  $('#login-pin').previousSibling.textContent = tr('PIN-kod', 'PIN code');
  $('#login-pin').placeholder = tr('PIN från servern', 'PIN from the server');
  $('#login-name').previousSibling.textContent = tr('Ditt namn', 'Your name');
  $('#login-name').placeholder = tr('Visas för de andra', 'Shown to the others');
  $('#login-form button[type=submit]').textContent = tr('Anslut', 'Connect');
  const langBox = $('#login-lang');
  if (langBox) {
    fill(langBox,
      h('span', { class: 'muted', style: { marginRight: '6px' } }, tr('Språk', 'Language')),
      [['auto', tr('Automatiskt', 'Automatic')], ['sv', 'Svenska'], ['en', 'English']].map(([code, text]) =>
        h('button', { type: 'button', class: `btn ${langPref === code ? 'selected' : ''}`, onclick: () => setLanguage(code) }, text)));
  }
}

// ============================================================ tillstånd

const app = {
  pin: store.get('pin'),
  name: store.get('name'),
  room: null,
  members: [],
  connected: false,
  connError: null,
  offset: 0,
  samples: [],
  view: 'login', // login | browse | player
  tab: 'live',
  ws: null,
  running: false,
  renderToken: 0,
  tabTimers: [],
  favorites: [],
  reminders: [],
  favEpg: {},
  favEpgAt: 0,
};
const serverNow = () => Date.now() + app.offset;

// ============================================================ API

async function api(path) {
  const r = await fetch(path, { headers: { 'x-pin': app.pin } });
  if (!r.ok) {
    let m = null;
    try { m = (await r.json()).error; } catch {}
    throw new Error(r.status === 401 ? tr('Fel PIN-kod', 'Wrong PIN') : m || tr(`Serverfel ${r.status}`, `Server error ${r.status}`));
  }
  return r.json();
}

const apiCache = new Map();
async function cached(key, ttl, fn) {
  const hit = apiCache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  const v = await fn();
  apiCache.set(key, { t: Date.now(), v });
  return v;
}

const API = {
  categories: (k) => cached(`c/${k}`, 300e3, () => api(`/api/${k}/categories`)),
  items: (k, c) => cached(`i/${k}/${c}`, 300e3, () => api(`/api/${k}/items?category_id=${enc(c)}`)),
  epg: (c) => cached(`e/${c}`, 180e3, () => api(`/api/live/epg?category_id=${enc(c)}`)),
  series: (id) => api(`/api/series/info?id=${enc(id)}`),
  search: (q) => api(`/api/search?limit=40&q=${enc(q)}`),
  history: () => api('/api/history'),
};

// ============================================================ WebSocket / synk

function send(obj) {
  if (app.ws && app.ws.readyState === 1) app.ws.send(JSON.stringify(obj));
}

const cmd = {
  load: (m, position = 0) => send({
    type: 'load', position,
    media: { type: m.type, id: m.id, ext: m.ext, title: m.title, subtitle: m.subtitle ?? null, icon: m.icon ?? null, categoryId: m.categoryId ?? null, seriesId: m.seriesId ?? null },
  }),
  toggle: () => send({ type: 'toggle' }),
  play: () => send({ type: 'play' }),
  pause: () => send({ type: 'pause' }),
  seek: (position) => send({ type: 'seek', position }),
  stop: () => send({ type: 'stop' }),
  ready: (version, duration) => send({ type: 'ready', version, duration: duration || 0 }),
  watching: (value) => send({ type: 'watching', value }),
  historyRemove: (key) => send({ type: 'history_remove', key }),
  historyClear: () => send({ type: 'history_clear' }),
  favAdd: (type, it, categoryName) => send({ type: 'fav_add', item: { type, id: it.id, name: it.name, icon: it.icon ?? null, ext: it.ext ?? '', categoryId: it.categoryId ?? null, categoryName: categoryName ?? it.categoryName ?? null } }),
  favRemove: (key) => send({ type: 'fav_remove', key }),
  favSeen: (key) => send({ type: 'fav_seen', key }),
  reminderToggle: (ch, p, categoryName) => {
    const key = `${ch.id}:${p.start}`;
    if (app.reminders.some((r) => r.key === key)) send({ type: 'reminder_remove', key });
    else send({
      type: 'reminder_add',
      channel: { id: ch.id, name: ch.name, icon: ch.icon ?? null, ext: ch.ext || 'ts', categoryId: ch.categoryId ?? null, categoryName: categoryName ?? ch.categoryName ?? null },
      program: { title: p.title, desc: p.desc ?? null, start: p.start, end: p.end },
    });
  },
  reminderRemove: (key) => send({ type: 'reminder_remove', key }),
  reminderNow: () => send({ type: 'reminder_now' }),
  reminderCancel: () => send({ type: 'reminder_cancel' }),
  nextNow: () => send({ type: 'next_now' }),
  nextCancel: () => send({ type: 'next_cancel' }),
};

function connect() {
  app.running = true;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?pin=${enc(app.pin)}`);
  app.ws = ws;
  let pingTimer = null;
  ws.onopen = () => {
    app.connected = true;
    app.connError = null;
    app.samples = [];
    send({ type: 'hello', name: app.name, device: tr('Webbläsare', 'Browser') });
    if (app.view === 'player') cmd.watching(true);
    let n = 0;
    const ping = () => send({ type: 'ping', t: Date.now() });
    ping();
    pingTimer = setInterval(() => { ping(); if (++n === 4) { clearInterval(pingTimer); pingTimer = setInterval(ping, 10000); } }, 300);
    renderTop();
  };
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'pong') {
      const now = Date.now();
      const rtt = now - m.t;
      app.samples.push({ rtt, off: m.s - (m.t + rtt / 2) });
      if (app.samples.length > 12) app.samples.shift();
      app.offset = app.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a)).off;
    } else if (m.type === 'state') onState(m.state);
    else if (m.type === 'members') { app.members = m.members || []; renderTop(); if (app.view === 'player') buildPlayerUI(); }
    else if (m.type === 'reminders') {
      app.reminders = m.reminders || [];
      guideView?.refresh();
      if (app.view === 'browse' && app.tab === 'favorites') renderMain();
    }
    else if (m.type === 'favorites') {
      app.favorites = m.favorites || [];
      renderTop();
      refreshFavMarks();
      if (app.view === 'browse' && app.tab === 'favorites') renderMain();
    }
  };
  ws.onclose = () => {
    clearInterval(pingTimer);
    if (app.ws !== ws) return;
    app.connected = false;
    app.connError = tr('Anslutningen bröts – försöker igen…', 'Connection lost – reconnecting…');
    renderTop();
    if (app.running) setTimeout(() => { if (app.ws === ws) connect(); }, 2000);
  };
}

function onState(st) {
  const prevKey = app.room?.media ? `${app.room.media.type}:${app.room.media.id}` : null;
  const prevVersion = app.room?.version;
  app.room = st;
  const key = st.media ? `${st.media.type}:${st.media.id}` : null;
  // När någon startar något nytt hoppar alla in i spelaren.
  if (key && key !== prevKey) openPlayer();
  // Startar man själv något som redan spelas – hoppa in i spelaren ändå.
  else if (key && st.version !== prevVersion && st.action === 'load' && st.changedBy === app.name && app.view !== 'player') openPlayer();
  else if (!key && app.view === 'player') closePlayer();
  renderTop();
  if (app.view === 'browse') liveView?.refreshPlaying();
  if (app.view === 'player') {
    if (st.version !== prevVersion && ['load', 'play', 'pause', 'seek'].includes(st.action)) pokeUI();
    buildPlayerUI();
  }
}

// ============================================================ inloggning

async function tryLogin(pin, name) {
  app.pin = pin;
  app.name = name;
  await api('/api/live/categories');
  store.set('pin', pin);
  store.set('name', name);
}

function showLogin(error = '') {
  app.view = 'login';
  app.running = false;
  if (app.ws) { const w = app.ws; app.ws = null; w.close(); }
  $('#browse').hidden = true;
  $('#player').hidden = true;
  $('#login').hidden = false;
  $('#login-pin').value = app.pin;
  $('#login-name').value = app.name;
  $('#login-error').textContent = error;
  ($('#login-name').value ? $('#login-pin') : $('#login-name')).focus();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter || $('#login-form button');
  btn.disabled = true;
  $('#login-error').textContent = '';
  try {
    await tryLogin($('#login-pin').value.trim(), $('#login-name').value.trim() || tr('Gäst', 'Guest'));
    startApp();
  } catch (err) {
    $('#login-error').textContent = tr(`Kunde inte ansluta: ${err.message}`, `Couldn't connect: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

function startApp() {
  $('#login').hidden = true;
  showBrowse();
  connect();
}

// ============================================================ toppfält

const TABS = () => {
  // Favoriter får en markering när det finns nya avsnitt, t.ex. "Favoriter ●2"
  const fresh = app.favorites.reduce((n, f) => n + (f.newCount || 0), 0);
  return [['live', 'TV'], ['vod', tr('Filmer', 'Movies')], ['series', tr('Serier', 'Series')],
    ['favorites', tr('Favoriter', 'Favorites') + (fresh ? ` ●${fresh}` : '')],
    ['history', tr('Historik', 'History')]];
};

// ---------------------------------------------------------------- favoriter

const favKey = (type, id) => `${type}:${id}`;
const favOf = (type, id) => app.favorites.find((f) => f.key === favKey(type, id));

function toggleFav(type, it, categoryName) {
  const f = favOf(type, it.id);
  if (f) cmd.favRemove(f.key); else cmd.favAdd(type, it, categoryName);
}

/** Stjärnknapp som lägger till/tar bort favorit (stoppar klicket från att starta uppspelning). */
function favButton(type, it, categoryName) {
  const on = !!favOf(type, it.id);
  return h('span', {
    class: `fav-btn ${on ? 'on' : ''}`, role: 'button', tabindex: '0', 'data-fav': favKey(type, it.id),
    title: on ? tr('Ta bort från favoriter', 'Remove from favourites') : tr('Lägg till i favoriter', 'Add to favourites'),
    onclick: (e) => { e.stopPropagation(); toggleFav(type, it, categoryName); },
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); toggleFav(type, it, categoryName); } },
  }, on ? '★' : '☆');
}

/** Uppdaterar stjärnor och "NYA"-etiketter på det som redan visas. */
function refreshFavMarks() {
  document.querySelectorAll('[data-fav]').forEach((el) => {
    const on = app.favorites.some((f) => f.key === el.dataset.fav);
    el.classList.toggle('on', on);
    el.textContent = on ? '★' : '☆';
  });
  document.querySelectorAll('[data-new]').forEach((el) => {
    const n = app.favorites.find((f) => f.key === el.dataset.new)?.newCount || 0;
    el.hidden = !n;
    el.textContent = n === 1 ? tr('NYTT', 'NEW') : tr(`${n} NYA`, `${n} NEW`);
  });
}

function newBadge(type, id) {
  const n = favOf(type, id)?.newCount || 0;
  return h('span', { class: 'badge-new', 'data-new': favKey(type, id), hidden: !n }, n === 1 ? tr('NYTT', 'NEW') : tr(`${n} NYA`, `${n} NEW`));
}

/** Menyn till vänster: ikoner, och text när musen är över (eller fokus är i) menyn. */
function renderTop() {
  const top = $('#topbar');
  if (!top || app.view !== 'browse') return;
  const media = app.room?.media;
  const item = (iconName, text, { selected = false, onclick, badge = null, sub = null, cls = '' } = {}) =>
    h('button', { class: `btn nav-item ${selected ? 'selected' : ''} ${cls}`, onclick, 'aria-label': text },
      h('span', { class: 'nav-icon' }, icon(iconName, 22), badge && h('span', { class: 'nav-dot' })),
      h('span', { class: 'nav-label' }, sub && h('small', {}, sub), h('span', { class: 'ellipsis' }, text), badge && h('b', { class: 'nav-badge' }, badge)));
  const newFav = app.favorites.reduce((n, f) => n + (f.newCount || 0), 0);
  fill(top,
    h('div', { class: 'brand' }, h('span', { class: 'brand-logo' }), h('span', { class: 'nav-label' }, h('span', { class: 'brand-b' }, 'Couch'), h('span', { class: 'brand-a' }, 'mates'))),
    ...TABS().map(([id, text]) => item(id === 'live' ? 'tv' : id, text.replace(/\s*●\d+$/, ''), { selected: app.tab === id, onclick: () => setTab(id), badge: id === 'favorites' && newFav ? `●${newFav}` : null })),
    item('search', tr('Sök', 'Search'), { selected: app.tab === 'search', onclick: () => setTab('search') }),
    item('settings', tr('Inställningar', 'Settings'), { onclick: () => showLogin() }),
    h('div', { class: 'spacer' }),
    media && item('play', media.title, { onclick: openPlayer, sub: tr('Nu spelas', 'Now playing'), cls: 'nowplaying' }),
    media && item('stop', tr('Stoppa för alla', 'Stop for everyone'), { onclick: () => cmd.stop() }),
    viewersChip(app.members, { clickable: true }),
    h('div', { class: 'clock' }, hhmm(nowSec())),
  );
}

const AVATAR_COLORS = ['#3d7bff', '#e5484d', '#3dd68c', '#f5c451', '#b57bff', '#2ec4d6', '#ff8a4c'];
function avatarColor(name) {
  let x = 0;
  for (const ch of String(name).toLowerCase()) x = (x * 31 + ch.codePointAt(0)) | 0;
  return AVATAR_COLORS[(x >>> 0) % AVATAR_COLORS.length];
}
const avatar = (name, size = 24) => h('span', { class: 'avatar', style: { width: `${size}px`, height: `${size}px`, background: avatarColor(name), fontSize: `${Math.round(size * 0.45)}px` } },
  String(name).trim().slice(0, 1).toUpperCase());

/** "Bob" · "Bob, Karin" · "Bob, Karin +13" */
const viewersText = (m) => (m.length <= 2 ? m.map((x) => x.name).join(', ') : `${m[0].name}, ${m[1].name} +${m.length - 2}`);

/** Kompakt chip oavsett antal: upp till tre avatarer + "Bob, Karin +13". Klick = lista över alla (bara i menyn). */
function viewersChip(members, { clickable = false } = {}) {
  const body = [
    app.connected && members.length
      ? h('span', { class: 'avatars' }, members.slice(0, 3).map((m) => avatar(m.name)))
      : h('span', { class: `dot ${app.connected ? 'on' : ''}` }),
    h('span', { class: 'ellipsis' }, app.connected ? (viewersText(members) || tr('Ansluten', 'Connected')) : (app.connError || tr('Ansluter…', 'Connecting…'))),
  ];
  if (!clickable) return h('div', { class: 'chip' }, body);
  return h('button', { class: 'chip chip-btn', title: tr('Visa alla som är anslutna', 'Show everyone connected'), onclick: toggleMembers }, body);
}

function toggleMembers(e) {
  e?.stopPropagation();
  const old = document.querySelector('.members-pop');
  if (old) { old.remove(); return; }
  const sorted = [...app.members].sort((a, b) => (b.watching - a.watching) || a.name.localeCompare(b.name, 'sv'));
  const pop = h('div', { class: 'members-pop', onclick: (ev) => ev.stopPropagation() },
    h('div', { style: { fontWeight: '700', fontSize: '17px' } }, tr(`${sorted.length} anslutna`, `${sorted.length} connected`)),
    h('div', { class: 'faint', style: { fontSize: '13px', margin: '2px 0 10px' } },
      app.room?.media ? tr(`Tittar på ${app.room.media.title}`, `Watching ${app.room.media.title}`) : tr('Inget spelas just nu', 'Nothing playing right now')),
    h('div', { class: 'members-list' }, sorted.map((m) => h('div', { class: 'member' },
      avatar(m.name, 30),
      h('div', { style: { flex: '1', minWidth: '0' } },
        h('div', { class: 'ellipsis', style: { fontWeight: '500' } }, m.name),
        m.device && h('div', { class: 'faint ellipsis', style: { fontSize: '12px' } }, m.device)),
      h('span', { style: { fontSize: '12px', color: m.watching ? 'var(--green)' : 'var(--faint)' } }, m.watching ? tr('Tittar', 'Watching') : tr('I menyn', 'In menu'))))));
  document.body.append(pop);
  setTimeout(() => document.addEventListener('click', () => pop.remove(), { once: true }), 0);
}

setInterval(() => document.querySelectorAll('.clock').forEach((c) => { c.textContent = hhmm(nowSec()); }), 5000);

// ============================================================ flikar

let liveView = null;

function setTab(t) {
  app.tab = t;
  renderTop();
  renderMain();
}

function showBrowse() {
  app.view = 'browse';
  $('#player').hidden = true;
  $('#browse').hidden = false;
  renderTop();
  renderMain();
}

function renderMain() {
  app.tabTimers.forEach(clearInterval);
  app.tabTimers = [];
  liveView = null;
  const token = ++app.renderToken;
  const main = $('#main');
  main.replaceChildren();
  const alive = () => token === app.renderToken;
  ({ live: renderLive, vod: (m, a) => renderVod(m, a, 'vod'), series: (m, a) => renderVod(m, a, 'series'), favorites: renderFavorites, search: renderSearch, history: renderHistory })[app.tab](main, alive);
}

function groupList(cats, selectedId, onSelect) {
  const list = h('div', { class: 'scroll' });
  const draw = (sel) => list.replaceChildren(...cats.map((c) =>
    h('button', { class: `row ${c.id === sel ? 'selected' : ''}`, onclick: () => { draw(c.id); onSelect(c); } },
      h('span', { class: 'ellipsis' }, c.name))));
  draw(selectedId);
  return h('div', { class: 'panel col groups' }, label(tr('Grupper', 'Groups')), list);
}

// ---------------------------------------------------------------- live

const liveSel = { catId: null };

function channelRow(item, epgList, t, playing, { onclick, onfocus, categoryName, fav = true } = {}) {
  const p = progNow(epgList, t);
  return h('button', { class: `row ch ${playing ? 'selected' : ''}`, onclick, onmouseenter: onfocus, onfocus },
    h('span', { class: 'num' }, item.num ?? ''),
    thumb(item.icon, item.name),
    h('div', { class: 'body' },
      h('div', { class: 'name ellipsis' }, item.name, playing ? '  ▶' : ''),
      p && h('div', { class: 'prog ellipsis' }, `${hhmm(p.start)}  ${p.title}`),
      p && bar(progFrac(p, t))),
    fav && guideButton(item, categoryName),
    fav && favButton('live', item, categoryName));
}

const reminderFor = (channelId, start) => app.reminders.find((r) => r.key === `${channelId}:${start}`);

function guideButton(item, categoryName) {
  const open = (e) => { e.stopPropagation(); e.preventDefault(); openGuide(item, categoryName); };
  const b = h('span', {
    class: 'fav-btn guide-btn', role: 'button', tabindex: '0', title: tr('Tablå och påminnelser', 'Guide and reminders'),
    onclick: open, onkeydown: (e) => { if (e.key === 'Enter') open(e); },
  });
  b.append(icon('guide', 18));
  return b;
}

// ---------------------------------------------------------------- tablå + påminnelser

let guideView = null;

function closeGuide() {
  if (!guideView) return;
  clearInterval(guideView.timer);
  guideView.shade.remove();
  guideView.panel.remove();
  guideView = null;
}

function dayLabel(sec) {
  const d = new Date(sec * 1000), today = new Date(), tomorrow = new Date(Date.now() + 86400e3);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return tr('Idag', 'Today');
  if (same(d, tomorrow)) return tr('Imorgon', 'Tomorrow');
  return d.toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' });
}

/** Tablå för en kanal som en panel till höger. Klockan på ett program = påminnelse för hela rummet. */
async function openGuide(ch, categoryName) {
  closeGuide();
  const list = h('div', { class: 'g-list' }, msg(tr('Hämtar tablån…', 'Loading the guide…')));
  const panel = h('div', { class: 'guide', role: 'dialog' },
    h('div', { class: 'g-head' },
      thumb(ch.icon, ch.name, { cls: 'logo' }),
      h('div', { style: { flex: '1', minWidth: '0' } },
        h('div', { class: 'ellipsis', style: { fontSize: '20px', fontWeight: '700' } }, ch.name),
        h('div', { class: 'faint', style: { fontSize: '13px', marginTop: '2px' } }, tr('Tablå · klockan = påminnelse för alla', 'Guide · bell = reminder for everyone'))),
      h('button', { class: 'icon-btn', onclick: closeGuide, title: tr('Stäng (Esc)', 'Close (Esc)') }, '✕')),
    h('div', { style: { padding: '0 22px 12px' } },
      h('button', { class: 'btn primary', onclick: () => { cmd.load({ type: 'live', id: ch.id, ext: ch.ext || 'ts', title: ch.name, subtitle: categoryName ?? ch.categoryName ?? null, icon: ch.icon, categoryId: ch.categoryId }); closeGuide(); } },
        tr('▶  Byt till kanalen nu', '▶  Switch to this channel now'))),
    list);
  const shade = h('div', { class: 'guide-shade', onclick: closeGuide });
  document.body.append(shade, panel);
  let programs = null, error = null;
  const render = () => {
    if (!programs) { if (error) fill(list, msg(tr(`Fel: ${error}`, `Error: ${error}`), true)); return; }
    const t = nowSec();
    const shown = programs.filter((p) => p.end > t);
    if (!shown.length) { fill(list, msg(tr('Ingen tablå finns för den här kanalen.', "There's no guide for this channel."))); return; }
    const top = list.scrollTop;
    const kids = [];
    let lastDay = null;
    for (const p of shown) {
      const day = dayLabel(p.start);
      if (day !== lastDay) { lastDay = day; kids.push(h('div', { class: 'g-day' }, day)); }
      const live = t >= p.start && t < p.end;
      const r = reminderFor(ch.id, p.start);
      const bell = !live && h('button', {
        class: `bell-btn ${r ? 'on' : ''}`, onclick: () => cmd.reminderToggle(ch, p, categoryName),
        title: r ? tr('Ta bort påminnelsen', 'Remove the reminder') : tr('Påminn: byt till kanalen när programmet börjar', 'Remind: switch to the channel when it starts'),
      });
      if (bell) bell.append(icon(r ? 'bellOn' : 'bell', 20));
      kids.push(h('div', { class: `g-row ${live ? 'live' : ''} ${r ? 'reminded' : ''}` },
        h('div', { class: 'g-time' }, h('b', {}, hhmm(p.start)), h('span', {}, `– ${hhmm(p.end)}`)),
        h('div', { class: 'g-body' },
          h('div', { class: 'g-title' }, live && h('span', { class: 'badge-live' }, tr('PÅGÅR', 'ON NOW')), h('span', { class: 'ellipsis' }, p.title)),
          p.desc && h('div', { class: 'g-desc' }, p.desc),
          live && bar(progFrac(p, t)),
          r && h('div', { class: 'g-rem' }, tr(`Påminnelse · byter kanal strax innan${r.addedBy ? ` · av ${r.addedBy}` : ''}`, `Reminder · switches channel just before${r.addedBy ? ` · by ${r.addedBy}` : ''}`))),
        bell));
    }
    list.replaceChildren(...kids);
    list.scrollTop = top;
  };
  guideView = { panel, shade, refresh: render, timer: setInterval(render, 30000) };
  try { programs = await api(`/api/live/guide?id=${enc(ch.id)}`); } catch (e) { error = e.message; }
  if (guideView?.panel === panel) render();
}

// Esc stänger tablån före allt annat.
document.addEventListener('keydown', (e) => {
  if (guideView && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeGuide(); }
}, true);

/** "Påminnelse: X börjar 21:00 – byter kanal om 23 s" (syns både i menyn och i spelaren). */
const remCard = h('div', { class: 'rem-card', hidden: true });
document.body.append(remCard);
let remCardKey = null, remCountEl = null;
function updateReminderCard() {
  const r = app.room?.reminder;
  if (!r || app.view === 'login') { remCard.hidden = true; remCardKey = null; return; }
  const left = Math.max(0, Math.ceil((r.switchAt - serverNow()) / 1000));
  if (r.key !== remCardKey) {
    remCardKey = r.key;
    const bellIcon = h('div', { class: 'rem-icon' });
    bellIcon.append(icon('bellOn', 22));
    fill(remCard, bellIcon, h('div', { style: { minWidth: '0', flex: '1' } },
      remCountEl = h('div', { class: 'rem-count' }),
      h('div', { class: 'ellipsis', style: { fontSize: '17px', fontWeight: '600', marginTop: '4px' } }, r.title),
      h('div', { class: 'muted ellipsis', style: { fontSize: '14px', marginTop: '2px' } }, tr(`Börjar ${hhmm(r.start)} på ${r.channel?.name ?? ''}`, `Starts ${hhmm(r.start)} on ${r.channel?.name ?? ''}`)),
      h('div', { style: { display: 'flex', gap: '8px', marginTop: '12px' } },
        h('button', { class: 'btn primary', onclick: () => cmd.reminderNow() }, tr('Byt nu', 'Switch now')),
        h('button', { class: 'btn', onclick: () => cmd.reminderCancel() }, tr('Avbryt', 'Cancel')))));
  }
  remCountEl.textContent = tr(`PÅMINNELSE · BYTER KANAL OM ${left} S`, `REMINDER · SWITCHING CHANNEL IN ${left} S`);
  remCard.hidden = false;
}
setInterval(updateReminderCard, 500);

async function renderLive(main, alive) {
  const chLabel = label('');
  const chList = h('div', { class: 'scroll' }, msg(tr('Laddar kanaler…', 'Loading channels…')));
  const info = h('div', { class: 'panel info' });
  const groupsSlot = h('div', { class: 'panel col groups' }, label(tr('Grupper', 'Groups')));
  main.append(groupsSlot, h('div', { class: 'panel col', style: { flex: '1', minWidth: '0' } }, chLabel, chList), info);

  let cats;
  try { cats = await API.categories('live'); } catch (e) { chList.replaceChildren(msg(tr(`Fel: ${e.message}`, `Error: ${e.message}`), true)); return; }
  if (!alive()) return;
  if (!cats.some((c) => c.id === liveSel.catId)) liveSel.catId = cats[0]?.id;

  let items = [], epg = {}, focused = null, catName = '';
  const playingId = () => (app.room?.media?.type === 'live' ? app.room.media.id : null);

  function drawInfo() {
    info.replaceChildren();
    if (!focused) return;
    const t = nowSec();
    const list = epg[focused.id];
    const cur = progNow(list, t), nxt = progNext(list, t);
    fill(info,
      thumb(focused.icon, focused.name, { cls: 'logo' }),
      h('div', { style: { marginTop: '18px', display: 'flex', gap: '10px', alignItems: 'center' } },
        focused.num != null && h('span', { class: 'muted', style: { fontSize: '18px' } }, focused.num),
        h('span', { class: 'badge-live' }, 'LIVE')),
      h('h2', {}, focused.name),
      cur ? [
        label(tr('Nu', 'Now')),
        h('div', { class: 'now-title' }, cur.title),
        h('div', { class: 'times' }, hhmm(cur.start), bar(progFrac(cur, t)), hhmm(cur.end)),
        cur.desc && h('div', { class: 'desc' }, cur.desc),
      ] : h('div', { class: 'faint' }, tr('Ingen programinformation', 'No programme information')),
      nxt && [h('div', { style: { height: '22px' } }), label(tr('Härnäst', 'Up next')), h('div', {}, `${hhmm(nxt.start)}  ${nxt.title}`)],
      h('div', { class: 'hint' }, tr('Klicka på en kanal för att titta tillsammans', 'Click a channel to watch together')),
    );
  }

  function drawChannels() {
    const t = nowSec(), pid = playingId();
    const scroll = chList.scrollTop;
    chList.replaceChildren(...items.map((item) => channelRow({ ...item, categoryId: liveSel.catId }, epg[item.id], t, item.id === pid, {
      onclick: () => cmd.load({ type: 'live', id: item.id, ext: item.ext, title: item.name, subtitle: catName, icon: item.icon, categoryId: liveSel.catId }),
      onfocus: () => { focused = item; drawInfo(); },
      categoryName: catName,
    })));
    chList.scrollTop = scroll;
  }

  async function loadCat() {
    const cat = cats.find((c) => c.id === liveSel.catId);
    if (!cat) return;
    catName = cat.name;
    chLabel.textContent = cat.name;
    chList.replaceChildren(msg(tr('Laddar kanaler…', 'Loading channels…')));
    try { items = await API.items('live', cat.id); } catch (e) { chList.replaceChildren(msg(tr(`Fel: ${e.message}`, `Error: ${e.message}`), true)); return; }
    if (!alive() || liveSel.catId !== cat.id) return;
    chLabel.textContent = tr(`${cat.name}  ·  ${items.length} kanaler`, `${cat.name}  ·  ${items.length} channels`);
    focused = items.find((i) => i.id === playingId()) || items[0] || null;
    epg = {};
    drawChannels();
    drawInfo();
    try { epg = await API.epg(cat.id); } catch {}
    if (alive() && liveSel.catId === cat.id) { drawChannels(); drawInfo(); }
  }

  groupsSlot.replaceWith(groupList(cats, liveSel.catId, (c) => { liveSel.catId = c.id; loadCat(); }));
  await loadCat();
  app.tabTimers.push(setInterval(async () => {
    try { epg = await API.epg(liveSel.catId); } catch {}
    if (alive()) { drawChannels(); drawInfo(); }
  }, 60e3));
  liveView = { refreshPlaying: drawChannels };
}

// ---------------------------------------------------------------- filmer & serier

const vodSel = { vod: null, series: null };

function hero({ name, year, genre, rating, plot, poster, backdrop }) {
  const meta = metaLine(year || yearFromTitle(name), genre, rating);
  return h('div', { class: 'hero' },
    backdrop && h('img', { class: 'backdrop', src: backdrop, alt: '', onerror: (e) => e.target.remove() }),
    h('div', { class: 'content' },
      thumb(poster, name, { cover: true, cls: 'poster' }),
      h('div', { style: { minWidth: '0' } },
        h('h2', {}, cleanTitle(name)),
        meta && h('div', { class: 'meta' }, meta),
        plot && h('div', { class: 'plot' }, plot))));
}

function posterCard(item, onclick, onfocus, { type = null, categoryName = null, caption = null } = {}) {
  return h('button', { class: 'poster-card', onclick, onmouseenter: onfocus, onfocus },
    h('div', { class: 'poster-wrap' },
      thumb(item.icon, item.name, { cover: true }),
      type && favButton(type, item, categoryName),
      type === 'series' && newBadge('series', item.id)),
    caption && h('div', { class: 'caption' }, caption),
    h('div', { class: 'title' }, cleanTitle(item.name)));
}

async function renderVod(main, alive, kind) {
  const right = h('div', { class: 'col vod' }, msg(tr('Laddar…', 'Loading…')));
  const groupsSlot = h('div', { class: 'panel col groups' }, label(tr('Grupper', 'Groups')));
  main.append(groupsSlot, right);

  let cats;
  try { cats = await API.categories(kind); } catch (e) { right.replaceChildren(msg(tr(`Fel: ${e.message}`, `Error: ${e.message}`), true)); return; }
  if (!alive()) return;
  if (!cats.some((c) => c.id === vodSel[kind])) vodSel[kind] = cats[0]?.id;

  let items = [];
  const heroSlot = h('div');
  const showHero = (it) => heroSlot.replaceChildren(hero({
    name: it.name, year: it.year, genre: it.genre, rating: it.rating, plot: it.plot, poster: it.icon, backdrop: it.backdrop || it.icon,
  }));

  function drawGrid() {
    const grid = h('div', { class: 'grid' }, ...items.map((it) => posterCard(it,
      () => {
        if (kind === 'series') openSeries(right, { ...it, categoryId: vodSel[kind] }, vodSel[kind], drawGrid);
        else cmd.load({ type: 'movie', id: it.id, ext: it.ext, title: cleanTitle(it.name), subtitle: yearFromTitle(it.name) || it.year, icon: it.icon, categoryId: vodSel[kind] });
      },
      () => showHero(it),
      { type: kind === 'series' ? 'series' : 'movie', categoryName: cats.find((c) => c.id === vodSel[kind])?.name })));
    if (items[0]) showHero(items[0]);
    right.replaceChildren(heroSlot, h('div', { class: 'scroll' }, grid));
  }

  async function loadCat() {
    const catId = vodSel[kind];
    right.replaceChildren(msg(tr('Laddar…', 'Loading…')));
    try { items = await API.items(kind, catId); } catch (e) { right.replaceChildren(msg(tr(`Fel: ${e.message}`, `Error: ${e.message}`), true)); return; }
    if (alive() && vodSel[kind] === catId) drawGrid();
  }

  groupsSlot.replaceWith(groupList(cats, vodSel[kind], (c) => { vodSel[kind] = c.id; loadCat(); }));
  await loadCat();
}

/** Seriesida med säsonger och avsnitt. onBack ritar om det som var innan. */
async function openSeries(container, series, categoryId, onBack) {
  const back = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
    h('button', { class: 'btn', onclick: onBack }, tr('← Tillbaka', '← Back')),
    h('button', { class: 'btn selected', onclick: () => toggleFav('series', series, series.categoryName) },
      h('span', { 'data-fav': favKey('series', series.id) }, favOf('series', series.id) ? '★' : '☆'), ' ', tr('Favorit', 'Favourite')),
    favOf('series', series.id)?.newCount ? h('span', { style: { color: 'var(--accent)', fontWeight: '600' } }, tr(`Nytt: ${favOf('series', series.id).newLabel}`, `New: ${favOf('series', series.id).newLabel}`)) : null);
  // Öppnar man serien räknas nya avsnitt som sedda.
  if (favOf('series', series.id)?.newCount) setTimeout(() => cmd.favSeen(favKey('series', series.id)), 1500);
  container.replaceChildren(h('div', {}, back),
    hero({ name: series.name, year: series.year, genre: series.genre, rating: series.rating, plot: series.plot, poster: series.icon, backdrop: series.backdrop || series.icon }),
    msg(tr('Laddar avsnitt…', 'Loading episodes…')));
  let info;
  try { info = await API.series(series.id); } catch (e) { container.lastChild.replaceWith(msg(tr(`Fel: ${e.message}`, `Error: ${e.message}`), true)); return; }
  if (!container.isConnected) return;
  if (!info.seasons.length) { container.lastChild.replaceWith(msg(tr('Inga avsnitt hittades', 'No episodes found'))); return; }
  let idx = 0;
  const seasonsEl = h('div', { class: 'seasons' });
  const eps = h('div', { class: 'panel scroll' });
  const draw = () => {
    seasonsEl.replaceChildren(...info.seasons.map((s, i) => h('button', { class: `btn ${i === idx ? 'selected' : ''}`, onclick: () => { idx = i; draw(); } },
      s.season === 0 ? tr('Extra', 'Extras') : tr(`Säsong ${s.season}`, `Season ${s.season}`))));
    const season = info.seasons[idx];
    eps.replaceChildren(...season.episodes.map((ep) => h('button', {
      class: 'row ep',
      onclick: () => cmd.load({
        type: 'episode', id: ep.id, ext: ep.ext, title: cleanTitle(series.name),
        subtitle: `S${String(season.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')} · ${ep.title}`,
        icon: ep.icon || series.icon, categoryId, seriesId: series.id,
      }),
    },
      h('span', { class: 'no' }, `E${String(ep.episode).padStart(2, '0')}`),
      thumb(ep.icon || info.icon || series.icon, ep.title, { cover: true }),
      h('span', { class: 'ellipsis' }, ep.title))));
  };
  draw();
  container.replaceChildren(h('div', {}, back),
    hero({ name: series.name, year: info.year || series.year, genre: info.genre || series.genre, rating: info.rating || series.rating,
      plot: info.plot || series.plot, poster: info.icon || series.icon, backdrop: info.backdrop || series.backdrop || series.icon }),
    seasonsEl, eps);
}

// ---------------------------------------------------------------- sök

let lastQuery = '';

function renderSearch(main, alive) {
  const input = h('input', { type: 'search', placeholder: tr('Sök kanaler, filmer och serier…', 'Search channels, movies and series…'), value: lastQuery, autocomplete: 'off' });
  const status = h('div', { class: 'faint', style: { padding: '12px 28px 8px', fontSize: '14px' } });
  const results = h('div', { class: 'scroll' });
  const box = h('div', { class: 'search' },
    h('div', { class: 'searchbox' }, h('span', { class: 'muted', style: { display: 'grid' } }, icon('search', 24)), input),
    status, results);
  main.append(box);

  const section = (title, count, kids) => h('div', { style: { marginBottom: '22px' } },
    h('div', { class: 'result-title' }, title, h('span', {}, `  ${count}`)),
    h('div', { class: 'hscroll' }, kids));

  let timer = null, seq = 0;
  async function run() {
    const q = input.value.trim();
    lastQuery = input.value;
    if (q.length < 2) {
      status.textContent = tr('Skriv minst två tecken.', 'Type at least two characters.');
      fill(results,);
      return;
    }
    const my = ++seq;
    status.textContent = tr('Söker…', 'Searching…');
    let r;
    try { r = await API.search(q); } catch (e) { if (my === seq) status.textContent = tr(`Fel: ${e.message}`, `Error: ${e.message}`); return; }
    if (my !== seq || !alive()) return;
    const empty = !r.live.length && !r.vod.length && !r.series.length;
    status.textContent = empty ? tr(`Inga träffar för "${q}"`, `No results for "${q}"`) : '';
    results.replaceChildren(
      r.live.length > 0 && section(tr('Kanaler', 'Channels'), r.live.length, r.live.map((ch) => h('button', {
        class: 'row chcard',
        onclick: () => cmd.load({ type: 'live', id: ch.id, ext: ch.ext, title: ch.name, subtitle: ch.categoryName, icon: ch.icon, categoryId: ch.categoryId }),
      }, thumb(ch.icon, ch.name), h('div', { style: { minWidth: '0', flex: '1' } },
        h('div', { class: 'ellipsis', style: { fontWeight: '500' } }, ch.name),
        ch.categoryName && h('div', { class: 'ellipsis', style: { fontSize: '13px', opacity: '.7' } }, ch.categoryName)),
      favButton('live', ch, ch.categoryName)))),
      r.vod.length > 0 && section(tr('Filmer', 'Movies'), r.vod.length, r.vod.map((m) => posterCard(m,
        () => cmd.load({ type: 'movie', id: m.id, ext: m.ext, title: cleanTitle(m.name), subtitle: yearFromTitle(m.name) || m.year, icon: m.icon, categoryId: m.categoryId }),
        null, { type: 'movie' }))),
      r.series.length > 0 && section(tr('Serier', 'Series'), r.series.length, r.series.map((s) => posterCard(s,
        () => openSeries(box, s, s.categoryId, () => renderMain()), null, { type: 'series' }))),
    );
  }
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 350); });
  setTimeout(() => input.focus(), 50);
  run();
}

// ---------------------------------------------------------------- favoriter-fliken

function renderFavorites(main) {
  const box = h('div', { class: 'search' });
  main.append(box);
  const favs = app.favorites;
  const head = h('div', { style: { display: 'flex', alignItems: 'baseline', padding: '0 12px 14px' } },
    h('span', { style: { fontSize: '24px', fontWeight: '700' } }, tr('Favoriter', 'Favourites')),
    h('span', { class: 'faint', style: { fontSize: '15px', marginLeft: '16px' } },
      tr('Gemensamma för alla i rummet  ·  Klicka på ★ för att ta bort', 'Shared with everyone in the room  ·  Click ★ to remove')));
  const rems = app.reminders;
  const remSection = rems.length > 0 && h('div', { style: { marginBottom: '22px' } },
    h('div', { class: 'result-title' }, tr('Påminnelser', 'Reminders'), h('span', {}, `  ${rems.length}`)),
    h('div', { style: { padding: '0 12px' } }, rems.map((r) => {
      const x = h('span', { class: 'fav-btn on', role: 'button', tabindex: '0', title: tr('Ta bort påminnelsen', 'Remove the reminder'),
        onclick: (e) => { e.stopPropagation(); cmd.reminderRemove(r.key); } }, '✕');
      const bellIcon = h('span', { class: 'rem-bell' });
      bellIcon.append(icon('bellOn', 18));
      return h('button', { class: 'row rem-row', onclick: () => openGuide(r.channel, r.channel.categoryName), title: tr('Visa tablån för kanalen', "Show the channel's guide") },
        bellIcon,
        h('div', { class: 'rem-when' }, h('b', {}, `${dayLabel(r.start)} ${hhmm(r.start)}`), h('span', { class: 'faint' }, `– ${hhmm(r.end)}`)),
        h('div', { style: { flex: '1', minWidth: '0' } },
          h('div', { class: 'ellipsis', style: { fontWeight: '600' } }, r.title),
          h('div', { class: 'ellipsis faint', style: { fontSize: '13px' } }, r.channel.name + (r.addedBy ? tr(` · av ${r.addedBy}`, ` · by ${r.addedBy}`) : ''))),
        x);
    })));
  if (!favs.length) {
    fill(box, head, remSection || '', msg(tr(
      'Inga favoriter än. Klicka på ☆ på en serie, film eller kanal för att lägga till den. Kommer det nya avsnitt i en favoritserie markeras det här.',
      'No favourites yet. Click ☆ on a series, movie or channel to add it. New episodes of favourite series are marked here.')));
    return;
  }
  const asItem = (f) => ({ id: f.id, name: f.name, icon: f.icon, ext: f.ext, categoryId: f.categoryId, categoryName: f.categoryName });
  const section = (title, list, render) => list.length > 0 && h('div', { style: { marginBottom: '22px' } },
    h('div', { class: 'result-title' }, title, h('span', {}, `  ${list.length}`)),
    h('div', { class: 'hscroll' }, list.map(render)));
  const series = favs.filter((f) => f.type === 'series').sort((a, b) => (b.newCount || 0) - (a.newCount || 0));
  // EPG för favoritkanalerna (hämtas högst varannan minut).
  const liveIds = favs.filter((f) => f.type === 'live').map((f) => f.id);
  if (liveIds.length && Date.now() - app.favEpgAt > 120000 && !app.favEpgLoading) {
    app.favEpgLoading = true;
    api(`/api/live/epg?ids=${liveIds.map(enc).join(',')}`)
      .then((d) => { app.favEpg = d || {}; app.favEpgAt = Date.now(); if (app.view === 'browse' && app.tab === 'favorites') renderMain(); })
      .catch(() => { app.favEpgAt = Date.now(); })
      .finally(() => { app.favEpgLoading = false; });
  }
  const t = nowSec();
  fill(box, head, h('div', { class: 'scroll' }, remSection,
    section(tr('Serier', 'Series'), series, (f) => posterCard(asItem(f),
      () => openSeries(box, asItem(f), f.categoryId, () => renderMain()), null,
      { type: 'series', caption: f.newCount ? tr(`Nytt: ${f.newLabel}`, `New: ${f.newLabel}`) : null })),
    section(tr('Filmer', 'Movies'), favs.filter((f) => f.type === 'movie'), (f) => posterCard(asItem(f),
      () => cmd.load({ type: 'movie', id: f.id, ext: f.ext, title: cleanTitle(f.name), subtitle: yearFromTitle(f.name), icon: f.icon, categoryId: f.categoryId }),
      null, { type: 'movie' })),
    section(tr('Kanaler', 'Channels'), favs.filter((f) => f.type === 'live'), (f) => h('button', {
      class: 'row chcard',
      onclick: () => cmd.load({ type: 'live', id: f.id, ext: f.ext || 'ts', title: f.name, subtitle: f.categoryName, icon: f.icon, categoryId: f.categoryId }),
    }, thumb(f.icon, f.name), (() => {
      const progs = app.favEpg[f.id];
      const cur = progNow(progs, t), nxt = progNext(progs, t);
      const rem = nxt && reminderFor(f.id, nxt.start);
      return h('div', { style: { minWidth: '0', flex: '1' } },
        h('div', { class: 'ellipsis', style: { fontWeight: '500' } }, f.name),
        progs ? [
          h('div', { class: 'ellipsis', style: { fontSize: '13px', opacity: '.8', marginTop: '2px' } }, cur ? cur.title : tr('Ingen programinformation', 'No programme information')),
          cur && bar(progFrac(cur, t)),
          nxt && h('div', { class: `ellipsis ${rem ? 'gold' : 'faint'}`, style: { fontSize: '12px' } }, `${rem ? '🔔 ' : ''}${hhmm(nxt.start)}  ${nxt.title}`),
        ] : f.categoryName && h('div', { class: 'ellipsis', style: { fontSize: '13px', opacity: '.7' } }, f.categoryName));
    })(),
    guideButton(asItem(f), f.categoryName),
    favButton('live', asItem(f), f.categoryName)))));
}

// ---------------------------------------------------------------- historik

function whenText(ms) {
  const d = new Date(ms), today = new Date(), y = new Date(Date.now() - 86400e3);
  const same = (a, b) => a.toDateString() === b.toDateString();
  const t = hhmm(ms / 1000);
  if (same(d, today)) return tr(`idag ${t}`, `today ${t}`);
  if (same(d, y)) return tr(`igår ${t}`, `yesterday ${t}`);
  return `${d.toLocaleDateString(locale(), { day: 'numeric', month: 'short' })} ${t}`;
}

function histInfo(e) {
  const isLive = e.type === 'live';
  const finished = e.duration > 0 && e.position >= e.duration * 0.95;
  const resumable = !isLive && e.position > 60 && !finished;
  let remaining = null;
  if (e.duration > 0) {
    if (finished) remaining = tr('Sedd', 'Watched');
    else {
      const min = Math.max(1, Math.floor((e.duration - e.position) / 60));
      remaining = min >= 60 ? tr(`${Math.floor(min / 60)} h ${min % 60} min kvar`, `${Math.floor(min / 60)} h ${min % 60} min left`) : tr(`${min} min kvar`, `${min} min left`);
    }
  }
  return { isLive, finished, resumable, remaining, frac: e.duration > 0 ? clamp(e.position / e.duration, 0, 1) : 0 };
}

function renderHistory(main, alive) {
  const list = h('div', { class: 'panel scroll' }, msg(tr('Laddar…', 'Loading…')));
  const clearBtn = h('button', { class: 'btn', hidden: true, onclick: () => { cmd.historyClear(); draw([]); } }, tr('Rensa historik', 'Clear history'));
  main.append(h('div', { class: 'history' },
    h('div', { style: { display: 'flex', alignItems: 'baseline', padding: '0 12px 14px' } },
      h('span', { style: { fontSize: '24px', fontWeight: '700' } }, tr('Historik', 'History')),
      h('span', { class: 'faint', style: { fontSize: '16px', marginLeft: '16px' } }, tr('Det ni har tittat på tillsammans', 'What you\'ve watched together')),
      h('div', { style: { flex: '1' } }), clearBtn),
    list));

  function play(e, fromStart = false) {
    const { resumable } = histInfo(e);
    cmd.load(e, !fromStart && resumable ? e.position : 0);
  }

  function draw(entries) {
    clearBtn.hidden = !entries.length;
    if (!entries.length) {
      list.replaceChildren(msg(tr('Inget här än. Allt ni startar sparas här, och filmer och avsnitt kan fortsättas där ni slutade.', 'Nothing here yet. Everything you start is saved here, and movies and episodes can be resumed where you left off.')));
      return;
    }
    const playingKey = app.room?.media ? `${app.room.media.type}:${app.room.media.id}` : null;
    list.replaceChildren(...entries.map((e) => {
      const i = histInfo(e);
      const playing = e.key === playingKey;
      return h('div', { class: 'hrow' },
        h('button', { class: `row ${playing ? 'selected' : ''}`, onclick: () => play(e) },
          h('div', { class: 'pic' }, sized(i.isLive ? thumb(e.icon, e.title) : thumb(e.icon, e.title, { cover: true }),
            i.isLive ? 110 : 52, i.isLive ? 62 : 78)),
          h('div', { style: { flex: '1', minWidth: '0' } },
            h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } },
              h('span', { class: 'ellipsis', style: { fontSize: '17px', fontWeight: '600' } }, e.title),
              i.isLive && h('span', { class: 'badge-live' }, 'LIVE'),
              playing && h('span', { style: { fontSize: '13px' } }, tr('▶ Spelas nu', '▶ Playing now'))),
            e.subtitle && h('div', { class: 'ellipsis', style: { fontSize: '14px', opacity: '.7' } }, e.subtitle),
            h('div', { class: 'meta' },
              [e.startedBy && tr(`Startad av ${e.startedBy}`, `Started by ${e.startedBy}`), whenText(e.lastAt)].filter(Boolean).join('  ·  '),
              i.remaining && h('span', { class: i.finished ? 'done' : '', style: { marginLeft: '14px' } }, i.remaining)),
            !i.isLive && e.duration > 0 && h('div', { style: { width: '320px', marginTop: '6px' } }, bar(i.frac))),
          !i.isLive && h('span', { style: { fontSize: '14px', opacity: '.8' } }, i.resumable ? tr('Fortsätt', 'Resume') : tr('Spela', 'Play'))),
        i.resumable && h('button', { class: 'btn', onclick: () => play(e, true) }, tr('Från början', 'Start over')),
        h('button', { class: 'btn', onclick: () => { cmd.historyRemove(e.key); entries = entries.filter((x) => x.key !== e.key); draw(entries); } }, tr('Ta bort', 'Remove')));
    }));
  }

  const load = async () => {
    try { const entries = await API.history(); if (alive()) draw(entries); } catch (e) { if (alive()) list.replaceChildren(msg(tr(`Fel: ${e.message}`, `Error: ${e.message}`), true)); }
  };
  load();
  app.tabTimers.push(setInterval(load, 10e3));
}

// ============================================================ spelare

const video = $('#video');
video.preload = 'auto';

const P = {
  loadedUrl: null, mp: null, seekedVersion: -1, readyVersion: -1, cooldownUntil: 0, lastSeekAt: 0,
  correcting: false, livePaused: false, seekLead: 1, leadCheck: false, errorAt: 0, error: null,
  unsupported: false, status: '', needsSound: false, playPending: false,
};
const ui = { until: 0, panelOpen: false, pendingSeek: null, seekTimer: null, channels: [], epg: {}, refs: {}, dragging: false };
let tickTimer = null;

const absUrl = (u) => new URL(u, location.href).href;
const pnow = () => performance.now();
const duration = () => (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0);

function setRate(r) {
  if (Math.abs(video.playbackRate - r) > 0.004) video.playbackRate = r;
}

function tryPlay() {
  if (P.playPending || !video.paused) return;
  P.playPending = true;
  const p = video.play();
  if (!p) { P.playPending = false; return; }
  p.then(() => { P.playPending = false; }).catch((err) => {
    P.playPending = false;
    if (err.name === 'NotAllowedError' && !video.muted) {
      // Webbläsaren tillåter inte ljud utan ett klick – spela tyst och be om ett klick.
      video.muted = true;
      P.needsSound = true;
      buildPlayerUI();
      tryPlay();
    }
  });
}

function unloadMedia() {
  if (P.mp) {
    try { P.mp.pause(); P.mp.unload(); P.mp.detachMediaElement(); P.mp.destroy(); } catch {}
    P.mp = null;
  }
  video.pause();
  video.removeAttribute('src');
  video.load();
  P.loadedUrl = null;
}

function loadMedia(m, startAt) {
  unloadMedia();
  Object.assign(P, {
    loadedUrl: m.url, error: null, unsupported: false, readyVersion: -1, correcting: false, livePaused: false, leadCheck: false,
    cooldownUntil: pnow() + 1500,
  });
  video.playbackRate = 1;

  if (m.type === 'live') {
    if (window.mpegts && mpegts.getFeatureList().mseLivePlayback) {
      P.mp = mpegts.createPlayer({ type: 'mpegts', isLive: true, url: absUrl(m.url) }, {
        enableWorker: true, lazyLoad: false,
        liveBufferLatencyChasing: true, liveBufferLatencyMaxLatency: 8, liveBufferLatencyMinRemain: 3,
      });
      P.mp.on(mpegts.Events.ERROR, (type, detail) => { P.error = `${type} / ${detail}`; P.errorAt = pnow(); });
      P.mp.attachMediaElement(video);
      P.mp.load();
      tryPlay();
    } else {
      P.unsupported = true;
      P.error = tr('Den här webbläsaren kan inte spela live-TV (saknar Media Source Extensions).', 'This browser can\'t play live TV (it lacks Media Source Extensions).');
    }
  } else {
    video.src = m.url;
    if (startAt > 0) video.currentTime = startAt;
  }
}

video.addEventListener('error', () => {
  const e = video.error;
  if (!e || !P.loadedUrl || P.mp) return;
  if (e.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED || e.code === MediaError.MEDIA_ERR_DECODE) {
    P.unsupported = true;
    P.error = tr('Webbläsaren kan inte spela det här formatet. Filer med AC3/DTS-ljud eller HEVC/4K fungerar oftast bara i TV-apparna. Testa Chrome eller Edge.', 'Your browser can\'t play this format. Files with AC3/DTS audio or HEVC/4K usually only work in the TV apps. Try Chrome or Edge.');
    buildPlayerUI();
  } else {
    P.error = tr('Nätverksfel', 'Network error');
    P.errorAt = pnow();
  }
});

function tick() {
  const st = app.room, m = st?.media;
  if (app.view !== 'player' || !m) return;
  const now = pnow();

  if (m.url !== P.loadedUrl) {
    let start = 0;
    if (m.type !== 'live') {
      start = st.paused || serverNow() < st.refTime ? st.position : st.position + (serverNow() - st.refTime) / 1000 + P.seekLead;
    }
    loadMedia(m, start);
    P.seekedVersion = st.version;
    P.lastSeekAt = now;
    return;
  }

  if (P.unsupported) {
    P.status = '';
    // Blockera inte de andra: säg att vi är redo ändå.
    if (st.waiting && P.readyVersion !== st.version) { cmd.ready(st.version, 0); P.readyVersion = st.version; }
    return;
  }
  if (P.error) {
    P.status = tr('Uppspelningsfel – försöker igen…', 'Playback error – retrying…');
    if (now - P.errorAt > 3000) { P.error = null; P.loadedUrl = null; }
    return;
  }

  if (m.type === 'live') {
    setRate(1);
    if (st.paused) { if (!video.paused) video.pause(); P.livePaused = true; P.status = tr('Pausad', 'Paused'); return; }
    if (P.livePaused) { P.livePaused = false; P.loadedUrl = null; return; } // tillbaka till live
    tryPlay();
    P.status = video.readyState < 3 ? tr('Buffrar…', 'Buffering…') : '';
    return;
  }

  const pos = video.currentTime;
  if (st.paused) {
    if (!video.paused) video.pause();
    setRate(1);
    P.correcting = false;
    const needSeek = Math.abs(pos - st.position) > 0.25;
    if (P.seekedVersion !== st.version || (needSeek && video.readyState >= 1 && !video.seeking && now - P.lastSeekAt > 1500)) {
      if (needSeek) { video.currentTime = st.position; P.lastSeekAt = now; }
      P.seekedVersion = st.version;
      return;
    }
    if (st.waiting) {
      P.status = tr('Väntar på att alla ska bli redo…', 'Waiting for everyone to be ready…');
      const loaded = video.readyState >= 3 || (video.readyState >= 2 && now - P.lastSeekAt > 2000);
      if (P.readyVersion !== st.version && loaded && !video.seeking && now - P.lastSeekAt > 300) {
        cmd.ready(st.version, duration());
        P.readyVersion = st.version;
      }
    } else P.status = tr('Pausad', 'Paused');
    return;
  }

  const sn = serverNow();
  if (sn < st.refTime) {
    if (!video.paused) video.pause();
    if (Math.abs(pos - st.position) > 0.5 && now - P.lastSeekAt > 1000) { video.currentTime = st.position; P.lastSeekAt = now; }
    P.status = tr('Startar…', 'Starting…');
    return;
  }
  const target = st.position + (sn - st.refTime) / 1000;
  tryPlay();
  if (video.readyState < 3 || video.seeking) { P.status = tr('Buffrar…', 'Buffering…'); return; }
  if (now < P.cooldownUntil) return;
  const d = pos - target;
  if (P.leadCheck) { P.seekLead = clamp(P.seekLead - d * 0.7, 0.3, 6); P.leadCheck = false; }
  const du = duration();
  if (du > 0 && target > du) { P.status = tr('Slut', 'Ended'); return; }
  if (Math.abs(d) > 2) {
    setRate(1);
    P.correcting = false;
    video.currentTime = target + P.seekLead;
    P.lastSeekAt = now;
    P.cooldownUntil = now + 2500;
    P.leadCheck = true;
    P.status = tr('Synkar…', 'Syncing…');
  } else if (Math.abs(d) > 0.3 || (P.correcting && Math.abs(d) > 0.06)) {
    P.correcting = true;
    setRate(clamp(1 - d / 3, 0.92, 1.08));
    P.status = '';
  } else {
    P.correcting = false;
    setRate(1);
    P.status = '';
  }
}

// ---------------------------------------------------------------- öppna/stäng

async function loadChannelData() {
  const m = app.room?.media;
  if (m?.type !== 'live' || !m.categoryId) { ui.channels = []; ui.epg = {}; return; }
  try { ui.channels = await API.items('live', m.categoryId); } catch { ui.channels = []; }
  try { ui.epg = await API.epg(m.categoryId); } catch {}
  buildPlayerUI();
}

function openPlayer() {
  if (!app.room?.media) return;
  const wasPlayer = app.view === 'player';
  app.view = 'player';
  $('#browse').hidden = true;
  $('#player').hidden = false;
  if (!wasPlayer) cmd.watching(true);
  ui.panelOpen = false;
  pokeUI();
  loadChannelData();
  buildPlayerUI();
  let n = 0;
  if (!tickTimer) tickTimer = setInterval(() => {
    tick();
    updatePlayerUI();
    if (++n % 8 === 0) send({ type: 'report', position: video.currentTime, status: P.status, at: serverNow() });
  }, 250);
}

function closePlayer() {
  if (app.view !== 'player') return;
  cmd.watching(false);
  clearInterval(tickTimer);
  tickTimer = null;
  unloadMedia();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  showBrowse();
}

function pokeUI() { ui.until = Date.now() + 4000; }

// ---------------------------------------------------------------- spelarens UI

const actionTexts = () => ({
  load: tr('startade', 'started'), play: tr('tryckte play', 'pressed play'), start: tr('tryckte play', 'pressed play'),
  pause: tr('pausade', 'paused'), seek: tr('spolade', 'skipped'),
});

function nudge(delta) {
  const m = app.room?.media;
  if (!m || m.type === 'live') return;
  const du = duration();
  ui.pendingSeek = clamp((ui.pendingSeek ?? video.currentTime) + delta, 0, du > 0 ? du - 1 : Infinity);
  pokeUI();
  clearTimeout(ui.seekTimer);
  ui.seekTimer = setTimeout(() => {
    if (ui.pendingSeek != null) cmd.seek(ui.pendingSeek);
    setTimeout(() => { ui.pendingSeek = null; }, 600);
  }, 800);
}

function loadChannel(item) {
  const m = app.room?.media;
  if (!m) return;
  cmd.load({ type: 'live', id: item.id, ext: item.ext, title: item.name, subtitle: m.subtitle, icon: item.icon, categoryId: m.categoryId });
}

function zap(dir) {
  const m = app.room?.media;
  if (m?.type !== 'live' || ui.channels.length < 2) return;
  const i = ui.channels.findIndex((c) => c.id === m.id);
  if (i >= 0) loadChannel(ui.channels[(i + dir + ui.channels.length) % ui.channels.length]);
}

function openCurrentGuide() {
  const m = app.room?.media;
  if (!m || m.type !== 'live') return;
  const ch = ui.channels.find((c) => c.id === m.id) || { id: m.id, name: m.title, icon: m.icon, ext: m.ext };
  openGuide({ ...ch, categoryId: m.categoryId }, m.subtitle);
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else $('#player').requestFullscreen().catch(() => {});
}

function volumeControls() {
  return [
    h('button', { class: 'icon-btn', title: tr('Ljud av/på (M)', 'Sound on/off (M)'), onclick: () => { video.muted = !video.muted; P.needsSound = false; buildPlayerUI(); } }, video.muted ? '🔇' : '🔊'),
    h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: video.volume, style: { width: '110px' }, oninput: (e) => { video.volume = Number(e.target.value); video.muted = false; } }),
    h('button', { class: 'icon-btn', title: tr('Helskärm (F)', 'Full screen (F)'), onclick: toggleFullscreen }, '⛶'),
  ];
}

function openPanel() {
  ui.panelOpen = true;
  buildPlayerUI();
  requestAnimationFrame(() => {
    const cur = document.querySelector('.panel-ch .row.selected') || document.querySelector('.panel-ch .row');
    cur?.scrollIntoView({ block: 'center' });
    cur?.focus();
  });
}

function closePanel() {
  ui.panelOpen = false;
  buildPlayerUI();
}

/** Bygger spelarens overlay (vid tillståndsändring). Tid/förlopp uppdateras i updatePlayerUI. */
function buildPlayerUI() {
  const root = $('#player-ui');
  const st = app.room, m = st?.media;
  if (app.view !== 'player' || !st || !m) { root.replaceChildren(); return; }
  const refs = (ui.refs = {});
  const live = m.type === 'live';
  const watching = app.members.filter((x) => x.watching);

  const top = h('div', { class: 'p-top' },
    h('button', { class: 'icon-btn', onclick: closePlayer, title: tr('Till menyn (Esc)', 'Back to menu (Esc)') }, tr('← Meny', '← Menu')),
    st.changedBy && actionTexts()[st.action] && h('div', { class: 'p-who' }, h('b', {}, st.changedBy), h('span', {}, ` ${actionTexts()[st.action]}`)),
    h('div', { style: { flex: '1' } }),
    viewersChip(watching),
    h('div', { class: 'clock' }, hhmm(nowSec())));

  let bottom;
  if (live) {
    const ch = ui.channels.find((c) => c.id === m.id);
    refs.liveProg = h('div');
    bottom = h('div', { class: 'p-bottom' },
      h('div', { class: 'p-live-head' },
        thumb(m.icon, m.title, { cls: 'logo' }),
        h('div', { style: { flex: '1', minWidth: '0' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
            ch?.num != null && h('span', { class: 'muted', style: { fontSize: '20px' } }, ch.num),
            h('span', { class: 'p-title ellipsis' }, m.title),
            h('span', { class: 'badge-live' }, 'LIVE')),
          refs.liveProg)),
      h('div', { class: 'p-controls' },
        h('button', { class: 'icon-btn', onclick: openPanel, title: tr('Kanallista (Enter / ←)', 'Channel list (Enter / ←)') }, tr('☰ Kanaler', '☰ Channels')),
        h('button', { class: 'icon-btn', onclick: openCurrentGuide, title: tr('Tablå och påminnelser (G)', 'Guide and reminders (G)') }, tr('📅 Tablå', '📅 Guide')),
        h('button', { class: 'icon-btn', onclick: () => zap(-1), title: tr('Föregående kanal (↑)', 'Previous channel (↑)') }, '▲'),
        h('button', { class: 'icon-btn', onclick: () => zap(1), title: tr('Nästa kanal (↓)', 'Next channel (↓)') }, '▼'),
        h('button', { class: 'icon-btn', onclick: () => { cmd.toggle(); pokeUI(); }, title: tr('Paus (mellanslag)', 'Pause (space)') }, st.paused ? '▶' : '❚❚'),
        refs.status = h('span', { class: 'p-status' }),
        h('div', { class: 'grow' }),
        h('span', { class: 'faint', style: { fontSize: '13px' } }, tr('Enter kanallista · ↑↓ byt kanal · Mellanslag paus · F helskärm · Esc meny', 'Enter channel list · ↑↓ change channel · Space pause · F full screen · Esc menu')),
        volumeControls()));
  } else {
    refs.seek = h('input', {
      type: 'range', class: 'seek', min: 0, max: 1, step: 1, value: 0,
      onpointerdown: () => { ui.dragging = true; },
      oninput: (e) => { ui.pendingSeek = Number(e.target.value); pokeUI(); },
      onchange: (e) => {
        ui.dragging = false;
        cmd.seek(Number(e.target.value));
        setTimeout(() => { ui.pendingSeek = null; }, 600);
      },
    });
    bottom = h('div', { class: 'p-bottom' },
      h('div', { class: 'p-title ellipsis' }, m.title),
      m.subtitle && h('div', { class: 'p-sub ellipsis' }, m.subtitle),
      refs.seek,
      h('div', { class: 'p-controls' },
        h('button', { class: 'icon-btn', onclick: () => nudge(-10), title: tr('Bakåt 10 s (←)', 'Back 10 s (←)') }, '⟲ 10'),
        h('button', { class: 'icon-btn', onclick: () => { cmd.toggle(); pokeUI(); }, title: tr('Paus (mellanslag)', 'Pause (space)') }, st.paused && !st.waiting ? '▶' : '❚❚'),
        h('button', { class: 'icon-btn', onclick: () => nudge(10), title: tr('Framåt 10 s (→)', 'Forward 10 s (→)') }, '10 ⟳'),
        refs.time = h('span', { class: 'time' }),
        refs.status = h('span', { class: 'p-status' }),
        h('div', { class: 'grow' }),
        h('span', { class: 'faint', style: { fontSize: '13px' } }, tr('Mellanslag paus · ←→ spola · F helskärm · Esc meny', 'Space pause · ←→ skip · F full screen · Esc menu')),
        refs.remaining = h('span', { class: 'time muted' }),
        volumeControls()));
  }

  const kids = [top, bottom];
  if (!live && st.paused && !st.waiting) kids.push(h('div', { class: 'p-pause' }, '❚❚'));
  kids.push(refs.chip = h('div', { class: 'p-chip', hidden: true }));
  if (P.unsupported) {
    kids.push(h('div', { class: 'p-banner' },
      h('div', { style: { fontSize: '18px', fontWeight: '600', marginBottom: '8px' } }, tr('Kan inte spelas i webbläsaren', 'Can\'t be played in the browser')),
      h('div', { class: 'muted' }, P.error),
      h('div', { style: { marginTop: '16px' } }, h('button', { class: 'btn primary', onclick: closePlayer }, tr('Tillbaka till menyn', 'Back to menu')))));
  } else if (P.needsSound) {
    kids.push(h('div', { class: 'p-banner' },
      h('button', { class: 'btn primary', onclick: () => { video.muted = false; P.needsSound = false; buildPlayerUI(); } }, tr('🔊  Klicka för att slå på ljudet', '🔊  Click to turn on sound'))));
  }
  if (st.upNext?.media) {
    const n = st.upNext.media;
    kids.push(h('div', { class: 'p-upnext' },
      thumb(n.icon, n.title, { cover: true, cls: 'pic' }),
      h('div', { class: 'body' },
        h('div', { class: 'label', style: { padding: '0', color: 'var(--accent)' } }, tr('Nästa avsnitt', 'Next episode')),
        h('div', { class: 'ellipsis', style: { fontSize: '18px', fontWeight: '600' } }, n.title),
        n.subtitle && h('div', { class: 'ellipsis muted' }, n.subtitle),
        refs.upNextCount = h('div', { class: 'faint', style: { fontSize: '13px', marginTop: '6px' } }),
        h('div', { style: { display: 'flex', gap: '8px', marginTop: '10px' } },
          h('button', { class: 'btn primary', onclick: () => cmd.nextNow() }, tr('Spela nu', 'Play now')),
          h('button', { class: 'btn', onclick: () => cmd.nextCancel() }, tr('Avbryt', 'Cancel'))))));
  }
  if (live) {
    const t = nowSec();
    const panel = h('div', { class: `panel-ch ${ui.panelOpen ? 'open' : ''}` },
      h('header', {}, m.subtitle || tr('Kanaler', 'Channels'), h('div', { class: 'spacer' }), h('button', { class: 'icon-btn', onclick: closePanel }, '✕')),
      h('div', { class: 'scroll' }, ui.channels.length
        ? ui.channels.map((c) => channelRow(c, ui.epg[c.id], t, c.id === m.id, { onclick: () => { loadChannel(c); closePanel(); }, fav: false }))
        : msg(tr('Laddar kanaler…', 'Loading channels…'))));
    kids.push(panel);
  }
  root.replaceChildren(...kids);
  updatePlayerUI();
}

/** Uppdaterar det som ändras hela tiden (tid, förlopp, status, om overlayn syns). */
function updatePlayerUI() {
  const st = app.room, m = st?.media, refs = ui.refs;
  if (app.view !== 'player' || !m) return;
  const playerEl = $('#player');
  const show = Date.now() < ui.until || (st.paused && !st.waiting) || ui.pendingSeek != null || ui.panelOpen || P.needsSound || P.unsupported;
  playerEl.classList.toggle('hide-ui', !show);
  playerEl.classList.toggle('idle', !show);
  if (refs.chip) {
    refs.chip.hidden = show || !P.status;
    refs.chip.textContent = P.status;
  }
  if (refs.status) refs.status.textContent = P.status;
  if (refs.upNextCount && st.upNext) {
    const left = Math.max(0, Math.ceil((st.upNext.startsAt - serverNow()) / 1000));
    refs.upNextCount.textContent = tr(`Startar om ${left} s  ·  Enter spela nu  ·  Esc avbryt`, `Starts in ${left} s  ·  Enter play now  ·  Esc cancel`);
  }
  if (m.type === 'live') {
    if (refs.liveProg) {
      const t = nowSec();
      const list = ui.epg[m.id];
      const cur = progNow(list, t), nxt = progNext(list, t);
      const sig = `${cur?.start}|${nxt?.start}|${Math.floor(t / 15)}`;
      if (refs.liveProg.dataset.sig !== sig) {
        refs.liveProg.dataset.sig = sig;
        fill(refs.liveProg,
          h('div', { style: { fontSize: '19px', marginTop: '6px' }, class: cur ? '' : 'faint' }, cur ? cur.title : tr('Ingen programinformation', 'No programme information')),
          cur && h('div', { class: 'times' }, hhmm(cur.start), bar(progFrac(cur, t)), hhmm(cur.end)),
          nxt && h('div', { class: 'muted', style: { marginTop: '8px' } }, tr(`Härnäst  ${hhmm(nxt.start)}  ${nxt.title}`, `Up next  ${hhmm(nxt.start)}  ${nxt.title}`)));
      }
    }
    return;
  }
  const du = duration();
  const pos = ui.pendingSeek ?? video.currentTime;
  if (refs.seek && !ui.dragging) {
    refs.seek.max = du || 1;
    refs.seek.value = pos;
    refs.seek.classList.toggle('seeking', ui.pendingSeek != null);
  }
  if (refs.time) refs.time.textContent = formatTime(pos);
  if (refs.remaining) refs.remaining.textContent = du > 0 ? `-${formatTime(du - pos)}` : '';
}

// Mus och tangentbord i spelaren
$('#player').addEventListener('mousemove', pokeUI);
video.addEventListener('click', () => {
  if (P.needsSound) { video.muted = false; P.needsSound = false; buildPlayerUI(); return; }
  if (app.room?.media?.type === 'live') { pokeUI(); return; }
  cmd.toggle();
  pokeUI();
});
video.addEventListener('dblclick', toggleFullscreen);

document.addEventListener('keydown', (e) => {
  if (app.view !== 'player') return;
  if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
  const live = app.room?.media?.type === 'live';
  if (ui.panelOpen) {
    const rows = [...document.querySelectorAll('.panel-ch .row')];
    const i = rows.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = rows[clamp((i < 0 ? 0 : i) + (e.key === 'ArrowDown' ? 1 : -1), 0, rows.length - 1)];
      next?.focus();
      next?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Escape' || e.key === 'ArrowRight') {
      e.preventDefault();
      closePanel();
    }
    return;
  }
  if (app.room?.upNext) {
    if (e.key === 'Enter') { e.preventDefault(); cmd.nextNow(); return; }
    if (e.key === 'Escape') { e.preventDefault(); cmd.nextCancel(); return; }
  }
  pokeUI();
  switch (e.key) {
    case ' ': case 'k': e.preventDefault(); cmd.toggle(); break;
    case 'ArrowLeft': e.preventDefault(); if (live) openPanel(); else nudge(-10); break;
    case 'ArrowRight': e.preventDefault(); if (!live) nudge(10); break;
    case 'ArrowUp': e.preventDefault(); if (live) zap(-1); break;
    case 'ArrowDown': e.preventDefault(); if (live) zap(1); break;
    case 'Enter': if (live && document.activeElement === document.body) { e.preventDefault(); openPanel(); } break;
    case 'f': case 'F': toggleFullscreen(); break;
    case 'g': case 'G': if (live) openCurrentGuide(); break;
    case 'm': case 'M': video.muted = !video.muted; P.needsSound = false; buildPlayerUI(); break;
    case 'Escape': if (!document.fullscreenElement) closePlayer(); break;
  }
});

// ============================================================ start

(async function init() {
  document.documentElement.lang = lang;
  applyStaticTexts();
  if (app.pin || app.name) {
    try {
      await tryLogin(app.pin, app.name || tr('Gäst', 'Guest'));
      startApp();
      return;
    } catch (e) {
      showLogin(e.message === tr('Fel PIN-kod', 'Wrong PIN') ? tr('Fel PIN-kod', 'Wrong PIN') : tr(`Kunde inte ansluta: ${e.message}`, `Couldn't connect: ${e.message}`));
      return;
    }
  }
  showLogin();
})();
