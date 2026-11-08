// Twitch plugin for Couchmate.
// - "Twitch" in the app menu: popular live streams (and your own channels if you list them).
// - Search in the app also finds Twitch channels that are live right now.
// - The live stream plays in sync for everyone, with the chat next to it.
//
// Data comes from Twitch's public web interface (the same way Streamlink and VLC do it),
// so no Twitch account is needed. If Twitch changes something, the client ID can be changed in the settings.

const GQL = 'https://gql.twitch.tv/gql';
const USHER = 'https://usher.ttvnw.net/api/channel/hls';
const CHAT = 'wss://irc-ws.chat.twitch.tv:443';
const LOGO = 'M11.64 5.93h1.43v4.28h-1.43m3.93-4.28H17v4.28h-1.43M7 2 3.43 5.57v12.86h4.28V22l3.58-3.57h2.85L20.57 12V2m-1.43 9.29-2.85 2.85h-2.86l-2.5 2.5v-2.5H7.71V3.43h11.43z';
const DEFAULT_CLIENT = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const LOGIN = /^[A-Za-z0-9_]{1,40}$/;

export default function setup(api) {
  const open = new Set(); // open chats (stop functions)
  const clientId = () => api.settings.clientId || DEFAULT_CLIENT;

  async function gql(query, variables = {}) {
    const r = await fetch(GQL, {
      method: 'POST',
      headers: { 'Client-ID': clientId(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`Twitch answered ${r.status}`);
    const d = await r.json();
    if (d.errors?.length) throw new Error(d.errors[0].message || 'Twitch returned an error');
    return d.data;
  }

  const STREAM_FIELDS = `
    id title viewersCount previewImageURL(width: 440, height: 248)
    broadcaster { login displayName }
    game { displayName }`;

  // Twitch replaces the preview about every five minutes – add a timestamp so it is not cached too long.
  const fresh = (u) => (u ? `${u}${u.includes('?') ? '&' : '?'}t=${Math.floor(Date.now() / 300000)}` : null);

  const toItem = (s) => s?.broadcaster?.login && {
    id: s.broadcaster.login,
    kind: 'stream',
    live: true,
    title: s.title || s.broadcaster.displayName,
    subtitle: [s.broadcaster.displayName, s.game?.displayName].filter(Boolean).join(' · '),
    image: fresh(s.previewImageURL),
    viewers: s.viewersCount,
    viewersText: api.t('{n} viewers', { n: compact(s.viewersCount || 0) }),
  };

  // A stream card: the preview with LIVE and viewers, the channel and the stream's title.
  const streamCard = {
    type: 'column', children: [
      {
        type: 'box', aspect: 1.7778, width: 'fill', children: [
          { type: 'image', src: '{{item.image}}', fallback: '{{item.subtitle}}', fit: 'cover', width: 'fill', height: 'fill', radius: 12 },
          {
            type: 'row', align: 'topStart', padding: 8, gap: 6, children: [
              { type: 'badge', text: 'LIVE', color: 'live' },
              { type: 'badge', text: '{{item.viewersText}}', color: 'dark' },
            ],
          },
          { type: 'badge', text: '★', color: 'dark', textColor: 'gold', align: 'topEnd', padding: 6, when: '{{item.$favorite}}' },
        ],
      },
      {
        type: 'column', padding: [12, 10, 12, 10], children: [
          { type: 'text', text: '{{item.subtitle}}', style: 'bodyStrong', size: 15, maxLines: 1 },
          { type: 'text', text: '{{item.title}}', size: 13, maxLines: 2, padding: [0, 2, 0, 0] },
        ],
      },
    ],
  };

  // On top of the video: who did what, the channel and the stream, LIVE and the key hints.
  const overlay = {
    type: 'box', width: 'fill', height: 'fill', children: [
      { type: 'topbar', align: 'topStart' },
      {
        type: 'column', align: 'bottomStart', width: 'fill', background: 'bottomFade', padding: [56, 80, 56, 40], children: [
          {
            type: 'row', align: 'center', children: [
              { type: 'image', src: '{{media.image}}', fallback: '{{media.subtitle}}', fit: 'cover', width: 150, height: 84, radius: 10 },
              { type: 'spacer', width: 24 },
              {
                type: 'column', weight: 1, children: [
                  {
                    type: 'row', align: 'center', children: [
                      { type: 'text', text: '{{media.subtitle || media.title}}', style: 'title', size: 22, maxLines: 1 },
                      { type: 'spacer', width: 12 },
                      { type: 'badge', text: 'LIVE', color: 'live' },
                    ],
                  },
                  { type: 'spacer', height: 6 },
                  { type: 'text', text: '{{media.title}}', style: 'dim', size: 18, maxLines: 2, when: '{{media.subtitle}}' },
                ],
              },
            ],
          },
          { type: 'spacer', height: 16 },
          {
            type: 'row', children: [
              { type: 'text', text: '{{player.status}}', color: 'status', size: 14 },
              { type: 'spacer', weight: 1 },
              { type: 'text', text: '{{player.hints}}', style: 'faint', size: 13 },
            ],
          },
        ],
      },
    ],
  };

  const compact = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} M` : n >= 10_000 ? `${Math.floor(n / 1000)} k` : n >= 1000 ? `${(n / 1000).toFixed(1)} k` : String(n));

  /** Popular streams (Twitch gives at most 30 per request without extra verification). */
  async function popular(count, language) {
    const first = Math.min(30, Math.max(1, count));
    const opts = language ? ', options: { broadcasterLanguages: [$lang] }' : '';
    const query = `query($first: Int!${language ? ', $lang: Language!' : ''}) {
      streams(first: $first${opts}) { edges { node { ${STREAM_FIELDS} } } }
    }`;
    const vars = { first };
    if (language) vars.lang = language.toUpperCase();
    const d = await gql(query, vars);
    return (d.streams?.edges || []).map((e) => toItem(e.node)).filter(Boolean);
  }

  async function channels(logins) {
    if (!logins.length) return [];
    const d = await gql(`query($logins: [String!]) { users(logins: $logins) { login displayName stream { ${STREAM_FIELDS} } } }`, { logins });
    return (d.users || []).filter((u) => u?.stream).map((u) => toItem({ ...u.stream, broadcaster: { login: u.login, displayName: u.displayName } })).filter(Boolean);
  }

  api.source({
    name: 'Twitch',
    icon: LOGO,

    // The player: this plugin decides the keys and what is in the settings panel.
    player: {
      keys: { ok: 'pause', down: 'settings', right: 'chat', left: 'none', up: 'info' },
      overlay,
      settings: [
        { type: 'chat', title: api.t('Chat') },
        { type: 'quality', title: api.t('Quality') },
        {
          type: 'choice', id: 'latency', title: api.t('Latency'), default: 'low',
          options: [{ id: 'low', label: api.t('Low (closer to live)') }, { id: 'normal', label: api.t('Normal (more stable)') }],
        },
      ],
    },

    /** The Twitch page: a row of stream cards per section. Built here from building blocks; the apps draw it. */
    async view() {
      const s = api.settings;
      const own = String(s.channels || '').split(',').map((x) => x.trim().toLowerCase()).filter((x) => LOGIN.test(x));
      const lang = String(s.language || '').trim().toLowerCase();
      const [mine, local, top] = await Promise.all([
        channels(own).catch((e) => { api.log(`your channels: ${e.message}`); return []; }),
        lang ? popular(30, lang).catch((e) => { api.log(`language row: ${e.message}`); return []; }) : [],
        popular(Number(s.count) || 30),
      ]);
      const rows = [];
      if (mine.length) rows.push({ id: 'mine', title: api.t('Your channels'), items: mine });
      if (local.length) rows.push({ id: 'lang', title: api.t('Popular in {language}', { language: lang.toUpperCase() }), items: local });
      rows.push({ id: 'top', title: api.t('Popular right now'), items: top });
      return {
        type: 'column', refresh: 60, children: [
          {
            type: 'row', align: 'center', padding: [12, 0, 0, 10], children: [
              { type: 'icon', path: LOGO, size: 28, color: 'accent' },
              { type: 'spacer', width: 12 },
              { type: 'text', text: 'Twitch', style: 'title', size: 26 },
            ],
          },
          {
            type: 'list', id: 'rows', weight: 1, items: rows, focus: 'none', gap: 18,
            item: {
              type: 'column', children: [
                {
                  type: 'row', padding: [12, 0, 0, 8], children: [
                    { type: 'text', text: '{{item.title}}', style: 'headline', size: 20 },
                    { type: 'text', text: '  {{item.items.length}}', style: 'faint', size: 20 },
                  ],
                },
                {
                  type: 'list', id: 'row-{{item.id}}', direction: 'horizontal', items: '{{item.items}}', focus: 'card',
                  itemWidth: 300, gap: 16, padding: [12, 10, 12, 10],
                  onClick: { play: '{{item}}' }, onLongClick: { favorite: '{{item}}' },
                  item: streamCard,
                },
              ],
            },
          },
        ],
      };
    },

    async search(q) {
      const d = await gql(`query($q: String!) {
        searchFor(userQuery: $q, platform: "web") {
          channels { edges { item { ... on User { login displayName stream { ${STREAM_FIELDS} } } } } }
        }
      }`, { q });
      return (d.searchFor?.channels?.edges || [])
        .map((e) => e.item)
        .filter((u) => u?.stream)
        .map((u) => toItem({ ...u.stream, broadcaster: { login: u.login, displayName: u.displayName } }))
        .filter(Boolean);
    },

    async resolve(login, { options = {} } = {}) {
      if (!LOGIN.test(login)) throw new Error('Invalid channel name');
      const d = await gql(`query($login: String!) {
        streamPlaybackAccessToken(channelName: $login, params: { platform: "web", playerBackend: "mediaplayer", playerType: "site" }) { value signature }
        user(login: $login) { displayName stream { title game { displayName } } }
      }`, { login: login.toLowerCase() });
      const tok = d.streamPlaybackAccessToken;
      if (!tok || !d.user?.stream) throw new Error('The channel is not live right now');
      const qs = new URLSearchParams({
        sig: tok.signature, token: tok.value, allow_source: 'true', allow_audio_only: 'true',
        fast_bread: options.latency === 'normal' ? 'false' : 'true', p: String(Math.floor(Math.random() * 1e7)),
      });
      return {
        url: `${USHER}/${login.toLowerCase()}.m3u8?${qs}`,
        type: 'hls',
        live: true,
        kind: 'stream',
        title: d.user.stream.title || d.user.displayName,
        subtitle: [d.user.displayName, d.user.stream.game?.displayName].filter(Boolean).join(' · '),
      };
    },

    /** Live chat: reads the channel's chat anonymously (read only, no account). */
    chat(login, onMessage) {
      if (!LOGIN.test(login)) throw new Error('Invalid channel name');
      const chan = login.toLowerCase();
      let ws = null;
      let stopped = false;
      let retry = null;
      let wait = 2000;
      const connect = () => {
        ws = new WebSocket(CHAT);
        ws.onopen = () => {
          wait = 2000;
          ws.send('CAP REQ :twitch.tv/tags');
          ws.send('PASS SCHMOOPIIE');
          ws.send(`NICK justinfan${10000 + Math.floor(Math.random() * 80000)}`);
          ws.send(`JOIN #${chan}`);
        };
        ws.onmessage = (ev) => {
          for (const line of String(ev.data).split('\r\n')) {
            if (!line) continue;
            if (line.startsWith('PING')) { ws.send(line.replace('PING', 'PONG')); continue; }
            const m = /^(?:@(\S+) )?:([^!\s]+)!\S+ PRIVMSG #\S+ :(.*)$/.exec(line);
            if (!m) continue;
            const tags = Object.fromEntries((m[1] || '').split(';').map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; }));
            let text = m[3];
            const action = /^\u0001ACTION (.*)\u0001$/.exec(text);
            if (action) text = action[1];
            const user = (tags['display-name'] || m[2]).replace(/\s/g, ' ');
            onMessage({ user, color: tags.color || null, text });
          }
        };
        ws.onclose = () => {
          if (stopped) return;
          retry = setTimeout(connect, wait);
          wait = Math.min(wait * 2, 60000);
        };
        ws.onerror = () => { /* onclose follows */ };
      };
      connect();
      const stop = () => {
        stopped = true;
        clearTimeout(retry);
        try { ws?.close(); } catch { /* already closed */ }
        open.delete(stop);
      };
      open.add(stop);
      return stop;
    },
  });

  // Close every chat when the plugin is switched off.
  return () => { for (const stop of [...open]) stop(); };
}
