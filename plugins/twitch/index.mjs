// Twitch-plugin för Couchmates.
// - "Twitch" i appens meny: populära liveströmmar (och dina egna kanaler om du anger dem).
// - Sök i appen hittar även Twitch-kanaler som sänder just nu.
// - Liveströmmen spelas synkat för alla, precis som en TV-kanal.
//
// Data hämtas från Twitchs publika webbgränssnitt (samma sätt som t.ex. Streamlink och VLC gör),
// så inget Twitch-konto behövs. Ändrar Twitch något kan klient-id:t bytas i inställningarna.

const GQL = 'https://gql.twitch.tv/gql';
const USHER = 'https://usher.ttvnw.net/api/channel/hls';
const CHAT = 'wss://irc-ws.chat.twitch.tv:443';
const LOGO = 'M11.64 5.93h1.43v4.28h-1.43m3.93-4.28H17v4.28h-1.43M7 2 3.43 5.57v12.86h4.28V22l3.58-3.57h2.85L20.57 12V2m-1.43 9.29-2.85 2.85h-2.86l-2.5 2.5v-2.5H7.71V3.43h11.43z';

export const meta = {
  settings: [
    { key: 'channels', label: 'Dina kanaler (visas överst när de sänder)', type: 'text', default: '', help: 'Twitch-namn separerade med komma, t.ex. "lofigirl, xqc".' },
    { key: 'language', label: 'Språk för egen rad', type: 'text', default: 'sv', help: 'Visar en rad med populära strömmar på det språket, t.ex. "sv". Tomt = ingen sådan rad.' },
    { key: 'count', label: 'Antal populära strömmar (högst 30)', type: 'number', default: 30 },
    { key: 'clientId', label: 'Klient-id', type: 'text', default: 'kimne78kx3ncx6brgo4mv6wki5h1ko', help: 'Det klient-id som Twitchs webbsida använder. Byt bara om Twitch ändrar något.' },
  ],
};

export default function setup(api) {
  const open = new Set(); // öppna chattar (stoppfunktioner)
  const clientId = () => api.settings.clientId || 'kimne78kx3ncx6brgo4mv6wki5h1ko';

  async function gql(query, variables = {}) {
    const r = await fetch(GQL, {
      method: 'POST',
      headers: { 'Client-ID': clientId(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`Twitch svarade ${r.status}`);
    const d = await r.json();
    if (d.errors?.length) throw new Error(d.errors[0].message || 'Twitch gav ett fel');
    return d.data;
  }

  const STREAM_FIELDS = `
    id title viewersCount previewImageURL(width: 440, height: 248)
    broadcaster { login displayName }
    game { displayName }`;

  // Bilden byts ut ungefär var femte minut hos Twitch – lägg till en tidsstämpel så att den inte cachas för länge.
  const fresh = (u) => (u ? `${u}${u.includes('?') ? '&' : '?'}t=${Math.floor(Date.now() / 300000)}` : null);

  const toItem = (s) => s?.broadcaster?.login && {
    id: s.broadcaster.login,
    title: s.title || s.broadcaster.displayName,
    subtitle: [s.broadcaster.displayName, s.game?.displayName].filter(Boolean).join(' · '),
    image: fresh(s.previewImageURL),
    live: true,
    viewers: s.viewersCount,
  };

  /** Populära strömmar (Twitch ger högst 30 per anrop utan extra verifiering). */
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
    iconPath: LOGO,

    // Spelaren: pluginet bestämmer knapparna och vad som finns i inställningarna.
    player: {
      keys: { ok: 'pause', down: 'settings', right: 'chat', left: 'none', up: 'info' },
      settings: [
        { type: 'chat', title: 'Chatt' },
        { type: 'quality', title: 'Kvalitet' },
        {
          type: 'choice', id: 'latency', title: 'Fördröjning', default: 'low',
          options: [{ id: 'low', label: 'Låg (närmare live)' }, { id: 'normal', label: 'Normal (stabilare)' }],
        },
      ],
    },

    async browse() {
      const s = api.settings;
      const own = String(s.channels || '').split(',').map((x) => x.trim().toLowerCase()).filter((x) => /^[a-z0-9_]{1,40}$/.test(x));
      const [mine, local, top] = await Promise.all([
        channels(own).catch((e) => { api.log(`dina kanaler: ${e.message}`); return []; }),
        s.language ? popular(30, s.language).catch((e) => { api.log(`språkraden: ${e.message}`); return []; }) : [],
        popular(Number(s.count) || 30),
      ]);
      const sections = [];
      if (mine.length) sections.push({ id: 'mine', title: 'Dina kanaler', items: mine });
      if (local.length) sections.push({ id: 'lang', title: `Populärt på ${String(s.language).toLowerCase() === 'sv' ? 'svenska' : String(s.language).toUpperCase()}`, items: local });
      sections.push({ id: 'top', title: 'Populärt just nu', items: top });
      return { sections };
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
      if (!/^[A-Za-z0-9_]{1,40}$/.test(login)) throw new Error('Ogiltigt kanalnamn');
      const d = await gql(`query($login: String!) {
        streamPlaybackAccessToken(channelName: $login, params: { platform: "web", playerBackend: "mediaplayer", playerType: "site" }) { value signature }
      }`, { login: login.toLowerCase() });
      const tok = d.streamPlaybackAccessToken;
      if (!tok) throw new Error('Kanalen sänder inte just nu');
      const qs = new URLSearchParams({
        sig: tok.signature, token: tok.value, allow_source: 'true', allow_audio_only: 'true',
        fast_bread: options.latency === 'normal' ? 'false' : 'true', p: String(Math.floor(Math.random() * 1e7)),
      });
      return { url: `${USHER}/${login.toLowerCase()}.m3u8?${qs}` };
    },

    /** Livechatt: läser kanalens chatt anonymt (bara läsning, inget konto). */
    chat(login, onMessage) {
      if (!/^[A-Za-z0-9_]{1,40}$/.test(login)) throw new Error('Ogiltigt kanalnamn');
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
        ws.onerror = () => { /* onclose kommer efteråt */ };
      };
      connect();
      const stop = () => {
        stopped = true;
        clearTimeout(retry);
        try { ws?.close(); } catch { /* redan stängd */ }
        open.delete(stop);
      };
      open.add(stop);
      return stop;
    },
  });

  // Stäng alla chattar när pluginet stängs av.
  return () => { for (const stop of [...open]) stop(); };
}
