# Writing a Couchmate plugin

The Couchmate apps are a front end. They play video in sync, and they have search, favourites, history,
settings and translation built in. **Everything else comes from plugins**: the menu entries, the screens
behind them, search results, what is played, and how the player looks and reacts to the remote.

A plugin is a folder with a `plugin.json` and a JavaScript module. The server ships with none: the admin gets
them from GitHub in the admin panel (**Plugins → Get plugins**). Share yours as a public GitHub repository with
the plugin's files at the top and a release tagged `v<version>` – anyone can then install it by writing its
name (`owner/repo`), and it updates from there. While developing, zip the folder and upload it instead
(**Plugins → Upload plugin**).

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
  "repository": "your-name/couchmate-youtube",
  "needs": [{ "id": "other-plugin", "name": "Other plugin", "repository": "someone/couchmate-other" }],
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
- `repository` (optional) – a public GitHub repository (`owner/repo`) with the plugin's files at the top. The
  server checks its latest release every 6 hours; the admin panel then offers the update, or installs it by
  itself if the admin switched on **Update automatically** for the plugin. To release: raise `version`, commit,
  and publish a GitHub release tagged `v<version>` (e.g. `v1.2.0`). Settings and on/off are kept on update.
- `needs` (optional) – plugins this one builds on (see "Plugins that build on each other"). Installing it from
  GitHub without them shows a popup in the admin panel that installs them too; its card warns while one is
  missing or switched off.

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
    async favorite(item) { /* → what to save when someone adds a favourite (null = not allowed) – see "Favourites" */ },
    async status(itemIds) { /* → { id: { live, title, subtitle, image, viewers } } for favourites, every 2 min */ },
    chat(itemId, onMessage) { /* → stop function */ },
    async action(itemId, actionId, { by }) { /* a button in the player's settings */ },
    player: { /* how the player looks and is controlled */ },
    favoriteGroups: { /* optional: your own groups on the Favorites screen – see "Favourites" */ },
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
  kind: 'movie',              // free text: channel, movie, series, episode, stream, video, creator, playlist …
  action: 'play',             // 'play' (default) or 'open'
  view: 'show',               // for action 'open': the view that opens, with params { id }
  live: false,
  number: 12,                 // channel number
  viewers: 3400,
  year: '2008', genre: 'Animation', rating: 7.5, badge: api.t('New'), duration: 596,
  favorite: true,             // false = cannot be added to favourites
  unavailable: false,         // true = shown greyed out, never played (e.g. a song that was not found)
}
```

### Favourites

Anything with `favorite` not `false` can be added by holding OK (cards, rows, `{ favorite: '{{item}}' }`).

The Favorites screen shows them in groups. Name your own with `favoriteGroups` on the source – one per `kind`:

```js
api.source({
  name: 'TikTok',
  favoriteGroups: {
    creator: { title: api.t('TikTok creators'), order: 50, style: 'landscape' },
    video: { title: api.t('TikTok videos') },
  },
  …
});
```

- `title` – the group's heading (`api.t(…)` to have it translated).
- `order` – where the group goes (lower first). The usual ones: series 10, movies 20, channels 30, streams 40,
  creators 50, playlists 60, videos 70, other 99.
- `style` – `poster` (tall covers, like films), `landscape` (16:9 cards – the default) or `guide` (TV channels:
  a row with what is on now; needs `data('epg')`).

Leave out what you do not need: a missing `order` or `style` comes from the usual group for that kind. Kinds you
do not name share the usual groups with other plugins (`series`, `movie`, `channel`, `stream`, `creator`,
`playlist`, `video`); any other kind goes under "Other". Items with `action: 'open'` open their view from there.

Two optional hooks make favourites better:

- `favorite(item)` – decides what is saved. Return the item to keep (changed or not), or `null` to refuse.
  Twitch saves the *channel* here, not the stream that happens to be on.
- `status(ids)` – asked when the server starts, after a favourite is added, and every 2 minutes. Return
  `{ [id]: { live, title, subtitle, image, viewers } }` (each optional); it is shown over what was saved. Twitch
  uses it so a favourite channel shows LIVE with the current preview, or its offline picture when it is not live.

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
    captions: '/plugins/<id>/cc/…',    // optional: captions as WebVTT (see below)
  };
}
```

The apps never get this address directly. They play `/stream/<plugin>/<item id>`, and the server calls
`resolve` again when the answer is older than 8 minutes. That keeps expiring addresses working for people
who join later. HLS playlists are passed on with absolute addresses; anything else is a redirect.

**Captions.** Return `captions` (an address of your plugin's, or https) and add `{ type: 'captions', title: 'CC' }`
to the player's settings: the panel gets one switch, CC on/off, saved on each TV for every item that has
captions. Apps with CC on fetch the address with `?lang=<the TV's language>` added; answer with a WebVTT file
(`text/vtt`), or 404 when there is nothing for that item. Your plugin picks the best text – the YouTube plugin
takes the uploader's subtitles, then synced lyrics for songs, then YouTube's automatic captions.

When an item ends, the server calls `next(itemId)` and, if it returns an item, shows "next episode" and
plays it after the countdown set in the admin panel.

### The player

```js
player: {
  // What the remote's buttons do while playing:
  // pause | settings | chat | info | channels | channel_up | channel_down | seek_back | seek_forward | queue | none
  keys: { ok: 'pause', up: 'info', down: 'settings', left: 'seek_back', right: 'seek_forward' },
  overlay: { … },   // a view drawn on top of the video – see below
  channels: true,   // you answer data('channels') – enables channel_up/down and the channel list
  guide: true,      // you answer data('epg') – the overlay shows what is on now and next
  // The boxes in the player's settings panel, in this order:
  settings: [
    { type: 'quality', title: api.t('Quality') },      // the stream's qualities (from the HLS playlist)
    { type: 'chat', title: api.t('Chat') },            // show/hide the chat (needs chat())
    { type: 'audio' }, { type: 'subtitles' },          // tracks in the stream
    { type: 'captions', title: 'CC' },                 // CC on/off – the captions resolve() gives (see above)
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

#### The queue

Add `queue: true` to `player` and answer `data('queue', { id })` with `{ title, current, items: [item, …] }`
(`current` = the id playing now). A key with the action `queue` (e.g. `up: 'queue'`) then opens a list to the
right of the video – where the chat goes – showing what plays next; OK plays the chosen item for everyone.
When `items` is empty the key shows the overlay instead. The YouTube plugin uses it for playlists.

#### Songs that follow straight on

`upNextBefore: 10` in `player` shows "next" 10 seconds (at most 30) before the end instead of after it. The
server prepares the next item in advance, the apps buffer it behind the one playing, and when this one ends the
next starts at once – if every app watching has buffered it. Otherwise everyone waits for each other as usual,
so nobody misses the start. Back cancels: this one plays to the end and stops.
Good for music; without it, "next" counts down after the end (for episodes).

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
| `api.expose(name, fn)` | offers a function to other plugins (see below) |
| `api.use(pluginId, name, …args)` | calls a function another plugin offers – throws if it is not installed and on |
| `api.has(pluginId, name)` | whether that plugin is on and offers that function |
| `api.providers(name)` | the plugins that are on and offer a function – e.g. every extension of yours |
| `api.room` | `state()`, `members()`, `load({ plugin, id, title… })`, `play()`, `pause()`, `seek(seconds)`, `stop()`, `notify(text)` |

## Plugins that build on each other

A plugin can offer functions with `api.expose` and use another plugin's with `api.use` – so one plugin can extend
another. The Spotify → YouTube plugin does this: it has no menu entry or screens (no `api.source`); it uses
YouTube's `findVideo` to match songs to videos and offers `youtubeRows` and `youtubeList`, which YouTube shows at
the top of its front page when `spotify-youtube` is written as a topic. List `needs` in plugin.json so the admin
panel installs what yours builds on.

## Examples

Complete plugins to learn from:

- [valonia/couchmate-iptv-dispatcharr](https://github.com/valonia/couchmate-iptv-dispatcharr) – live TV with a
  programme guide, movies and series from Dispatcharr; its own stream proxy, a shared download for movies, the
  next episode, new-episode alerts and an admin status page.
- [valonia/couchmate-twitch](https://github.com/valonia/couchmate-twitch) – a front page built from views, search,
  HLS with quality choice, live chat, and favourite channels that show when they are live (`favorite`, `status`).
- [valonia/couchmate-youtube](https://github.com/valonia/couchmate-youtube) – videos, channels and playlists, a
  queue, songs that follow straight on (`upNextBefore`), and video and audio as separate files. Offers
  `findVideo`, and shows lists from extensions.
- [valonia/couchmate-spotify-youtube](https://github.com/valonia/couchmate-spotify-youtube) – an extension of
  YouTube: logging in with OAuth (PKCE), a status page in the admin panel, data kept in `api.dataDir`, `needs`.

The plugins listed under **Get plugins** are the public repositories by `valonia` with the topic
`couchmate-plugin`.
