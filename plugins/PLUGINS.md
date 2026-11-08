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

    async view(viewId, params, ctx) { /* → a view built from building blocks (menu entries and opened views) */ },
    async data(name, params, ctx) { /* → data a view loads when it needs it */ },
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
  action: 'play',             // 'play' (default) or 'open'
  view: 'show',               // for action 'open': the view that opens, with params { id }
  live: false,
  number: 12,                 // channel number
  viewers: 3400,
  year: '2008', genre: 'Animation', rating: 7.5, badge: api.t('New'), duration: 596,
  favorite: true,             // false = cannot be added to favourites
}
```

### Views

**What the apps show behind your menu entries is drawn from your own description.** `view(viewId, params)`
returns a view: a tree of building blocks. The apps only know how to draw the blocks; the layout – columns,
lists, cards, what shows where – is yours. A menu entry `{ id: 'live' }` asks for `view('live', {})`; the
action `{ open: 'show', params: { id: '…' } }` asks for `view('show', { id: '…' })` and pushes it (Back goes back).

```js
async view(id, params) {
  return {
    type: 'row', gap: 14,
    state: { group: 'news', channel: null },         // the view's own values, changed by "set"
    view: { title: 'Hello' },                        // fixed values, read as {{view.title}}
    refresh: 0,                                      // seconds: fetch the view again (state is kept)
    children: [ /* blocks */ ],
  };
}
```

#### Bindings

Any string can contain `{{…}}`:

| | |
|---|---|
| `{{item.title}}` | the current item (inside a list's `item` template, or a block's loaded `data`) |
| `{{state.channel.id}}` | the view's state |
| `{{view.title}}` | the view's fixed values (and its `params`) |
| `{{media.title}}`, `{{player.position}}` | in a player overlay (see below) |
| `{{a.b \|\| c.d}}` | the first one that is set |
| `{{item.items.length}}` | the length of a list |

A string that is only one binding keeps the value's type, so `'{{item}}'` passes the whole object along.
The app also works out these for any item: `$favorite`, `$newCount`, `$newLabel` (new episodes), `$playing`,
`$live` (between `start` and `end` right now), `$now`/`$next` (from the item's `programs` list) and
`$reminder` (for programmes in a list with `channel`).

#### Blocks

Every block can have `width`/`height` (dp, `'fill'` or `'65%'`), `weight` (share of the row/column),
`padding` (n, `[h, v]` or `[left, top, right, bottom]`), `background`, `radius`, `aspect`, `opacity`,
`align` (inside a `box`: `topStart`, `topEnd`, `center`, `bottomStart` …), `when` and `unless`
(a binding, or a list of them: `when` needs all to be set, `unless` hides if any is).

| type | |
|---|---|
| `row`, `column` | children side by side / on top of each other. `gap`, `align` (cross axis) |
| `box` | children on top of each other (use `align` on the children) |
| `spacer` | empty space (`width`, `height` or `weight`) |
| `text` | `text` (or `join: [...]` – parts with an empty binding are left out – and `separator`), `style`, `color`, `size`, `bold`, `maxLines`, `fallback` |
| `time` | `value` (seconds), `format`: `time` (21:30), `day` (Today, Tomorrow, Tuesday 10 November) or `datetime` – in the device's language |
| `image` | `src`, `fit` (`cover`/`contain`), `fallback` (text shown if there is no image) |
| `icon` | `path` (SVG path, 24×24) or `name` (`bell`, `star`, `search`, `play`, `history`, `live`, `movie`, `series`), `size`, `color` |
| `badge` | a small label: `text`, `color`, `textColor` |
| `progress` | a bar: `value` (0–1) or `start`/`end` (seconds – it moves by itself), `color`, `track` |
| `button` | `text`, `selected`, `onClick` |
| `list` | items in a list – see below |
| `grid` | items in a grid – like `list`, plus `minWidth` (the smallest column) and `rowGap` |
| `clock` | the time of day |
| `topbar` | (player overlays) the app's top strip: who did what, who is watching, the clock |

Styles: `title`, `headline`, `body`, `bodyStrong`, `caption`, `dim`, `faint`, `soft` (dimmed, follows a
focused row's colour), `label` (small capitals). Colours: `text`, `textSoft`, `dim`, `faint`, `accent`,
`gold`, `live`, `green`, `status`, `white`, `black`, `dark`, `track`, `trackSoft` or `#RRGGBB`.
Backgrounds: those colours plus `panel`, `panelHi`, `bg`, `accentSoft`, `heroFade`, `bottomFade`, `topFade`, `sideFade`.
Using these keeps every plugin looking like Couchmate.

#### Lists

```js
{
  type: 'list', id: 'channels',
  items: '{{item.items}}',                 // a binding – or "data": { name, params } to load them
  item: { type: 'row', children: [ … {{item.title}} … ] },   // the template for each item
  focus: 'row',                            // row | card | poster | pill | none (not focusable itself)
  direction: 'vertical',                   // or 'horizontal'
  itemHeight: 64, itemWidth: 300, gap: 2, aspect: 0.667,     // aspect: the shape of poster/card items
  label: '{{item.title}}', sublabel: '…',  // text under a poster
  selected: '{{state.group}}',             // the item with this id is marked as selected
  initial: '{{state.channel.id}}',         // focus lands here when entering the list
  autofocus: true,                         // takes focus when the view opens
  sectionBy: 'day',                        // day headings between items, by their "start"
  channel: '{{state.channel}}',            // programmes in this list belong to this channel ($reminder)
  enrich: { name: 'epg', as: 'programs', refresh: 180 },     // extra data per item: data(name, { ids }) → { id: value }
  empty: api.t('Nothing here.'),
  onFocus: { set: { channel: '{{item}}' } },
  onClick: { play: '{{item}}' },
  onLongClick: { favorite: '{{item}}' },
}
```

#### Actions

`onClick`, `onFocus` and `onLongClick` take an action, or a list of them:

| | |
|---|---|
| `{ play: '{{item}}' }` | plays the item for everyone (it needs an `id`; `subtitle` and `position` are optional) |
| `{ open: 'show', params: { id: '{{item.id}}' } }` | opens another view of yours on top (Back goes back) |
| `{ set: { channel: '{{item}}' } }` | changes the view's state – everything bound to it updates |
| `{ favorite: '{{item}}' }` | adds or removes a favourite |
| `{ remind: { channel: '{{state.channel}}', program: '{{item}}' } }` | adds or removes a reminder for a programme |
| `{ if: '{{item.$live}}', then: …, else: … }` | chooses an action |
| `{ back: true }` | closes the view |

#### Data

A block with `data: { name, params, delay, refresh }` loads `data(name, params)` from your plugin when it is
drawn (and again when the filled-in params change); inside it `{{item}}` is the answer. `delay` (ms) waits
while the user is still moving, `refresh` (s) loads again. These names are also used by the app itself
(favourite channels, the player's channel list), so give them this shape if you have them:

| name | params | returns |
|---|---|---|
| `group` | `menu`, `group` | `[item, …]` (or `{ items, message }`) |
| `epg` | `ids` (comma separated) | `{ [itemId]: [programme, …] }` – now and next for channels |
| `guide` | `id` | `[programme, …]` – the whole schedule for one channel |
| `channels` | `id` | `[item, …]` – the channels to zap between while `id` plays |

Any other name is passed on as it is. A programme is `{ title, description, start, end }` with times in
seconds (Unix). At a reminder's start time the server switches everyone to that channel.

The IPTV plugin's [views.mjs](iptv/views.mjs) builds Live TV (groups │ channels │ guide), Movies, Series and
a series page this way, and the Twitch plugin builds its rows of stream cards.

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
  overlay: { … },   // a view drawn on top of the video – see below
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

#### The overlay

`player.overlay` is a view (building blocks) drawn on top of the video while the overlay shows. It can bind to
`{{media.title}}`, `{{media.subtitle}}`, `{{media.image}}`, `{{media.id}}`, `{{media.live}}` and to
`{{player.position}}`, `{{player.duration}}`, `{{player.positionText}}`, `{{player.remainingText}}`,
`{{player.progress}}` (0–1), `{{player.paused}}`, `{{player.seeking}}`, `{{player.status}}` (buffering …) and
`{{player.hints}}` (what your keys do, in the device's language). Use `{ type: 'topbar' }` for the app's top
strip and `data` blocks for anything else (the IPTV plugin loads `data('now', { id })` for what is on).
Without an overlay the app shows its own.

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
