// Couchmate admin – login, overview, the room, settings, plugins, data, downloads, the log and the account.
'use strict';

const $ = (s) => document.querySelector(s);
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
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const fill = (el, ...kids) => { el.replaceChildren(...kids.flat(Infinity).filter((c) => c != null && c !== false)); return el; };

const ICONS = {
  overview: 'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z',
  settings: 'M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87a.47.47 0 0 0 .12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.47.47 0 0 0-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z',
  data: 'M12 3C7.58 3 4 4.79 4 7v10c0 2.21 3.59 4 8 4s8-1.79 8-4V7c0-2.21-3.58-4-8-4zm0 2c3.87 0 6 1.5 6 2s-2.13 2-6 2-6-1.5-6-2 2.13-2 6-2zm6 12c0 .5-2.13 2-6 2s-6-1.5-6-2v-2.23c1.61.78 3.72 1.23 6 1.23s4.39-.45 6-1.23V17zm0-5c0 .5-2.13 2-6 2s-6-1.5-6-2V9.77c1.61.78 3.72 1.23 6 1.23s4.39-.45 6-1.23V12z',
  downloads: 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z',
  menu: 'M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z',
  translations: 'M12.87 15.07l-2.54-2.51.03-.03A17.52 17.52 0 0 0 14.07 6H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z',
  plugins: 'M20.5 11H19V7a2 2 0 0 0-2-2h-4V3.5a2.5 2.5 0 0 0-5 0V5H4a2 2 0 0 0-2 2v3.8h1.5a2.7 2.7 0 0 1 0 5.4H2V20a2 2 0 0 0 2 2h3.8v-1.5a2.7 2.7 0 0 1 5.4 0V22H17a2 2 0 0 0 2-2v-4h1.5a2.5 2.5 0 0 0 0-5z',
  logs: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z',
  account: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
};
const icon = (name) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = `<path fill="currentColor" d="${ICONS[name]}"/>`;
  return s;
};

// ---------------------------------------------------------------- helpers

async function api(path, { method = 'GET', body, raw } = {}) {
  const r = await fetch(`/admin/api${path}`, {
    method,
    headers: raw ? { 'content-type': 'application/octet-stream' } : body !== undefined ? { 'content-type': 'application/json' } : {},
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    credentials: 'same-origin',
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/login' && path !== '/setup') { start(); throw new Error('Not logged in'); }
  if (!r.ok) throw Object.assign(new Error(data.error || `Error ${r.status}`), { status: r.status, data });
  return data;
}

let toastTimer = null;
function toast(text, bad = false) {
  const t = $('#toast');
  t.textContent = text;
  t.className = bad ? 'bad' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 6000 : 3000);
}
const run = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

const fmtTime = (sec) => {
  const s = Math.max(0, Math.floor(sec || 0));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
};
const fmtSize = (n) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`);
const fmtAgo = (ms) => {
  if (!ms) return '–';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const fmtUptime = (s) => (s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h`);
const fmtDate = (sec) => new Date(sec * 1000).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
/** Plain text of something a plugin sent (api.t() text arrives as { $t }). */
const txt = (v) => (v && typeof v === 'object' && typeof v.$t === 'string' ? v.$t : v ?? '');

/** A button that needs a second click to confirm (no dialogs). */
function confirmBtn(label, confirmLabel, onConfirm, cls = 'btn danger small') {
  const b = h('button', { class: cls, type: 'button' }, label);
  let armed = null;
  b.addEventListener('click', run(async () => {
    if (!armed) {
      b.textContent = confirmLabel;
      armed = setTimeout(() => { armed = null; b.textContent = label; }, 3500);
      return;
    }
    clearTimeout(armed);
    armed = null;
    b.disabled = true;
    try { await onConfirm(); } finally { b.disabled = false; b.textContent = label; }
  }));
  return b;
}

/** A popup on top of the page. Esc, the backdrop or the returned function closes it. */
function modal(title, body, actions = []) {
  const back = h('div', { class: 'modal-back' });
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey);
  fill(back, h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-head' }, h('h3', {}, title), h('button', { class: 'btn small', type: 'button', 'aria-label': 'Close', onclick: close }, '✕')),
    h('div', { class: 'modal-body' }, body),
    actions.length ? h('div', { class: 'modal-foot' }, actions) : null));
  document.body.append(back);
  back.querySelector('input, select, textarea')?.focus();
  return close;
}

// ---------------------------------------------------------------- login

async function start() {
  stopTimers();
  const s = await fetch('/admin/api/session', { credentials: 'same-origin' }).then((r) => r.json());
  if (s.loggedIn) return shell();
  const err = h('p', { class: 'error', role: 'alert' });
  const setup = s.setupNeeded;
  const pw = h('input', { type: 'password', id: 'pw', autocomplete: setup ? 'new-password' : 'current-password', placeholder: setup ? 'At least 8 characters' : 'Admin password' });
  const pw2 = h('input', { type: 'password', id: 'pw2', autocomplete: 'new-password', placeholder: 'The same password again' });
  const form = h('form', { class: 'auth-form', onsubmit: run(async (e) => {
    e.preventDefault();
    err.textContent = '';
    try {
      if (setup) {
        if (pw.value !== pw2.value) throw new Error('The passwords do not match');
        await api('/setup', { method: 'POST', body: { password: pw.value } });
      } else {
        await api('/login', { method: 'POST', body: { password: pw.value } });
      }
      shell();
    } catch (x) { err.textContent = x.message; }
  }) },
  h('h1', {}, 'Couch', h('span', { class: 'brand-a' }, 'mate'), h('span', { class: 'faint', style: { fontWeight: 400 } }, ' admin')),
  setup
    ? h('p', {}, 'Welcome! Start by creating the admin password. It protects this panel, where you set the PIN code for the apps and choose plugins.')
    : h('p', {}, 'Log in with the admin password.'),
  h('label', { for: 'pw', class: 'muted' }, setup ? 'New admin password' : 'Password'), pw,
  setup && h('label', { for: 'pw2', class: 'muted' }, 'Repeat the password'), setup && pw2,
  h('button', { class: 'btn primary', type: 'submit', style: { justifyContent: 'center', marginTop: '6px' } }, setup ? 'Create and log in' : 'Log in'),
  err);
  fill($('#app'), h('div', { class: 'auth' }, form));
  pw.focus();
}

// ---------------------------------------------------------------- shell + navigation

const PAGES = [
  ['overview', 'Overview', renderOverview],
  ['settings', 'Settings', renderSettings],
  ['plugins', 'Plugins', renderPlugins],
  ['menu', 'App menu', renderMenu],
  ['translations', 'Translations', renderTranslations],
  ['data', 'Reminders and data', renderData],
  ['downloads', 'Downloads', renderDownloads],
  ['logs', 'Log', renderLogs],
  ['account', 'Account', renderAccount],
];
let page = (location.hash || '#overview').slice(1);
let timers = [];
const stopTimers = () => { timers.forEach((t) => (typeof t === 'function' ? t() : clearInterval(t))); timers = []; };

function shell() {
  const main = h('main', { class: 'main', id: 'main' });
  const side = h('nav', { class: 'side', 'aria-label': 'Menu' },
    h('div', { class: 'brand' }, h('span', { class: 'logo' }), h('div', {}, h('span', {}, 'Couch', h('span', { class: 'brand-a' }, 'mate')), h('small', {}, 'Admin'))),
    PAGES.map(([id, label]) => h('button', { class: `nav ${page === id ? 'on' : ''}`, 'data-page': id, onclick: () => go(id) }, icon(id), h('span', {}, label))),
    h('div', { class: 'spacer' }),
    h('div', { class: 'foot' }, h('a', { href: '/download', target: '_blank', rel: 'noopener' }, 'Download page ↗')));
  fill($('#app'), h('div', { class: 'shell' }, side, main));
  go(PAGES.some(([id]) => id === page) ? page : 'overview');
}

function go(id) {
  stopTimers();
  page = id;
  history.replaceState(null, '', `#${id}`);
  document.querySelectorAll('.nav').forEach((n) => n.classList.toggle('on', n.dataset.page === id));
  const [, label, render] = PAGES.find(([p]) => p === id);
  document.title = `${label} – Couchmate admin`;
  const main = $('#main');
  fill(main, h('p', { class: 'faint' }, 'Loading…'));
  run(render)(main);
}

const head = (title, text, ...actions) => h('div', { class: 'page-head' }, h('h2', {}, title), text && h('p', {}, text), ...actions);
const link = (label, target) => h('a', { href: `#${target}`, onclick: (ev) => { ev.preventDefault(); go(target); } }, label);

// ---------------------------------------------------------------- overview

async function renderOverview(main) {
  const setupCard = h('section', { class: 'card wide', hidden: true });
  const nowCard = h('section', { class: 'card wide' });
  const members = h('section', { class: 'card wide' });
  const server = h('section', { class: 'card' });
  const plug = h('section', { class: 'card' });
  fill(main, head('Overview', 'What is happening in the room right now. Updates every other second.'), h('div', { class: 'grid' }, setupCard, nowCard, members, server, plug));

  const update = async () => {
    const d = await api('/overview');
    const st = d.state, m = st.media;
    const skew = Date.now() - d.serverNow;
    const live = Boolean(m?.live);
    const pos = m && !live ? (st.paused ? st.position : st.position + Math.max(0, (Date.now() - skew - st.refTime) / 1000)) : 0;
    const dur = m && st.duration;

    // Getting started: shown until the apps can connect and there is something to watch.
    const steps = [
      [d.setup.pin, 'Set a PIN code for the apps', 'settings'],
      [d.setup.plugins, 'Install and switch on at least one plugin, e.g. IPTV or Twitch', 'plugins'],
    ];
    setupCard.hidden = steps.every(([done]) => done);
    fill(setupCard, h('h3', {}, 'Get started'), h('ol', { class: 'steps' },
      steps.map(([done, label, target]) => h('li', { class: done ? 'done' : '' }, done ? h('s', {}, label) : link(label, target)))));

    fill(nowCard, h('h3', {}, 'Now playing', h('span', { class: 'grow' }),
      live ? h('span', { class: 'pill live' }, 'LIVE') : null,
      m && h('span', { class: `pill ${st.waiting ? 'warn' : st.paused ? '' : 'ok'}` }, st.waiting ? 'Waiting for everyone' : st.paused ? 'Paused' : 'Playing')),
    m ? h('div', { class: 'now' },
      h('div', { class: 'art', style: /^https?:/.test(m.image || '') ? { backgroundImage: `url("${m.image}")` } : {} }),
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('div', { class: 'title' }, txt(m.title)),
        h('div', { class: 'muted' }, [txt(m.subtitle), m.plugin, st.changedBy && `started by ${st.changedBy}`].filter(Boolean).join('  ·  ')),
        !live && h('div', { class: 'row', style: { marginTop: '10px' } },
          h('span', { class: 'faint', style: { fontVariantNumeric: 'tabular-nums' } }, fmtTime(pos)),
          dur ? h('div', { class: 'bar', style: { flex: 1, maxWidth: '360px' } }, h('i', { style: { width: `${Math.min(100, (pos / dur) * 100)}%` } })) : null),
        h('div', { class: 'row controls' },
          st.paused
            ? h('button', { class: 'btn primary small', onclick: run(() => api('/room/play', { method: 'POST', body: {} }).then(update)) }, '▶ Play')
            : h('button', { class: 'btn small', onclick: run(() => api('/room/pause', { method: 'POST', body: {} }).then(update)) }, '❚❚ Pause'),
          !live && h('button', { class: 'btn small', onclick: run(() => api('/room/seek', { method: 'POST', body: { position: Math.max(0, pos - 30) } }).then(update)) }, '−30 s'),
          !live && h('button', { class: 'btn small', onclick: run(() => api('/room/seek', { method: 'POST', body: { position: pos + 30 } }).then(update)) }, '+30 s'),
          confirmBtn('■ Stop for everyone', 'Click again to stop', () => api('/room/stop', { method: 'POST', body: {} }).then(update)))))
      : h('p', { class: 'empty' }, 'Nothing is playing right now.'),
    st.reminder && h('p', { class: 'notice', style: { marginTop: '14px' } }, h('b', {}, 'Reminder: '),
      `${st.reminder.title} – switching to ${st.reminder.channel?.title} in ${Math.max(0, Math.round((st.reminder.switchAt - d.serverNow) / 1000))} s`));

    fill(members, h('h3', {}, `Connected  ${d.members.length}`),
      d.members.length ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Device'), h('th', {}, 'Language'), h('th', {}, 'Mode'), h('th', {}, 'Sync'), h('th', {}, 'Status'), h('th', {}, 'Last report'), h('th', {}))),
        h('tbody', {}, d.members.map((x) => {
          const drift = x.drift == null ? null : Math.round(x.drift * 1000);
          const cls = drift == null ? 'faint' : Math.abs(drift) < 300 ? 'drift-ok' : Math.abs(drift) < 1000 ? 'drift-warn' : 'drift-bad';
          return h('tr', {},
            h('td', {}, h('b', {}, x.name)),
            h('td', { class: 'muted' }, x.device || '–'),
            h('td', { class: 'muted' }, x.lang || 'en'),
            h('td', {}, h('span', { class: `pill ${x.watching ? 'ok' : ''}` }, x.watching ? 'Watching' : 'Browsing')),
            h('td', { class: `num ${cls}` }, drift == null ? '–' : `${drift > 0 ? '+' : ''}${drift} ms`),
            h('td', { class: 'muted' }, x.status || '–'),
            h('td', { class: 'faint' }, x.reportAge == null ? '–' : `${x.reportAge} s ago`),
            h('td', { class: 'act' }, confirmBtn('Disconnect', 'Sure?', () => api('/room/kick', { method: 'POST', body: { id: x.id } }).then(update))));
        })))) : h('p', { class: 'empty' }, 'No one is connected.'));

    fill(server, h('h3', {}, 'Server'), h('dl', { class: 'kv' },
      h('dt', {}, 'Version'), h('dd', {}, d.server.version),
      h('dt', {}, 'Up for'), h('dd', {}, fmtUptime(d.server.uptime)),
      h('dt', {}, 'Memory'), h('dd', {}, fmtSize(d.server.rss)),
      h('dt', {}, 'Node'), h('dd', {}, d.server.node),
      h('dt', {}, 'Favourites'), h('dd', {}, d.counts.favorites),
      h('dt', {}, 'Reminders'), h('dd', {}, d.counts.reminders),
      h('dt', {}, 'History'), h('dd', {}, d.counts.history)));

    fill(plug, h('h3', {}, 'Plugins', h('span', { class: 'grow' }), h('button', { class: 'btn small', onclick: () => go('plugins') }, 'Manage')),
      d.plugins.length ? h('div', { class: 'chips' }, d.plugins.map((p) => h('span', { class: `pill ${p.error ? 'bad' : p.enabled ? 'ok' : ''}` }, h('span', { class: 'dot' }), p.name)))
        : h('p', { class: 'empty' }, 'No plugins installed.'));
  };
  await update();
  timers.push(setInterval(run(update), 2000));
}

// ---------------------------------------------------------------- settings

/** An input for a setting (server or plugin): text | secret | number | bool | select. */
function settingField(idPrefix, s, inputs) {
  const id = `${idPrefix}-${s.key}`;
  let input;
  if (s.type === 'bool') {
    const cb = h('input', { type: 'checkbox', id, checked: Boolean(s.value) });
    input = h('label', { class: 'switch' }, cb, h('span', {}));
    inputs[s.key] = () => cb.checked;
  } else if (s.type === 'select') {
    const opts = (s.options || []).map((o) => (typeof o === 'object' ? o : { value: o, label: o }));
    const sel = h('select', { id }, opts.map((o) => h('option', { value: o.value, selected: String(o.value) === String(s.value) }, o.label)));
    input = sel;
    inputs[s.key] = () => sel.value;
  } else {
    const el = h('input', {
      id, type: s.type === 'secret' ? 'password' : s.type === 'number' ? 'number' : 'text',
      value: s.type === 'secret' ? '' : s.value ?? '', min: s.min, max: s.max, autocomplete: 'off', spellcheck: 'false',
      placeholder: s.type === 'secret' ? (s.isSet ? '•••••••• (set – leave empty to keep)' : 'Not set') : s.placeholder || '',
    });
    input = el;
    inputs[s.key] = () => el.value;
  }
  return h('div', { class: 'field' }, h('label', { for: id }, s.label || s.key), input, s.help && h('div', { class: 'help' }, s.help));
}

async function renderSettings(main) {
  const d = await api('/settings');
  const inputs = {};
  const groups = d.groups.map((g) => [
    h('div', { class: 'group-title' }, g.label),
    h('section', { class: 'card form' }, d.settings.filter((s) => s.group === g.key).map((s) => settingField('s', s, inputs))),
  ]);
  const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
  const form = h('form', { onsubmit: run(async (e) => {
    e.preventDefault();
    const patch = {};
    for (const s of d.settings) {
      const v = inputs[s.key]();
      if (s.type === 'secret') { if (v) patch[s.key] = v; continue; }
      if (String(v) !== String(s.value ?? '')) patch[s.key] = v;
    }
    if (!Object.keys(patch).length) return toast('Nothing to save');
    save.disabled = true;
    try {
      const r = await api('/settings', { method: 'PUT', body: patch });
      toast(r.changed.length ? `Saved ${r.changed.length} change${r.changed.length > 1 ? 's' : ''}. They apply straight away.` : 'Nothing changed');
      if (patch.pin) toast('The PIN code is set. Everyone enters it in their app to connect.');
      go('settings');
    } finally { save.disabled = false; }
  }) }, h('div', { class: 'form' }, groups), h('div', { class: 'savebar' }, save, h('span', { class: 'faint' }, 'Changes apply straight away and are saved on the server.')));
  fill(main, head('Settings', 'The server\'s own settings. Each plugin has its own settings under Plugins. Secret values are never shown.'), form);
}

// ---------------------------------------------------------------- plugins

async function renderPlugins(main) {
  let d = await api('/plugins');
  const listEl = h('div', { class: 'grid' });
  const catalogEl = h('div', { class: 'bundled-list' }, h('span', { class: 'faint' }, 'Asking GitHub…'));
  const picker = h('input', { type: 'file', accept: '.zip', hidden: true, onchange: run(async () => {
    const f = picker.files[0];
    if (!f) return;
    picker.value = '';
    d = await api(`/plugins/upload?name=${encodeURIComponent(f.name)}`, { method: 'PUT', raw: f });
    toast(`${f.name} installed – switch it on below`);
    renderList();
  }) });

  function pluginCard(p) {
    const toggle = h('input', { type: 'checkbox', checked: p.enabled, 'aria-label': `Switch on ${p.name}` });
    toggle.addEventListener('change', run(async () => {
      d = await api(`/plugins/${p.id}/${toggle.checked ? 'enable' : 'disable'}`, { method: 'POST', body: {} });
      toast(`${p.name} switched ${toggle.checked ? 'on' : 'off'}`);
      renderList();
    }));
    // The plugin's settings open in a popup.
    const openSettings = () => {
      const inputs = {};
      const form = h('form', { class: 'form', onsubmit: run(async (e) => {
        e.preventDefault();
        const body = {};
        for (const s of p.settings) { const v = inputs[s.key](); if (s.type === 'secret' && !v) continue; body[s.key] = v; }
        d = await api(`/plugins/${p.id}/settings`, { method: 'PUT', body });
        toast('Settings saved');
        close();
        renderList();
      }) }, p.settings.map((s) => settingField(`p-${p.id}`, s, inputs)));
      const close = modal(`${p.name} settings`, form, [
        h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => form.requestSubmit() }, 'Save'),
      ]);
    };
    const missing = p.settings.some((s) => s.required && (s.type === 'secret' ? !s.isSet : !s.value));
    // Updates from the plugin's GitHub repository (plugin.json "repository").
    let updates = null;
    if (p.repository) {
      const auto = h('input', { type: 'checkbox', checked: p.autoUpdate, 'aria-label': `Update ${p.name} automatically` });
      auto.addEventListener('change', run(async () => {
        d = await api(`/plugins/${p.id}/auto-update`, { method: 'PUT', body: { on: auto.checked } });
        toast(auto.checked ? `${p.name} updates by itself from now on` : `${p.name} is only updated when you say so`);
        renderList();
      }));
      const checked = p.updateCheckedAt ? new Date(p.updateCheckedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : null;
      updates = h('div', { class: 'updates' },
        p.update && h('p', { class: 'notice', style: { margin: 0, display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } },
          h('span', { class: 'grow' }, h('b', {}, `Version ${p.update.version} is out`), `  (you have ${p.version})`),
          p.update.url && h('a', { href: p.update.url, target: '_blank', rel: 'noopener', style: { fontSize: '13px' } }, 'What’s new ↗'),
          h('button', { class: 'btn small primary', onclick: run(async () => {
            d = await api(`/plugins/${p.id}/update`, { method: 'POST', body: {} });
            toast(`${p.name} updated`);
            renderList();
          }) }, `Update to ${p.update.version}`)),
        h('div', { class: 'row', style: { gap: '10px', alignItems: 'center' } },
          h('label', { class: 'switch', title: 'Install new versions from GitHub by itself' }, auto, h('span', {})),
          h('span', {}, 'Update automatically'),
          h('span', { class: 'faint', style: { fontSize: '13px' } },
            '  from ', h('a', { href: `https://github.com/${p.repository}`, target: '_blank', rel: 'noopener' }, `github.com/${p.repository}`),
            checked ? ` · checked ${checked}` : '')),
        p.updateError && h('p', { class: 'faint', style: { margin: 0, fontSize: '13px' } }, `Could not check for updates: ${p.updateError}`));
    }
    return h('section', { class: 'card plugin' },
      h('div', { class: 'top' },
        h('div', { class: 'grow' },
          h('div', { class: 'name' }, p.name, p.version && h('span', { class: 'faint', style: { fontWeight: 400, fontSize: '13px' } }, `  v${p.version}`)),
          h('div', { class: 'meta' }, h('code', {}, p.id), p.menu.map((m) => h('span', { class: 'pill ok', style: { marginLeft: '8px' } }, `in the app menu: ${m}`))),
          p.description && h('p', { class: 'muted', style: { margin: '6px 0 0' } }, p.description),
          p.requires && h('p', { class: 'faint', style: { margin: '4px 0 0', fontSize: '13px' } }, `Requires: ${p.requires}`),
          (p.homepage || p.links.length) ? h('div', { class: 'row', style: { marginTop: '6px', gap: '14px' } },
            p.homepage && h('a', { href: p.homepage, target: '_blank', rel: 'noopener', style: { fontSize: '13px' } }, 'Read more ↗'),
            p.links.map((l) => h('a', { href: l.url, target: '_blank', rel: 'noopener', style: { fontSize: '13px' } }, `${l.label} ↗`))) : null),
        h('label', { class: 'switch' }, toggle, h('span', {}))),
      p.error && h('p', { class: 'error', style: { margin: 0 } }, `Error: ${p.error}`),
      missing && h('p', { class: 'notice', style: { margin: 0 } }, 'Fill in the settings before using this plugin.'),
      (p.needs || []).filter((n) => !n.installed || !n.enabled).map((n) => h('p', { class: 'notice', style: { margin: 0 } },
        h('b', {}, `Needs ${n.name}: `), n.installed ? `switch on ${n.name} below.` : `install ${n.name} under Get plugins above.`)),
      updates,
      h('div', { class: 'row' },
        p.settings.length ? h('button', { class: `btn small ${missing ? 'primary' : ''}`, onclick: openSettings }, icon('settings'), 'Settings') : null,
        confirmBtn('Remove plugin', 'Click again to remove', async () => {
          d = await api(`/plugins/${p.id}`, { method: 'DELETE' });
          toast(`${p.name} removed`);
          renderList();
        })));
  }

  // Plugins to get: the list from GitHub, and any repository by its name.
  let catalog = null;
  let catalogError = null;
  const loadCatalog = async (fresh) => {
    try { catalog = (await api(`/plugins/catalog${fresh ? '?fresh' : ''}`)).catalog; catalogError = null; } catch (e) { catalogError = e.message; }
    drawCatalog();
  };
  const install = (repo, name) => run(async () => {
    try {
      d = await api('/plugins/github', { method: 'POST', body: { repo } });
      toast(`${name || repo} installed – switch it on below`);
      renderList();
    } catch (e) {
      if (e.status !== 409 || !e.data?.needs) throw e;
      // It builds on plugins that are not installed: they have to be installed too.
      const needs = e.data.needs;
      const pname = e.data.plugin?.name || name || repo;
      const names = needs.map((n) => n.name).join(' and ');
      const close = modal(`${pname} needs ${names}`,
        h('div', {},
          h('p', { style: { marginTop: 0 } }, `${pname} builds on ${names}, which is not installed. It cannot work without it.`),
          h('ul', {}, needs.map((n) => h('li', {}, h('b', {}, n.name), n.repository ? h('span', { class: 'faint' }, `  github.com/${n.repository}`) : ' – no download address given'))),
          h('p', { class: 'faint', style: { marginBottom: 0 } }, 'Both are installed switched off – switch them on and fill in their settings below.')),
        [
          h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'),
          h('button', { class: 'btn primary', type: 'button', disabled: needs.some((n) => !n.repository), onclick: run(async () => {
            d = await api('/plugins/github', { method: 'POST', body: { repo, withNeeds: true } });
            close();
            toast(`${names} and ${pname} installed – switch them on below`);
            renderList();
          }) }, `Install ${names} too`),
        ]);
    }
  });
  const repoInput = h('input', { type: 'text', placeholder: 'owner/repository', 'aria-label': 'GitHub repository', style: { flex: '1', minWidth: '200px' } });
  const fromRepo = h('form', { class: 'row', style: { gap: '8px', marginTop: '14px' }, onsubmit: (e) => {
    e.preventDefault();
    if (repoInput.value.trim()) install(repoInput.value.trim())();
  } },
    repoInput,
    h('button', { class: 'btn small', type: 'submit' }, 'Install from GitHub'));
  function drawCatalog() {
    const installedIds = new Map(d.plugins.map((p) => [p.id, p]));
    fill(catalogEl,
      catalogError ? h('p', { class: 'error', style: { margin: 0 } }, catalogError)
        : !catalog ? h('span', { class: 'faint' }, 'Asking GitHub…')
          : catalog.length ? catalog.map((c) => {
            const inst = installedIds.get(c.id);
            return h('div', { class: 'bundled' },
              h('div', { class: 'grow' },
                h('div', {}, h('b', {}, c.name), h('span', { class: 'faint' }, `  v${c.version}`)),
                h('div', { class: 'faint', style: { fontSize: '13px' } }, c.description),
                c.needs?.length ? h('div', { style: { fontSize: '13px' } }, `Needs: ${c.needs.map((n) => n.name).join(', ')}`) : null,
                h('a', { href: `https://github.com/${c.repo}`, target: '_blank', rel: 'noopener', style: { fontSize: '12px' } }, `github.com/${c.repo} ↗`)),
              inst ? h('span', { class: 'pill ok' }, 'Installed')
                : h('button', { class: 'btn small primary', onclick: install(c.repo, c.name) }, 'Install'));
          }) : h('span', { class: 'faint' }, 'No plugins found on GitHub.'),
      fromRepo);
  }

  function renderList() {
    drawCatalog();
    fill(listEl, d.plugins.length ? d.plugins.map(pluginCard) : h('p', { class: 'empty' }, 'No plugins installed yet. Get one from GitHub above, or upload your own.'));
  }

  fill(main,
    head('Plugins', 'Plugins decide what the apps show: the menu, the screens, search results, what is played and how the player behaves. Each plugin has its own settings.',
      h('button', { class: 'btn', onclick: run(async () => {
        d = await api('/plugins/check-updates', { method: 'POST', body: {} });
        const n = d.plugins.filter((p) => p.update).length;
        toast(n ? `${n} plugin${n > 1 ? 's have' : ' has'} a new version` : 'Every plugin is up to date');
        renderList();
      }) }, 'Check for updates'),
      h('button', { class: 'btn primary', onclick: () => picker.click() }, 'Upload plugin (.zip)'), picker),
    h('p', { class: 'notice' }, h('b', {}, 'Good to know: '), 'plugins run with the same rights as the server. Only install plugins you wrote yourself or trust. New plugins are switched off until you switch them on.'),
    h('section', { class: 'card', style: { margin: '16px 0' } },
      h('div', { class: 'row', style: { justifyContent: 'space-between', alignItems: 'center' } },
        h('h3', { style: { margin: 0 } }, 'Get plugins'),
        h('button', { class: 'btn small', onclick: () => { catalog = null; drawCatalog(); loadCatalog(true); } }, 'Refresh')),
      h('p', { class: 'faint', style: { fontSize: '13px', margin: '6px 0 12px' } }, 'Downloaded from GitHub. Updates appear on each plugin below. To install someone else\'s plugin, write its repository (owner/name).'),
      catalogEl),
    listEl);
  renderList();
  loadCatalog(false);
}

// ---------------------------------------------------------------- app menu

/**
 * Drag to reorder: rows with data-index in [list] are moved by their grip (.grip) with the mouse or a finger.
 * The other rows slide out of the way while dragging; onMove(from, to) is called when it is let go.
 */
function dragSort(list, onMove) {
  list.addEventListener('pointerdown', (ev) => {
    const grip = ev.target.closest('.grip');
    if (!grip || ev.button > 0) return;
    const rows = [...list.querySelectorAll('.menu-row[data-index]')];
    const row = grip.closest('.menu-row');
    const from = rows.indexOf(row);
    if (from < 0) return;
    ev.preventDefault();
    grip.setPointerCapture(ev.pointerId);
    const boxes = rows.map((r) => r.getBoundingClientRect());
    const mids = boxes.map((b) => b.top + b.height / 2);
    const step = rows.length > 1 ? Math.abs(boxes[1].top - boxes[0].top) : boxes[0].height;
    const startY = ev.clientY;
    let to = from;
    row.classList.add('dragging');
    list.classList.add('sorting');
    const move = (e) => {
      const dy = e.clientY - startY;
      row.style.transform = `translateY(${dy}px)`;
      const y = mids[from] + dy;
      to = mids.filter((m, i) => i !== from && m < y).length;
      rows.forEach((r, i) => {
        if (i === from) return;
        const shift = from < to && i > from && i <= to ? -step : from > to && i >= to && i < from ? step : 0;
        r.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    };
    const end = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', end);
      grip.removeEventListener('pointercancel', end);
      rows.forEach((r) => { r.style.transform = ''; });
      row.classList.remove('dragging');
      list.classList.remove('sorting');
      if (to !== from) onMove(from, to);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  });
}

/** Moves an item in a list from one place to another (in place). */
const moveItem = (arr, from, to) => arr.splice(to, 0, arr.splice(from, 1)[0]);
const grip = (title) => h('span', { class: 'grip', title: 'Drag to move', 'aria-hidden': 'true' }, '⋮⋮');

async function renderMenu(main) {
  let entries = (await api('/menu')).entries;
  const list = h('section', { class: 'card menu-list' });
  const save = run(async () => {
    entries = (await api('/menu', { method: 'PUT', body: { order: entries.map((e) => e.key), hidden: entries.filter((e) => e.hidden).map((e) => e.key) } })).entries;
    draw();
  });
  const move = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= entries.length) return;
    [entries[i], entries[j]] = [entries[j], entries[i]];
    draw();
    save();
  };
  const fixed = (label) => h('div', { class: 'menu-row fixed' }, h('span', { class: 'grow' }, label), h('span', { class: 'faint' }, 'always here'));
  function draw() {
    fill(list,
      fixed('Search'),
      entries.map((e, i) => {
        const show = h('input', { type: 'checkbox', checked: !e.hidden, 'aria-label': `Show ${e.title}` });
        show.addEventListener('change', () => { e.hidden = !show.checked; save(); });
        return h('div', { class: `menu-row ${e.hidden || !e.available ? 'dim' : ''}`, 'data-index': i },
          grip(e.title),
          h('div', { class: 'arrows' },
            h('button', { class: 'btn small', disabled: i === 0, 'aria-label': `Move ${e.title} up`, onclick: () => move(i, -1) }, '▲'),
            h('button', { class: 'btn small', disabled: i === entries.length - 1, 'aria-label': `Move ${e.title} down`, onclick: () => move(i, 1) }, '▼')),
          h('div', { class: 'grow' },
            h('b', {}, e.title),
            e.pluginName && h('span', { class: 'faint' }, `  ${e.pluginName}`),
            !e.available && h('div', { class: 'faint', style: { fontSize: '13px' } }, 'Not shown right now – the plugin has nothing to show here.')),
          h('label', { class: 'switch', title: 'Show in the app' }, show, h('span', {})));
      }),
      fixed('Settings'));
  }
  // The groups on the Favorites screen – plugins name them and suggest an order; it can be changed here.
  let groups = (await api('/favorite-groups')).groups;
  const glist = h('section', { class: 'card menu-list' });
  const gsave = run(async () => {
    groups = (await api('/favorite-groups', { method: 'PUT', body: { order: groups.map((g) => g.id) } })).groups;
    gdraw();
  });
  const gmove = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= groups.length) return;
    [groups[i], groups[j]] = [groups[j], groups[i]];
    gdraw();
    gsave();
  };
  function gdraw() {
    fill(glist, groups.map((g, i) => h('div', { class: 'menu-row', 'data-index': i },
      grip(g.title),
      h('div', { class: 'arrows' },
        h('button', { class: 'btn small', disabled: i === 0, 'aria-label': `Move ${g.title} up`, onclick: () => gmove(i, -1) }, '▲'),
        h('button', { class: 'btn small', disabled: i === groups.length - 1, 'aria-label': `Move ${g.title} down`, onclick: () => gmove(i, 1) }, '▼')),
      h('div', { class: 'grow' },
        h('b', {}, g.title),
        h('span', { class: 'faint' }, g.pluginName ? `  ${g.pluginName}` : '  any plugin')))));
  }

  fill(main,
    head('App menu', 'The order of the menu in the apps. Search is always at the top and Settings always at the bottom. Switch an entry off to hide it. Plugins hide entries themselves when they have nothing to show.'),
    list,
    h('h2', { class: 'section-title' }, 'Favorites screen'),
    h('p', { class: 'faint', style: { maxWidth: '640px' } }, 'The order of the groups on the Favorites screen. Groups without any favourites are not shown in the apps. A plugin switched on later puts its groups where it suggests, until you move them.'),
    glist);
  dragSort(list, (from, to) => { moveItem(entries, from, to); draw(); save(); });
  dragSort(glist, (from, to) => { moveItem(groups, from, to); gdraw(); gsave(); });
  draw();
  gdraw();
}

// ---------------------------------------------------------------- translations

let trLang = null;
async function renderTranslations(main) {
  let langs = (await api('/translations')).languages;
  const names = new Intl.DisplayNames(['en'], { type: 'language' });
  const langName = (code) => { try { return names.of(code); } catch { return code; } };
  if (!langs.some((l) => l.lang === trLang)) trLang = langs[0]?.lang || null;
  const list = h('section', { class: 'card' });
  const filter = h('input', { type: 'text', placeholder: 'Filter, e.g. "history"', style: { maxWidth: '320px' }, 'aria-label': 'Filter the translations' });
  const select = h('select', { 'aria-label': 'Language', style: { width: 'auto' } });
  const onlyFixed = h('input', { type: 'checkbox', id: 'only-fixed' });

  function draw() {
    fill(select, langs.map((l) => h('option', { value: l.lang, selected: l.lang === trLang }, `${langName(l.lang)} (${l.lang}) · ${l.entries.length}`)));
    const lang = langs.find((l) => l.lang === trLang);
    if (!lang) { fill(list, h('p', { class: 'empty' }, 'Nothing translated yet. Texts are translated when a device with that language uses the apps.')); return; }
    const q = filter.value.trim().toLowerCase();
    const rows = lang.entries.filter((e) => (!onlyFixed.checked || e.manual) && (!q || e.text.toLowerCase().includes(q) || e.translation.toLowerCase().includes(q)));
    fill(list, h('div', { class: 'table-wrap' }, h('table', { class: 'tr-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'English'), h('th', {}, langName(lang.lang)), h('th', {}))),
      h('tbody', {}, rows.slice(0, 500).map((e) => {
        const input = h('input', { type: 'text', value: e.translation, 'aria-label': `Translation of ${e.text}` });
        input.addEventListener('change', run(async () => {
          langs = (await api('/translations', { method: 'PUT', body: { lang: lang.lang, text: e.text, translation: input.value } })).languages;
          toast('Saved – the apps update straight away');
          draw();
        }));
        return h('tr', { class: e.manual ? 'fixed' : '' },
          h('td', {}, e.text),
          h('td', {}, input, e.manual && e.machine ? h('div', { class: 'faint', style: { fontSize: '12px', marginTop: '3px' } }, `Machine: ${e.machine}`) : null),
          h('td', { class: 'act' }, e.manual ? h('button', { class: 'btn small', onclick: run(async () => {
            langs = (await api('/translations', { method: 'PUT', body: { lang: lang.lang, text: e.text, translation: '' } })).languages;
            toast('Back to the machine translation');
            draw();
          }) }, 'Reset') : null));
      })))),
      rows.length > 500 ? h('p', { class: 'faint' }, `Showing 500 of ${rows.length} – use the filter.`) : null);
  }
  select.addEventListener('change', () => { trLang = select.value; draw(); });
  filter.addEventListener('input', draw);
  onlyFixed.addEventListener('change', draw);
  fill(main,
    head('Translations', 'Menus and buttons are translated on this server into each device\'s language. Correct a translation here – your corrections are never overwritten and the apps update straight away. Names and titles are never translated.',
      h('div', { class: 'row' }, select, filter, h('label', { for: 'only-fixed', class: 'row', style: { gap: '6px' } }, onlyFixed, 'Only corrected'))),
    list);
  draw();
}

// ---------------------------------------------------------------- data

let dataTab = 'reminders';
async function renderData(main) {
  const d = await api('/data');
  const tabs = [['reminders', 'Reminders', d.reminders], ['favorites', 'Favourites', d.favorites], ['history', 'History', d.history]];
  const body = h('section', { class: 'card' });
  const remove = (kind, key) => api(`/data/${kind}/${encodeURIComponent(key)}`, { method: 'DELETE' }).then(() => renderData(main));
  const tables = {
    reminders: () => d.reminders.length ? h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Programme'), h('th', {}, 'Channel'), h('th', {}, 'Plugin'), h('th', {}, 'Added by'), h('th', {}))),
      h('tbody', {}, d.reminders.map((r) => h('tr', {},
        h('td', {}, fmtDate(r.start)), h('td', {}, h('b', {}, r.title)), h('td', { class: 'muted' }, r.channel?.title), h('td', { class: 'muted' }, r.plugin), h('td', { class: 'muted' }, r.addedBy || '–'),
        h('td', { class: 'act' }, confirmBtn('Remove', 'Sure?', () => remove('reminders', r.key)))))))
      : h('p', { class: 'empty' }, 'No upcoming reminders.'),
    favorites: () => d.favorites.length ? h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Title'), h('th', {}, 'Kind'), h('th', {}, 'Plugin'), h('th', {}, 'New'), h('th', {}, 'Added by'), h('th', {}))),
      h('tbody', {}, d.favorites.map((f) => h('tr', {},
        h('td', {}, h('b', {}, f.title)), h('td', { class: 'muted' }, f.kind || '–'), h('td', { class: 'muted' }, f.plugin),
        h('td', {}, f.newCount ? h('span', { class: 'pill warn' }, `${f.newCount} new`) : '–'), h('td', { class: 'muted' }, f.addedBy || '–'),
        h('td', { class: 'act' }, confirmBtn('Remove', 'Sure?', () => remove('favorites', f.key)))))))
      : h('p', { class: 'empty' }, 'No favourites.'),
    history: () => d.history.length ? [
      h('div', { class: 'row', style: { justifyContent: 'flex-end', marginBottom: '8px' } },
        confirmBtn('Clear all history', 'Click again to clear everything', () => api('/data/history', { method: 'DELETE' }).then(() => renderData(main)))),
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Title'), h('th', {}, 'Plugin'), h('th', {}, 'Started by'), h('th', {}, 'Last'), h('th', {}, 'Position'), h('th', {}))),
        h('tbody', {}, d.history.map((e) => h('tr', {},
          h('td', {}, h('b', {}, e.title), e.subtitle && h('div', { class: 'faint' }, e.subtitle)), h('td', { class: 'muted' }, e.plugin), h('td', { class: 'muted' }, e.startedBy || '–'),
          h('td', { class: 'faint' }, fmtAgo(e.lastAt)), h('td', { class: 'num' }, e.live ? 'Live' : `${fmtTime(e.position)}${e.duration ? ` / ${fmtTime(e.duration)}` : ''}`),
          h('td', { class: 'act' }, confirmBtn('Remove', 'Sure?', () => remove('history', e.key)))))))]
      : h('p', { class: 'empty' }, 'No history.'),
  };
  const show = (t) => {
    dataTab = t;
    tabRow.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
    fill(body, h('div', { class: 'table-wrap' }, tables[t]()));
  };
  const tabRow = h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([id, label, list]) => h('button', { class: 'tab', 'data-t': id, role: 'tab', onclick: () => show(id) }, label, h('span', { class: 'count' }, list.length))));
  fill(main, head('Reminders and data', 'The room\'s shared reminders, favourites and history.'), tabRow, body);
  show(dataTab);
}

// ---------------------------------------------------------------- downloads

async function renderDownloads(main) {
  let files = await api('/downloads');
  const list = h('section', { class: 'card' });
  const progress = h('div', { class: 'progress faint' });
  const picker = h('input', { type: 'file', multiple: true, hidden: true, onchange: () => upload([...picker.files]) });
  const drop = h('div', { class: 'drop', tabindex: '0', role: 'button', onclick: () => picker.click(), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); picker.click(); } } },
    h('b', {}, 'Drop files here'), ' or click to choose', h('div', { class: 'faint', style: { marginTop: '4px' } }, 'E.g. the Android TV app (Couchmate.apk)'));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); upload([...e.dataTransfer.files]); });

  async function upload(chosen) {
    for (const f of chosen) {
      const name = f.name.replace(/[^A-Za-z0-9._ -]+/g, '-');
      progress.textContent = `Uploading ${name} (${fmtSize(f.size)})…`;
      try {
        files = await api(`/downloads/${encodeURIComponent(name)}`, { method: 'PUT', raw: f });
        toast(`${name} uploaded`);
      } catch (e) { toast(`${name}: ${e.message}`, true); }
    }
    progress.textContent = '';
    renderList();
  }
  function renderList() {
    fill(list, h('h3', {}, `Files  ${files.length}`, h('span', { class: 'grow' }), h('a', { class: 'btn small', href: '/download', target: '_blank', rel: 'noopener' }, 'Open the download page ↗')),
      files.length ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'File'), h('th', {}, 'Description'), h('th', {}, 'Size'), h('th', {}, 'Uploaded'), h('th', {}))),
        h('tbody', {}, files.map((f) => {
          const desc = h('input', { type: 'text', value: f.description, placeholder: 'Shown on the download page', 'aria-label': `Description for ${f.name}` });
          desc.addEventListener('change', run(async () => { files = await api(`/downloads/${encodeURIComponent(f.name)}`, { method: 'PATCH', body: { description: desc.value } }); toast('Description saved'); }));
          return h('tr', {}, h('td', {}, h('a', { href: `/download/${encodeURIComponent(f.name)}` }, f.name)), h('td', {}, desc), h('td', { class: 'num' }, fmtSize(f.size)), h('td', { class: 'faint' }, fmtAgo(f.modified)),
            h('td', { class: 'act' }, confirmBtn('Remove', 'Sure?', async () => { files = await api(`/downloads/${encodeURIComponent(f.name)}`, { method: 'DELETE' }); renderList(); })));
        })))) : h('p', { class: 'empty' }, 'No files uploaded yet.'));
  }
  fill(main, head('Downloads', 'Files your friends can download at /download. The page also shows how to connect (but never the PIN code).'),
    h('div', { class: 'grid' }, h('section', { class: 'card wide' }, drop, picker, progress), h('div', { class: 'wide' }, list)));
  renderList();
}

// ---------------------------------------------------------------- log

async function renderLogs(main) {
  const box = h('div', { class: 'log', role: 'log', 'aria-live': 'off' });
  const filter = h('input', { type: 'text', placeholder: 'Filter, e.g. "reminders" or a name', style: { maxWidth: '340px' }, 'aria-label': 'Filter the log' });
  const level = h('select', { 'aria-label': 'Level', style: { width: 'auto' } }, h('option', { value: '' }, 'All levels'), h('option', { value: 'warn' }, 'Warnings and errors'), h('option', { value: 'error' }, 'Errors only'));
  let lines = [];
  const matches = (l) => (!level.value || (level.value === 'warn' ? l.level !== 'log' : l.level === 'error')) && (!filter.value || l.text.toLowerCase().includes(filter.value.toLowerCase()));
  const row = (l) => h('div', { class: `l lv-${l.level}` }, h('span', { class: 't' }, new Date(l.t).toLocaleTimeString()), h('span', {}, l.text));
  const redraw = () => { fill(box, lines.filter(matches).map(row)); box.scrollTop = box.scrollHeight; };
  filter.addEventListener('input', redraw);
  level.addEventListener('change', redraw);
  fill(main, head('Log', 'The server log in real time. PIN codes and passwords are removed before anything is shown.', h('div', { class: 'row' }, level, filter)), box);
  lines = await api('/logs');
  redraw();
  const es = new EventSource('/admin/api/logs/stream');
  es.onmessage = (ev) => {
    const l = JSON.parse(ev.data);
    lines.push(l);
    if (lines.length > 1500) lines.shift();
    if (!matches(l)) return;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.append(row(l));
    if (atBottom) box.scrollTop = box.scrollHeight;
  };
  timers.push(() => es.close());
}

// ---------------------------------------------------------------- account

function renderAccount(main) {
  const cur = h('input', { type: 'password', id: 'cur', autocomplete: 'current-password' });
  const pw = h('input', { type: 'password', id: 'npw', autocomplete: 'new-password', placeholder: 'At least 8 characters' });
  const pw2 = h('input', { type: 'password', id: 'npw2', autocomplete: 'new-password' });
  fill(main, head('Account', 'The admin password protects this panel. It is not the same as the PIN code the apps use.'),
    h('div', { class: 'grid' },
      h('section', { class: 'card' }, h('h3', {}, 'Change password'),
        h('form', { class: 'form', onsubmit: run(async (e) => {
          e.preventDefault();
          if (pw.value !== pw2.value) throw new Error('The passwords do not match');
          await api('/password', { method: 'POST', body: { current: cur.value, password: pw.value } });
          cur.value = pw.value = pw2.value = '';
          toast('Password changed. Other sessions have been logged out.');
        }) },
        h('div', { class: 'field' }, h('label', { for: 'cur' }, 'Current'), cur),
        h('div', { class: 'field' }, h('label', { for: 'npw' }, 'New'), pw),
        h('div', { class: 'field' }, h('label', { for: 'npw2' }, 'Repeat'), pw2),
        h('div', {}, h('button', { class: 'btn primary', type: 'submit' }, 'Change password')))),
      h('section', { class: 'card' }, h('h3', {}, 'Log out'), h('p', { class: 'muted' }, 'A login lasts a week on this device.'),
        h('button', { class: 'btn', onclick: run(async () => { await api('/logout', { method: 'POST', body: {} }); start(); }) }, 'Log out'))));
}

start();
