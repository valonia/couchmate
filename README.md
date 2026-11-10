# Couchmate – watch together

Everyone who is connected sees **the same** thing at the same time, in sync. Anyone can switch, pause and seek
with the remote, and it changes for everyone.

This is the **Couchmate server**: the shared room, favourites, history, reminders, new-episode alerts,
translation, the admin panel and the plugin host. The apps are a front end – they play video in sync and draw
what the plugins describe. **Everything else comes from plugins** – live TV, movies, series, Twitch, YouTube and
whatever comes next. Plugins decide what the menu shows, what each screen looks like, what is played and how the
player reacts to the remote.

```
 Plugins (IPTV, Twitch, YouTube, …) ──► Couchmate server (Node, port 8787) ◄──WebSocket──► the apps
                                          room · favourites · history ·
                                          reminders · admin panel · translation
```

| Repository | |
|---|---|
| **couchmate** (this one) | The server, and [how to write a plugin](PLUGINS.md) |
| [couchmate-android](https://github.com/valonia/couchmate-android) | The Android TV app |
| [couchmate-twitch](https://github.com/valonia/couchmate-twitch), [couchmate-youtube](https://github.com/valonia/couchmate-youtube), [couchmate-iptv-dispatcharr](https://github.com/valonia/couchmate-iptv-dispatcharr), [couchmate-spotify-youtube](https://github.com/valonia/couchmate-spotify-youtube) | Plugins – installed from the admin panel |

## 1. Start the server

```bash
docker compose up -d --build
```

The container is called `couchmate`. Without Docker: install Node 22 or later, run `npm install` and then `npm start`.

## 2. Set it up in the admin panel

Open `http://<server>:8787/admin`:

1. **Create the admin password.** The first person to open the panel creates it, so do this straight away.
2. **Settings → PIN code.** The apps cannot connect until a PIN is set.
3. **Plugins → Get plugins.** Install the plugins you want from GitHub, switch them on and fill in their
   settings. Each plugin can update by itself (**Update automatically**) when a new version is released.
   - **IPTV** needs [Dispatcharr](https://github.com/Dispatcharr/Dispatcharr) with an Xtream user.
   - **Twitch** and **YouTube** work straight away.
4. **App menu** sets the order of the menu in the apps and of the groups on the Favorites screen.

The panel also shows what is playing and who is connected, lets you manage reminders, favourites and history,
hosts the app downloads (`http://<server>:8787/download`) and shows the server log live.

### Friends outside your home network
Forward a port to the server, preferably behind a reverse proxy with HTTPS (Caddy or Nginx) since the PIN is
otherwise sent unencrypted – or use Tailscale.

## Plugins

Plugins are plain JavaScript modules. [PLUGINS.md](PLUGINS.md) explains everything a plugin can do: menu entries,
screens built from building blocks, search, playback, the player's keys and settings, queues, favourites, chat,
and plugins that build on each other. Share a plugin as a public GitHub repository with releases; give it the topic
`couchmate-plugin`.

## Languages

Plugins and apps are written in English. Menus and buttons are translated into each device's language on the
server, and every translation is cached so it is only made once. Corrections can be made in the admin panel.
Names and content (channel names, titles) are never translated. See [PLUGINS.md](PLUGINS.md#rules-for-text).

## How the sync works

- **Clock sync:** every device measures the difference between its own clock and the server's (NTP-like, via ping).
- **Start, play and seek:** the server pauses everyone at the same position and waits until everyone has buffered
  (at most 12 s, configurable). Then everyone starts at exactly the same server time.
- **While playing:** every device compares its position with the expected one. Small differences (over 0.3 s) are
  corrected by playing 1–8 % faster or slower, so it is not noticeable. Large ones (over 2 s) are corrected with a seek.
- **Songs that follow straight on:** for music, "next" shows 10 s before the end; the apps buffer the next song and
  it starts without a pause when every app has it.
- **Live:** everyone watches the same channel, but live streams cannot be seeked, so devices can differ by 1–5 s
  depending on buffering.

## Good to know

- There is **one room** per server. For several groups, run several servers on different ports.
- With the IPTV plugin in proxy mode, all video goes through the server, so Dispatcharr does not need to be
  exposed and nobody sees the Xtream password.
