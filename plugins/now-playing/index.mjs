// Now playing page at /plugins/now-playing/ – no login needed, and it shows no secrets (only titles and names).

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plain = (v) => (v && typeof v === 'object' && typeof v.$t === 'string' ? v.$t : v);

export default function setup(api) {
  api.route('GET', '/data', (req, res) => {
    const st = api.room.state();
    const m = st.media;
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      media: m ? { title: plain(m.title), subtitle: plain(m.subtitle), live: m.live } : null,
      paused: st.paused,
      viewers: api.room.members().filter((x) => x.watching).map((x) => x.name),
    }));
  }, { auth: 'public' });

  api.route('GET', '/', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(api.settings.title)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0a0c10; color: #f2f4f8;
         font: 18px/1.4 "Segoe UI", system-ui, sans-serif; }
  main { text-align: center; padding: 24px; max-width: 720px; }
  h1 { font-size: 14px; letter-spacing: .14em; text-transform: uppercase; color: #3d7bff; margin: 0 0 22px; }
  .t { font-size: 34px; font-weight: 700; margin: 18px 0 4px; }
  .s { color: #a3abb9; }
  .v { margin-top: 18px; color: #616a7a; }
  .p { display: inline-block; margin-top: 10px; padding: 3px 10px; border-radius: 999px; background: #1a1f29; color: #f5c451; font-size: 14px; }
</style></head><body><main>
<h1>${esc(api.settings.title)}</h1>
<div id="c">Loading…</div>
</main>
<script>
async function tick() {
  try {
    const d = await (await fetch('data')).json();
    const c = document.getElementById('c');
    if (!d.media) { c.innerHTML = '<div class="t">Nothing is playing</div>'; return; }
    c.innerHTML = '<div class="t"></div><div class="s"></div>' + (d.paused ? '<div class="p">Paused</div>' : '') + '<div class="v"></div>';
    c.querySelector('.t').textContent = d.media.title;
    c.querySelector('.s').textContent = d.media.subtitle || (d.media.live ? 'Live' : '');
    c.querySelector('.v').textContent = d.viewers.length ? 'Watching: ' + d.viewers.join(', ') : '';
  } catch {}
}
tick(); setInterval(tick, 5000);
</script></body></html>`);
  }, { auth: 'public' });

  api.link('Open the page', `/plugins/${api.id}/`);
}
