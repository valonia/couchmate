# Writing a Couchmate plugin

The Couchmate apps are a front end. They play video in sync, and they have search, favourites, history,
settings and translation built in. **Everything else comes from plugins**: the menu entries, the screens
behind them, search results, what is played, and how the player looks and reacts to the remote.

A plugin is a folder with a `plugin.json` and a JavaScript module. Zip the folder and upload it in the admin
panel (**Plugins → Upload plugin**), or put it in `server/plugins/` so that it ships with the server.

> Plugins run with the same rights as the server. Only install plugins you trust.

## Rules for text

- **Write everything in English.**
- Text the apps may translate goes through **`api.t()`**: `api.t('Live TV')`,
  `api.t('{n} viewers', { n: 12 })`. Each device sees it in its own language (or English).
- Plain strings are **never translated**. Use them for names and content: the plugin's name, channel names,
  programme titles, stream titles.
- Settings in the admin panel are always English and never translated.

## Files

```
my-plugin/
  plugin.json
  index.mjs        (plus any other files the module imports)
```

`plugin.json`:

```json
{
  "id": "youtube",
  "name": "YouTube",
  "version": "1.0.0",
  "description": "YouTube in Couchmate",
  "main": "index.mjs",
  "requires": "Internet access from the server to youtube.com",
  "homepage": "https://example.com/couchmate-youtube",
  "settings": [
    { "key": "apiKey", "label": "API key", "type": "secret", "required": true },
    { "key": "region", "label": "Region", "type": "select", "default": "SE", "options": ["SE", "NO", "US"] }
  ]
}
```

- `requires` is shown in the admin panel, so whoever installs the plugin knows what else is needed.
- Setting types: `text`, `secret` (never shown again), `number`, `bool`, `select` (`options` as strings or
  `{ "value", "label" }`). `required: true` reminds the admin to fill it in. Read them with `api.settings.<key>`.
  The plugin is restarted when its settings change.

## The module

```js
export default function setup(api) {
  api.source({
    name: 'YouTube',
    icon: 'M10 15l5-3-5-3z',                       // SVG path in a 24×24 box
    menu: [{ id: 'home', title: api.t('YouTube') }],  // optional – default: one entry named after the source
                                                     // (or an async function – see "The menu")

    async screen(menuId, ctx) { /* → a screen */ },
    async data(name, params, ctx) { /* → lazy data for a screen */ },
    async open(itemId, ctx) { /* → a detail screen for an item with action 'open' */ },
    async search(query, ctx) { /* → items, or { sections } */ },
    async resolve(itemId, { options }) { /* → where the stream is */ },
    async next(itemId) { /* → the item that plays after this one, or null */ },
    async episodes(itemId) { /* → [{ id, label }] for new-episode alerts */ },
    chat(itemId, onMessage) { /* → stop function */ },
    async action(itemId, actionId, { by }) { /* a button in the player's settings */ },
    player: { /* how the player looks and is controlled */ },
  });

  return () => { /* clean up when the plugin is switched off */ };
}
```

### The menu

`menu` is a list of entries, or an (async) function that returns one. Use a function to leave out entries
that have nothing to show right now – the IPTV plugin only shows Live TV, Movies and Series when Dispatcharr
has any. Call `api.menuChanged()` when the answer may have changed; the apps reload their menu straight away.

The admin decides the order in the admin panel (**App menu**) and can hide entries. Search is always at the
top and Settings always at the bottom of the app menu; Favorites and History can be placed anywhere in between.

Only `resolve` is required to play anything; add the rest as needed. `ctx.lang` is the device's language
(e.g. `sv`), in case your source can return content in that language.

### Items

Everything the apps show is an item:

```js
{
  id: 'abc123',               // unique within the plugin: letters, digits and _ . : @ ~ -
  title: 'Big Buck Bunny',
  subtitle: 'Blender · 2008',
  image: 'https://…',          // https, or /plugins/<id>/… served by your plugin (fetched with the PIN)
  backdrop: 'https://…',
  description: '…',
  kind: 'movie',              // free text: channel, movie, series, episode, stream, video …
  action: 'play',             // 'play' (default) or 'open' (calls open(id) for a detail screen)
  live: false,
  number: 12,                 // channel number
  viewers: 3400,
  year: '2008', genre: 'Animation', rating: 7.5, badge: api.t('New'), duration: 596,
  favorite: true,             // false = cannot be added to favourites
}
```

### Screens

`screen(menuId)` and `open(itemId)` return one of these:

```js
// Rows of cards
{ type: 'rows', rows: [{ id: 'top', title: api.t('Popular'), style: 'landscape', items: [...] }] }

// A list of groups on the left, the selected group's items on the right.
// Items are fetched with data('group', { menu, group }).
{ type: 'groups', style: 'channels' | 'posters' | 'landscape', guide: true, groups: [{ id, title }], initial: 'id' }

// A detail page, e.g. a series with seasons
{ type: 'detail', item: {...}, facts: ['2019', 'Drama'], seasons: [{ id, title: api.t('Season {n}', { n: 1 }), items: [...] }] }

// Just a message (e.g. "not set up yet")
{ type: 'message', text: api.t('Nothing here.') }
```

Any screen can also have `message`, shown above the content.

### Data

`data(name, params)` returns data that screens load when needed. These names have a fixed shape:

| name | params | returns |
|---|---|---|
| `group` | `menu`, `group` | `[item, …]` (or `{ items, message }`) |
| `epg` | `ids` (comma separated) | `{ [itemId]: [programme, …] }` – now and next for channels |
| `guide` | `id` | `[programme, …]` – the whole schedule for one channel |
| `channels` | `id` | `[item, …]` – the channels to zap between while `id` plays |

A programme is `{ title, description, start, end }` with times in seconds (Unix). Programmes get a
"remind me" option in the apps; at the start time the server switches everyone to that channel.

### Playing: `resolve`

```js
async resolve(itemId, { options }) {
  return {
    url: 'https://…/playlist.m3u8',   // or /plugins/<id>/… served by your plugin
    type: 'hls',                       // 'hls' or 'file' – guessed from the url if left out
    live: true,
    title: '…', subtitle: '…', image: '…', kind: 'stream',   // optional, wins over what the app sent
    player: { … },                     // optional: a player for this item only
  };
}
```

The apps never get this address directly. They play `/stream/<plugin>/<item id>`, and the server calls
`resolve` again when the answer is older than 8 minutes. That keeps expiring addresses working for people
who join later. HLS playlists are passed on with absolute addresses; anything else is a redirect.

When an item ends, the server calls `next(itemId)` and, if it returns an item, shows "next episode" and
plays it after the countdown set in the admin panel.

### The player

```js
player: {
  // What the remote's buttons do while playing:
  // pause | settings | chat | info | channels | channel_up | channel_down | seek_back | seek_forward | none
  keys: { ok: 'pause', up: 'info', down: 'settings', left: 'seek_back', right: 'seek_forward' },
  channels: true,   // you answer data('channels') – enables channel_up/down and the channel list
  guide: true,      // you answer data('epg') – the overlay shows what is on now and next
  // The boxes in the player's settings panel, in this order:
  settings: [
    { type: 'quality', title: api.t('Quality') },      // the stream's qualities (from the HLS playlist)
    { type: 'chat', title: api.t('Chat') },            // show/hide the chat (needs chat())
    { type: 'audio' }, { type: 'subtitles' },          // tracks in the stream
    { type: 'choice', id: 'latency', title: api.t('Latency'), default: 'low',
      options: [{ id: 'low', label: api.t('Low') }, { id: 'normal', label: api.t('Normal') }] },
                                                       // saved per device, sent to resolve() as options.latency
    { type: 'actions', id: 'clip', title: api.t('Clip'), options: [{ id: 'make', label: api.t('Make a clip') }] },
                                                       // buttons – call action(itemId, 'make')
  ],
}
```

Without `player`, OK pauses, ▼ and ▶ open the settings, ◀ opens the chat, and the panel shows chat,
quality, audio and subtitles.

### Chat

`chat(itemId, onMessage)` is called when live media plays and someone shows the chat. Call
`onMessage({ user, color, text })` for each message and return a function that closes the connection.

## The `api` object

| | |
|---|---|
| `api.id` | the plugin's id |
| `api.settings` | the current settings |
| `api.t(text, vars?)` | translatable text |
| `api.log(...)` | writes to the server log (shown in the admin panel) |
| `api.dataDir` | a folder for the plugin's own files (kept between restarts, removed with the plugin) |
| `api.cacheDir` | a folder for temporary files (emptied when the server starts) |
| `api.route(method, path, handler, { auth })` | an HTTP endpoint at `/plugins/<id><path>`. A path ending in `/*` matches everything below it. `auth`: `'pin'` (default – the apps), `'admin'` (logged in to the admin panel) or `'public'`. `handler(req, res, { path, query })` |
| `api.proxy(req, res, url, headers?)` | passes an upstream response on, with Range support (seeking) |
| `api.menuChanged()` | the menu (from a `menu()` function) may have changed – it is fetched again and the apps update |
| `api.link(label, url)` | a link on the plugin's card in the admin panel, e.g. a status page |
| `api.on(event, fn)` | events: `load`, `play`, `pause`, `seek`, `stop`, `ended`, `member_join`, `member_leave`, `reminder`, `state` |
| `api.room` | `state()`, `members()`, `load({ plugin, id, title… })`, `play()`, `pause()`, `seek(seconds)`, `stop()`, `notify(text)` |

## Examples

The plugins in this folder are complete examples:

- [`iptv/`](iptv/) – live TV with a programme guide, movies and series from Dispatcharr; its own stream proxy,
  a shared download for movies, the next episode, new-episode alerts and an admin status page.
- [`twitch/`](twitch/) – rows of live streams, search, HLS with quality choice, live chat and a player choice.
- [`discord/`](discord/) – no menu entry; only listens to events.
- [`now-playing/`](now-playing/) – a public web page using `api.route` and `api.room`.

`npm run plugins:zip` packs every folder here into `dist/<id>.zip`.
