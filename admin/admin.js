// Couchmates admin – inloggning, översikt, rummet, inställningar, data, tablå, nedladdningar, plugins och logg.
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
  guide: 'M19 3h-1V1h-2v2H8V1H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 16H5V8h14v11zM7 10h5v5H7z',
  downloads: 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z',
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

// ---------------------------------------------------------------- hjälpare

async function api(path, { method = 'GET', body, raw } = {}) {
  const r = await fetch(`/admin/api${path}`, {
    method,
    headers: raw ? { 'content-type': 'application/octet-stream' } : body !== undefined ? { 'content-type': 'application/json' } : {},
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    credentials: 'same-origin',
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/login' && path !== '/setup') { start(); throw new Error('Inte inloggad'); }
  if (!r.ok) throw new Error(data.error || `Fel ${r.status}`);
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
  if (s < 60) return `${s} s sedan`;
  if (s < 3600) return `${Math.round(s / 60)} min sedan`;
  if (s < 86400) return `${Math.round(s / 3600)} h sedan`;
  return new Date(ms).toLocaleString('sv-SE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const fmtUptime = (s) => (s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h`);
const fmtDate = (sec) => new Date(sec * 1000).toLocaleString('sv-SE', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Knapp som kräver ett andra klick för att bekräfta (inga dialogrutor). */
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

// ---------------------------------------------------------------- inloggning

async function start() {
  stopTimers();
  const s = await fetch('/admin/api/session', { credentials: 'same-origin' }).then((r) => r.json());
  if (s.loggedIn) return shell();
  const err = h('p', { class: 'error', role: 'alert' });
  const setup = s.setupNeeded;
  const pin = h('input', { type: 'password', id: 'pin', autocomplete: 'off', placeholder: 'Rummets PIN-kod' });
  const pw = h('input', { type: 'password', id: 'pw', autocomplete: setup ? 'new-password' : 'current-password', placeholder: setup ? 'Minst 8 tecken' : 'Adminlösenord' });
  const pw2 = h('input', { type: 'password', id: 'pw2', autocomplete: 'new-password', placeholder: 'Samma lösenord igen' });
  const form = h('form', { class: 'auth-form', onsubmit: run(async (e) => {
    e.preventDefault();
    err.textContent = '';
    try {
      if (setup) {
        if (pw.value !== pw2.value) throw new Error('Lösenorden är inte likadana');
        await api('/setup', { method: 'POST', body: { pin: pin.value, password: pw.value } });
      } else {
        await api('/login', { method: 'POST', body: { password: pw.value } });
      }
      shell();
    } catch (x) { err.textContent = x.message; }
  }) },
  h('h1', {}, 'Couch', h('span', { class: 'brand-a' }, 'mates'), h('span', { class: 'faint', style: { fontWeight: 400 } }, ' admin')),
  setup
    ? h('p', {}, 'Skapa ett adminlösenord. För att bevisa att det är du som har servern behövs rummets PIN-kod (den som apparna använder).')
    : h('p', {}, 'Logga in med adminlösenordet.'),
  setup && h('label', { for: 'pin', class: 'muted' }, 'PIN-kod'), setup && pin,
  h('label', { for: 'pw', class: 'muted' }, setup ? 'Nytt adminlösenord' : 'Lösenord'), pw,
  setup && h('label', { for: 'pw2', class: 'muted' }, 'Upprepa lösenordet'), setup && pw2,
  h('button', { class: 'btn primary', type: 'submit', style: { justifyContent: 'center', marginTop: '6px' } }, setup ? 'Skapa och logga in' : 'Logga in'),
  err);
  fill($('#app'), h('div', { class: 'auth' }, form));
  (setup ? pin : pw).focus();
}

// ---------------------------------------------------------------- skal + navigering

const PAGES = [
  ['overview', 'Översikt', renderOverview],
  ['settings', 'Inställningar', renderSettings],
  ['guide', 'Tablå', renderGuide],
  ['data', 'Påminnelser och data', renderData],
  ['downloads', 'Nedladdningar', renderDownloads],
  ['plugins', 'Plugins', renderPlugins],
  ['logs', 'Logg', renderLogs],
  ['account', 'Konto', renderAccount],
];
let page = (location.hash || '#overview').slice(1);
let timers = [];
const stopTimers = () => { timers.forEach((t) => (typeof t === 'function' ? t() : clearInterval(t))); timers = []; };

function shell() {
  const main = h('main', { class: 'main', id: 'main' });
  const side = h('nav', { class: 'side', 'aria-label': 'Meny' },
    h('div', { class: 'brand' }, h('span', { class: 'logo' }), h('div', {}, h('span', {}, 'Couch', h('span', { class: 'brand-a' }, 'mates')), h('small', {}, 'Admin'))),
    PAGES.map(([id, label]) => h('button', { class: `nav ${page === id ? 'on' : ''}`, 'data-page': id, onclick: () => go(id) }, icon(id), h('span', {}, label))),
    h('div', { class: 'spacer' }),
    h('div', { class: 'foot' }, h('a', { href: '/download', target: '_blank', rel: 'noopener' }, 'Nedladdningssidan ↗')));
  fill($('#app'), h('div', { class: 'shell' }, side, main));
  go(PAGES.some(([id]) => id === page) ? page : 'overview');
}

function go(id) {
  stopTimers();
  page = id;
  history.replaceState(null, '', `#${id}`);
  document.querySelectorAll('.nav').forEach((n) => n.classList.toggle('on', n.dataset.page === id));
  const [, label, render] = PAGES.find(([p]) => p === id);
  document.title = `${label} – Couchmates admin`;
  const main = $('#main');
  fill(main, h('p', { class: 'faint' }, 'Laddar…'));
  run(render)(main);
}

const head = (title, text, ...actions) => h('div', { class: 'page-head' }, h('h2', {}, title), text && h('p', {}, text), ...actions);

// ---------------------------------------------------------------- översikt

async function renderOverview(main) {
  const nowCard = h('section', { class: 'card wide' });
  const members = h('section', { class: 'card wide' });
  const server = h('section', { class: 'card' });
  const epg = h('section', { class: 'card' });
  const plug = h('section', { class: 'card' });
  fill(main, head('Översikt', 'Vad som händer i rummet just nu. Uppdateras varannan sekund.'), h('div', { class: 'grid' }, nowCard, members, server, epg, plug));

  const update = async () => {
    const d = await api('/overview');
    const st = d.state, m = st.media;
    const skew = Date.now() - d.serverNow;
    const pos = m && m.type !== 'live' ? (st.paused ? st.position : st.position + Math.max(0, (Date.now() - skew - st.refTime) / 1000)) : 0;
    const dur = m && st.duration;
    fill(nowCard, h('h3', {}, 'Nu spelas', h('span', { class: 'grow' }),
      m && (m.type === 'live' ? h('span', { class: 'pill live' }, 'LIVE') : null),
      m && h('span', { class: `pill ${st.waiting ? 'warn' : st.paused ? '' : 'ok'}` }, st.waiting ? 'Väntar på alla' : st.paused ? 'Pausad' : 'Spelar')),
    m ? h('div', { class: 'now' },
      h('div', { class: 'art', style: m.icon ? { backgroundImage: `url("${m.icon}")` } : {} }),
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('div', { class: 'title' }, m.title),
        h('div', { class: 'muted' }, [m.subtitle, st.changedBy && `startad av ${st.changedBy}`].filter(Boolean).join('  ·  ')),
        m.type !== 'live' && h('div', { class: 'row', style: { marginTop: '10px' } },
          h('span', { class: 'faint', style: { fontVariantNumeric: 'tabular-nums' } }, fmtTime(pos)),
          dur ? h('div', { class: 'bar', style: { flex: 1, maxWidth: '360px' } }, h('i', { style: { width: `${Math.min(100, (pos / dur) * 100)}%` } })) : null),
        h('div', { class: 'row controls' },
          st.paused
            ? h('button', { class: 'btn primary small', onclick: run(() => api('/room/play', { method: 'POST', body: {} }).then(update)) }, '▶ Spela')
            : h('button', { class: 'btn small', onclick: run(() => api('/room/pause', { method: 'POST', body: {} }).then(update)) }, '❚❚ Pausa'),
          m.type !== 'live' && h('button', { class: 'btn small', onclick: run(() => api('/room/seek', { method: 'POST', body: { position: Math.max(0, pos - 30) } }).then(update)) }, '−30 s'),
          m.type !== 'live' && h('button', { class: 'btn small', onclick: run(() => api('/room/seek', { method: 'POST', body: { position: pos + 30 } }).then(update)) }, '+30 s'),
          confirmBtn('■ Stoppa för alla', 'Klicka igen för att stoppa', () => api('/room/stop', { method: 'POST', body: {} }).then(update)))))
      : h('p', { class: 'empty' }, 'Inget spelas just nu.'),
    st.reminder && h('p', { class: 'notice', style: { marginTop: '14px' } }, h('b', {}, 'Påminnelse: '), `${st.reminder.title} – byter till ${st.reminder.channel?.name} om ${Math.max(0, Math.round((st.reminder.switchAt - d.serverNow) / 1000))} s`));

    fill(members, h('h3', {}, `Anslutna  ${d.members.length}`),
      d.members.length ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Namn'), h('th', {}, 'Enhet'), h('th', {}, 'Läge'), h('th', {}, 'Synk'), h('th', {}, 'Status'), h('th', {}, 'Senaste rapport'), h('th', {}))),
        h('tbody', {}, d.members.map((x) => {
          const drift = x.drift == null ? null : Math.round(x.drift * 1000);
          const cls = drift == null ? 'faint' : Math.abs(drift) < 300 ? 'drift-ok' : Math.abs(drift) < 1000 ? 'drift-warn' : 'drift-bad';
          return h('tr', {},
            h('td', {}, h('b', {}, x.name)),
            h('td', { class: 'muted' }, x.device || '–'),
            h('td', {}, h('span', { class: `pill ${x.watching ? 'ok' : ''}` }, x.watching ? 'Tittar' : 'Bläddrar')),
            h('td', { class: `num ${cls}` }, drift == null ? '–' : `${drift > 0 ? '+' : ''}${drift} ms`),
            h('td', { class: 'muted' }, x.status || '–'),
            h('td', { class: 'faint' }, x.reportAge == null ? '–' : `${x.reportAge} s sedan`),
            h('td', { class: 'act' }, confirmBtn('Koppla bort', 'Säker?', () => api('/room/kick', { method: 'POST', body: { id: x.id } }).then(update))));
        })))) : h('p', { class: 'empty' }, 'Ingen är ansluten.'));

    fill(server, h('h3', {}, 'Servern'), h('dl', { class: 'kv' },
      h('dt', {}, 'Igång'), h('dd', {}, fmtUptime(d.server.uptime)),
      h('dt', {}, 'Dispatcharr'), h('dd', {}, d.server.dispatcharr),
      h('dt', {}, 'Strömläge'), h('dd', {}, d.server.streamMode),
      h('dt', {}, 'Minne'), h('dd', {}, fmtSize(d.server.rss)),
      h('dt', {}, 'Node'), h('dd', {}, d.server.node),
      d.cache && h('dt', {}, 'Delad film'), d.cache && h('dd', {}, `${fmtSize(d.cache.downloaded)}${d.cache.size ? ` av ${fmtSize(d.cache.size)}` : ''}${d.cache.complete ? ' (klar)' : ''}`),
      h('dt', {}, 'Favoriter'), h('dd', {}, d.counts.favorites),
      h('dt', {}, 'Påminnelser'), h('dd', {}, d.counts.reminders),
      h('dt', {}, 'Historik'), h('dd', {}, d.counts.history)));

    const e = d.epg;
    fill(epg, h('h3', {}, 'Tablå', h('span', { class: 'grow' }), h('button', { class: 'btn small', onclick: () => go('guide') }, 'Visa')),
      !e.enabled ? h('p', { class: 'empty' }, 'Ingen sammanslagen tablå (originaltablå saknas i inställningarna).') : h('dl', { class: 'kv' },
        h('dt', {}, 'Byggd'), h('dd', {}, e.building ? 'Bygger nu…' : fmtAgo(e.builtAt)),
        e.stats && h('dt', {}, 'Ifyllda program'), e.stats && h('dd', {}, e.stats.addedProgrammes.toLocaleString('sv-SE')),
        e.stats && h('dt', {}, 'Matchade kanaler'), e.stats && h('dd', {}, e.stats.matchedChannels),
        e.error && h('dt', {}, 'Fel'), e.error && h('dd', { class: 'error' }, e.error)));

    fill(plug, h('h3', {}, 'Plugins', h('span', { class: 'grow' }), h('button', { class: 'btn small', onclick: () => go('plugins') }, 'Hantera')),
      d.plugins.length ? h('div', { class: 'chips' }, d.plugins.map((p) => h('span', { class: `pill ${p.error ? 'bad' : p.enabled ? 'ok' : ''}` }, h('span', { class: 'dot' }), p.name)))
        : h('p', { class: 'empty' }, 'Inga plugins installerade.'));
  };
  await update();
  timers.push(setInterval(run(update), 2000));
}

// ---------------------------------------------------------------- inställningar

async function renderSettings(main) {
  const d = await api('/settings');
  const inputs = {};
  const groups = d.groups.map((g) => {
    const fields = d.settings.filter((s) => s.group === g.key).map((s) => {
      const id = `s-${s.key}`;
      let input;
      if (s.type === 'bool') {
        const cb = h('input', { type: 'checkbox', id, checked: Boolean(s.value) });
        input = h('label', { class: 'switch' }, cb, h('span', {}));
        inputs[s.key] = () => cb.checked;
      } else if (s.type === 'select') {
        const sel = h('select', { id }, s.options.map((o) => h('option', { value: o, selected: o === s.value }, o)));
        input = sel;
        inputs[s.key] = () => sel.value;
      } else {
        const el = h('input', {
          id, type: s.type === 'secret' ? 'password' : s.type === 'number' ? 'number' : 'text',
          value: s.type === 'secret' ? '' : s.value ?? '', min: s.min, max: s.max, autocomplete: 'off', spellcheck: 'false',
          placeholder: s.type === 'secret' ? (s.isSet ? '•••••••• (satt – lämna tomt för att behålla)' : 'Inte satt') : '',
        });
        input = el;
        inputs[s.key] = () => el.value;
      }
      return h('div', { class: 'field' },
        h('label', { for: id }, s.sv, s.fromAdmin && h('span', { class: 'tag', title: 'Ändrad i adminpanelen (gäller före .env)' }, 'ändrad')),
        input,
        s.help_sv && h('div', { class: 'help' }, s.help_sv));
    });
    return [h('div', { class: 'group-title' }, g.sv), h('section', { class: 'card form' }, fields)];
  });
  const save = h('button', { class: 'btn primary', type: 'submit' }, 'Spara');
  const form = h('form', { onsubmit: run(async (e) => {
    e.preventDefault();
    const patch = {};
    for (const s of d.settings) {
      const v = inputs[s.key]();
      if (s.type === 'secret') { if (v) patch[s.key] = v; continue; }
      if (String(v) !== String(s.value ?? '')) patch[s.key] = v;
    }
    if (!Object.keys(patch).length) return toast('Inget att spara');
    save.disabled = true;
    try {
      const r = await api('/settings', { method: 'PUT', body: patch });
      toast(r.changed.length ? `Sparat: ${r.changed.length} ändring${r.changed.length > 1 ? 'ar' : ''}. Gäller direkt.` : 'Inget ändrades');
      if (patch.pin) toast('PIN-koden är ändrad. Alla måste skriva in den nya i sina appar.');
      go('settings');
    } finally { save.disabled = false; }
  }) }, h('div', { class: 'form' }, groups), h('div', { class: 'savebar' }, save, h('span', { class: 'faint' }, 'Ändringar gäller direkt och sparas på servern. Det som står i .env används bara som startvärden.')));
  fill(main, head('Inställningar', 'Serverns inställningar. Hemliga värden (lösenord, PIN, länkar med inloggning) visas aldrig.'), form);
}

// ---------------------------------------------------------------- tablå

async function renderGuide(main) {
  const render = async () => {
    const d = await api('/overview');
    const e = d.epg;
    const s = e.stats;
    const rebuild = h('button', { class: 'btn primary', disabled: !e.enabled || e.building, onclick: run(async () => {
      rebuild.disabled = true;
      rebuild.textContent = 'Bygger… (kan ta en minut)';
      await api('/epg/rebuild', { method: 'POST', body: {} });
      toast('Tablån är ombyggd');
      render();
    }) }, e.building ? 'Bygger…' : 'Bygg om nu');
    fill(main,
      head('Tablå', 'Sammanslagen tablå: originalet först, reservkällan fyller luckorna. Dispatcharr hämtar den från /epg/merged.xml.gz.', rebuild),
      !e.enabled ? h('section', { class: 'card' }, h('p', {}, 'Ingen originaltablå är inställd. Lägg in leverantörens XMLTV-länk under ', h('a', { href: '#settings', onclick: (ev) => { ev.preventDefault(); go('settings'); } }, 'Inställningar → Tablå'), '.'))
        : h('div', { class: 'grid' },
          h('section', { class: 'card' }, h('h3', {}, 'Status'), h('dl', { class: 'kv' },
            h('dt', {}, 'Byggd'), h('dd', {}, fmtAgo(e.builtAt)),
            s && h('dt', {}, 'Länder'), s && h('dd', {}, (s.countries || []).join(', ').toUpperCase() || '–'),
            s && h('dt', {}, 'Reservkällor'), s && h('dd', {}, s.fallbackSources ?? '–'),
            s && h('dt', {}, 'Matchade kanaler'), s && h('dd', {}, Object.entries(s.matchedByCountry || {}).map(([k, v]) => `${k.toUpperCase()} ${v}`).join(' · ') || s.matchedChannels),
            s && h('dt', {}, 'Ifyllda program'), s && h('dd', {}, s.addedProgrammes.toLocaleString('sv-SE')),
            s && h('dt', {}, 'Storlek'), s && h('dd', {}, fmtSize(s.bytes)),
            e.error && h('dt', {}, 'Fel'), e.error && h('dd', { class: 'error' }, e.error))),
          s && h('section', { class: 'card' }, h('h3', {}, 'Kanaler som fått mest ifyllt'),
            h('div', { class: 'table-wrap' }, h('table', {}, h('tbody', {},
              Object.entries(s.filled || {}).slice(0, 25).map(([k, v]) => h('tr', {}, h('td', {}, h('code', {}, k)), h('td', { class: 'num' }, `${v} program`))))))),
          !s && h('section', { class: 'card' }, h('p', { class: 'muted' }, 'Ingen statistik än – tablån har inte byggts om sedan servern startade. Klicka "Bygg om nu" för att se detaljer.'))));
  };
  await render();
}

// ---------------------------------------------------------------- data

let dataTab = 'reminders';
async function renderData(main) {
  const d = await api('/data');
  const tabs = [['reminders', 'Påminnelser', d.reminders], ['favorites', 'Favoriter', d.favorites], ['history', 'Historik', d.history]];
  const body = h('section', { class: 'card' });
  const remove = (kind, key) => api(`/data/${kind}/${encodeURIComponent(key)}`, { method: 'DELETE' }).then(() => renderData(main));
  const tables = {
    reminders: () => d.reminders.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'När'), h('th', {}, 'Program'), h('th', {}, 'Kanal'), h('th', {}, 'Tillagd av'), h('th', {}))),
      h('tbody', {}, d.reminders.map((r) => h('tr', {}, h('td', {}, fmtDate(r.start)), h('td', {}, h('b', {}, r.title)), h('td', { class: 'muted' }, r.channel?.name), h('td', { class: 'muted' }, r.addedBy || '–'),
        h('td', { class: 'act' }, confirmBtn('Ta bort', 'Säker?', () => remove('reminders', r.key)))))))
      : h('p', { class: 'empty' }, 'Inga kommande påminnelser.'),
    favorites: () => d.favorites.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Namn'), h('th', {}, 'Typ'), h('th', {}, 'Nytt'), h('th', {}, 'Tillagd av'), h('th', {}))),
      h('tbody', {}, d.favorites.map((f) => h('tr', {}, h('td', {}, h('b', {}, f.name)), h('td', { class: 'muted' }, { series: 'Serie', movie: 'Film', live: 'Kanal' }[f.type] || f.type),
        h('td', {}, f.newCount ? h('span', { class: 'pill warn' }, `${f.newCount} nya`) : '–'), h('td', { class: 'muted' }, f.addedBy || '–'),
        h('td', { class: 'act' }, confirmBtn('Ta bort', 'Säker?', () => remove('favorites', f.key)))))))
      : h('p', { class: 'empty' }, 'Inga favoriter.'),
    history: () => d.history.length ? [h('div', { class: 'row', style: { justifyContent: 'flex-end', marginBottom: '8px' } },
      confirmBtn('Rensa all historik', 'Klicka igen för att rensa allt', () => api('/data/history', { method: 'DELETE' }).then(() => renderData(main)))),
    h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Titel'), h('th', {}, 'Startad av'), h('th', {}, 'Senast'), h('th', {}, 'Position'), h('th', {}))),
      h('tbody', {}, d.history.map((e) => h('tr', {}, h('td', {}, h('b', {}, e.title), e.subtitle && h('div', { class: 'faint' }, e.subtitle)), h('td', { class: 'muted' }, e.startedBy || '–'),
        h('td', { class: 'faint' }, fmtAgo(e.lastAt)), h('td', { class: 'num' }, e.type === 'live' ? 'Live' : `${fmtTime(e.position)}${e.duration ? ` / ${fmtTime(e.duration)}` : ''}`),
        h('td', { class: 'act' }, confirmBtn('Ta bort', 'Säker?', () => remove('history', e.key)))))))]
      : h('p', { class: 'empty' }, 'Ingen historik.'),
  };
  const show = (t) => {
    dataTab = t;
    tabRow.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
    fill(body, h('div', { class: 'table-wrap' }, tables[t]()));
  };
  const tabRow = h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([id, label, list]) => h('button', { class: 'tab', 'data-t': id, role: 'tab', onclick: () => show(id) }, label, h('span', { class: 'count' }, list.length))));
  fill(main, head('Påminnelser och data', 'Rummets gemensamma påminnelser, favoriter och historik.'), tabRow, body);
  show(dataTab);
}

// ---------------------------------------------------------------- nedladdningar

async function renderDownloads(main) {
  let files = await api('/downloads');
  const list = h('section', { class: 'card' });
  const progress = h('div', { class: 'progress faint' });
  const picker = h('input', { type: 'file', multiple: true, hidden: true, onchange: () => upload([...picker.files]) });
  const drop = h('div', { class: 'drop', tabindex: '0', role: 'button', onclick: () => picker.click(), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); picker.click(); } } },
    h('b', {}, 'Släpp filer här'), ' eller klicka för att välja', h('div', { class: 'faint', style: { marginTop: '4px' } }, 'T.ex. Couchmates-Windows.zip, appens APK eller Apple TV-filen (.ipa)'));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); upload([...e.dataTransfer.files]); });

  async function upload(list) {
    for (const f of list) {
      const name = f.name.replace(/[^A-Za-z0-9._ -]+/g, '-');
      progress.textContent = `Laddar upp ${name} (${fmtSize(f.size)})…`;
      try {
        files = await api(`/downloads/${encodeURIComponent(name)}`, { method: 'PUT', raw: f });
        toast(`${name} uppladdad`);
      } catch (e) { toast(`${name}: ${e.message}`, true); }
    }
    progress.textContent = '';
    renderList();
  }
  function renderList() {
    fill(list, h('h3', {}, `Filer  ${files.length}`, h('span', { class: 'grow' }), h('a', { class: 'btn small', href: '/download', target: '_blank', rel: 'noopener' }, 'Öppna nedladdningssidan ↗')),
      files.length ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Fil'), h('th', {}, 'Beskrivning'), h('th', {}, 'Storlek'), h('th', {}, 'Uppladdad'), h('th', {}))),
        h('tbody', {}, files.map((f) => {
          const desc = h('input', { type: 'text', value: f.description, placeholder: 'Visas på nedladdningssidan', 'aria-label': `Beskrivning för ${f.name}` });
          desc.addEventListener('change', run(async () => { files = await api(`/downloads/${encodeURIComponent(f.name)}`, { method: 'PATCH', body: { description: desc.value } }); toast('Beskrivningen sparad'); }));
          return h('tr', {}, h('td', {}, h('a', { href: `/download/${encodeURIComponent(f.name)}` }, f.name)), h('td', {}, desc), h('td', { class: 'num' }, fmtSize(f.size)), h('td', { class: 'faint' }, fmtAgo(f.modified)),
            h('td', { class: 'act' }, confirmBtn('Ta bort', 'Säker?', async () => { files = await api(`/downloads/${encodeURIComponent(f.name)}`, { method: 'DELETE' }); renderList(); })));
        })))) : h('p', { class: 'empty' }, 'Inga filer uppladdade än.'));
  }
  fill(main, head('Nedladdningar', 'Filer som kompisarna kan ladda ner på /download. Sidan visar också hur man ansluter (men aldrig PIN-koden).'),
    h('div', { class: 'grid' }, h('section', { class: 'card wide' }, drop, picker, progress), h('div', { class: 'wide' }, list)));
  renderList();
}

// ---------------------------------------------------------------- plugins

async function renderPlugins(main) {
  let d = await api('/plugins');
  const listEl = h('div', { class: 'grid' });
  const picker = h('input', { type: 'file', accept: '.zip,.mjs,.js', hidden: true, onchange: run(async () => {
    const f = picker.files[0];
    if (!f) return;
    d = { ...d, ...(await api(`/plugins/upload?name=${encodeURIComponent(f.name)}`, { method: 'PUT', raw: f })) };
    toast(`${f.name} installerat – slå på det nedan`);
    picker.value = '';
    renderList();
  }) });
  const examples = h('div', { class: 'row' }, d.examples.length ? d.examples.map((f) => h('button', { class: 'btn small', onclick: run(async () => {
    d = { ...d, ...(await api('/plugins/example', { method: 'POST', body: { file: f } })) };
    toast(`${f} installerat – slå på det nedan`);
    renderList();
  }) }, `+ ${f.replace('.mjs', '')}`)) : h('span', { class: 'faint' }, 'Inga exempel'));

  function pluginCard(p) {
    const toggle = h('input', { type: 'checkbox', checked: p.enabled, 'aria-label': `Slå på ${p.name}` });
    toggle.addEventListener('change', run(async () => {
      d = { ...d, ...(await api(`/plugins/${p.id}/${toggle.checked ? 'enable' : 'disable'}`, { method: 'POST', body: {} })) };
      toast(`${p.name} ${toggle.checked ? 'påslagen' : 'avstängd'}`);
      renderList();
    }));
    const inputs = {};
    const settingsForm = p.settings.length ? h('form', { class: 'form', onsubmit: run(async (e) => {
      e.preventDefault();
      const body = {};
      for (const s of p.settings) { const v = inputs[s.key](); if (s.type === 'secret' && !v) continue; body[s.key] = v; }
      d = { ...d, ...(await api(`/plugins/${p.id}/settings`, { method: 'PUT', body })) };
      toast('Inställningarna sparade');
      renderList();
    }) }, p.settings.map((s) => {
      const id = `p-${p.id}-${s.key}`;
      let input;
      if (s.type === 'bool') { const cb = h('input', { type: 'checkbox', id, checked: Boolean(s.value) }); input = h('label', { class: 'switch' }, cb, h('span', {})); inputs[s.key] = () => cb.checked; }
      else { const el = h('input', { id, type: s.type === 'secret' ? 'password' : s.type === 'number' ? 'number' : 'text', value: s.type === 'secret' ? '' : s.value ?? '', autocomplete: 'off', placeholder: s.type === 'secret' ? (s.isSet ? '•••••••• (satt)' : 'Inte satt') : '' }); input = el; inputs[s.key] = () => el.value; }
      return h('div', { class: 'field' }, h('label', { for: id }, s.label || s.key), input, s.help && h('div', { class: 'help' }, s.help));
    }), h('div', {}, h('button', { class: 'btn primary small', type: 'submit' }, 'Spara inställningar'))) : null;
    return h('section', { class: 'card plugin' },
      h('div', { class: 'top' },
        h('div', { class: 'grow' }, h('div', { class: 'name' }, p.name, p.version && h('span', { class: 'faint', style: { fontWeight: 400, fontSize: '13px' } }, `  v${p.version}`)),
          h('div', { class: 'meta' }, h('code', {}, p.kind === 'zip' ? `${p.id}/ (zip)` : `${p.id}.mjs`), p.source && h('span', { class: 'pill ok', style: { marginLeft: '8px' } }, `i appens meny: ${p.source.name}`)),
          p.description && h('p', { class: 'muted', style: { margin: '6px 0 0' } }, p.description),
          p.requires && h('p', { class: 'faint', style: { margin: '4px 0 0', fontSize: '13px' } }, `Kräver: ${p.requires}`),
          p.homepage && h('a', { href: p.homepage, target: '_blank', rel: 'noopener', style: { fontSize: '13px' } }, 'Läs mer ↗')),
        h('label', { class: 'switch' }, toggle, h('span', {}))),
      p.error && h('p', { class: 'error', style: { margin: 0 } }, `Fel: ${p.error}`),
      p.enabled && (p.events.length || p.routes.length) ? h('div', { class: 'chips' },
        p.events.map((e) => h('span', { class: 'pill' }, `lyssnar: ${e}`)),
        p.routes.map((r) => { const path = r.split(' ')[1]; return r.startsWith('GET') ? h('a', { class: 'pill ok', href: path, target: '_blank', rel: 'noopener' }, `${path} ↗`) : h('span', { class: 'pill' }, r); })) : null,
      settingsForm && h('details', { open: p.enabled && p.settings.some((s) => s.type === 'secret' ? !s.isSet : false) }, h('summary', {}, 'Inställningar'), h('div', { style: { marginTop: '12px' } }, settingsForm)),
      h('div', { class: 'row' }, confirmBtn('Ta bort plugin', 'Klicka igen för att ta bort', async () => { d = { ...d, ...(await api(`/plugins/${p.id}`, { method: 'DELETE' })) }; toast(`${p.name} borttaget`); renderList(); })));
  }
  function renderList() {
    fill(listEl, d.plugins.length ? d.plugins.map(pluginCard) : h('p', { class: 'empty' }, 'Inga plugins installerade än. Installera ett exempel ovan eller ladda upp en egen .mjs-fil.'));
  }
  fill(main,
    head('Plugins', 'Utöka servern med egna funktioner. Ett plugin är en zip-fil (eller en enskild .mjs-fil) som kan lägga till källor i appens meny, reagera på händelser, lägga till egna sidor och ha egna inställningar.',
      h('button', { class: 'btn primary', onclick: () => picker.click() }, 'Ladda upp plugin (.zip eller .mjs)'), picker),
    h('p', { class: 'notice' }, h('b', {}, 'Bra att veta: '), 'plugins körs med samma rättigheter som servern. Installera bara plugins som du själv har skrivit eller litar på. Nya plugins är avstängda tills du slår på dem.'),
    h('section', { class: 'card', style: { margin: '16px 0' } }, h('h3', {}, 'Exempel att utgå från'), examples,
      h('details', { style: { marginTop: '12px' } }, h('summary', {}, 'Hur skriver man ett plugin?'), h('pre', { class: 'log', style: { height: 'auto', minHeight: 0, marginTop: '10px' } },
`export const meta = {
  name: 'Mitt plugin', version: '1.0', description: 'Vad det gör',
  settings: [{ key: 'url', label: 'Adress', type: 'text' }],   // text | secret | number | bool
};

export default function setup(api) {
  // Händelser: load, play, pause, seek, stop, member_join, member_leave, reminder, state
  api.on('load', ({ media, by }) => api.log(by + ' startade ' + media.title));
  // Egen sida: /plugins/<filnamn>/hej
  api.route('GET', '/hej', (req, res) => res.end('Hej!'));
  // Styr rummet: api.room.state(), members(), load(media), play(), pause(), seek(s), stop(), notify(text)
  // Inställningar: api.settings.url
  return () => { /* körs när pluginet stängs av */ };
}`))),
    listEl);
  renderList();
}

// ---------------------------------------------------------------- logg

async function renderLogs(main) {
  const box = h('div', { class: 'log', role: 'log', 'aria-live': 'off' });
  const filter = h('input', { type: 'text', placeholder: 'Filtrera, t.ex. "påminnelse" eller ett namn', style: { maxWidth: '340px' }, 'aria-label': 'Filtrera loggen' });
  const level = h('select', { 'aria-label': 'Nivå', style: { width: 'auto' } }, h('option', { value: '' }, 'Alla nivåer'), h('option', { value: 'warn' }, 'Varningar och fel'), h('option', { value: 'error' }, 'Bara fel'));
  let lines = [];
  const matches = (l) => (!level.value || (level.value === 'warn' ? l.level !== 'log' : l.level === 'error')) && (!filter.value || l.text.toLowerCase().includes(filter.value.toLowerCase()));
  const row = (l) => h('div', { class: `l lv-${l.level}` }, h('span', { class: 't' }, new Date(l.t).toLocaleTimeString('sv-SE')), h('span', {}, l.text));
  const redraw = () => { fill(box, lines.filter(matches).map(row)); box.scrollTop = box.scrollHeight; };
  filter.addEventListener('input', redraw);
  level.addEventListener('change', redraw);
  fill(main, head('Logg', 'Serverns logg i realtid. PIN-kod och lösenord tas bort innan något visas.', h('div', { class: 'row' }, level, filter)), box);
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

// ---------------------------------------------------------------- konto

function renderAccount(main) {
  const cur = h('input', { type: 'password', id: 'cur', autocomplete: 'current-password' });
  const pw = h('input', { type: 'password', id: 'npw', autocomplete: 'new-password', placeholder: 'Minst 8 tecken' });
  const pw2 = h('input', { type: 'password', id: 'npw2', autocomplete: 'new-password' });
  fill(main, head('Konto', 'Adminlösenordet skyddar den här panelen. Det är inte samma som rummets PIN-kod.'),
    h('div', { class: 'grid' },
      h('section', { class: 'card' }, h('h3', {}, 'Byt lösenord'),
        h('form', { class: 'form', onsubmit: run(async (e) => {
          e.preventDefault();
          if (pw.value !== pw2.value) throw new Error('Lösenorden är inte likadana');
          await api('/password', { method: 'POST', body: { current: cur.value, password: pw.value } });
          cur.value = pw.value = pw2.value = '';
          toast('Lösenordet är bytt. Andra inloggningar har loggats ut.');
        }) },
        h('div', { class: 'field' }, h('label', { for: 'cur' }, 'Nuvarande'), cur),
        h('div', { class: 'field' }, h('label', { for: 'npw' }, 'Nytt'), pw),
        h('div', { class: 'field' }, h('label', { for: 'npw2' }, 'Upprepa'), pw2),
        h('div', {}, h('button', { class: 'btn primary', type: 'submit' }, 'Byt lösenord')))),
      h('section', { class: 'card' }, h('h3', {}, 'Logga ut'), h('p', { class: 'muted' }, 'Inloggningen gäller i en vecka på den här enheten.'),
        h('button', { class: 'btn', onclick: run(async () => { await api('/logout', { method: 'POST', body: {} }); start(); }) }, 'Logga ut'))));
}

start();
