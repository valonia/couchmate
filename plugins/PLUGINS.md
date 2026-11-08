# Skriva ett plugin för Couchmates

Ett plugin är en zip-fil som laddas upp i kontrollpanelen (**Plugins → Ladda upp**) och slås på där.
Det kan lägga till en egen källa i apparna (som Twitch): ett menyval, träffar i sök, strömmar som
spelas synkat för alla, och en egen spelare. Inget behöver ändras i servern eller apparna.

> Plugins kör med samma rättigheter som servern. Installera bara plugins du litar på.

## Filerna i zip-filen

```
mitt-plugin/
  plugin.json
  index.mjs
```

`plugin.json`:

```json
{
  "id": "youtube",
  "name": "YouTube",
  "version": "1.0.0",
  "description": "YouTube i Couchmates",
  "main": "index.mjs",
  "requires": "Internetanslutning från servern till youtube.com"
}
```

`requires` visas i kontrollpanelen, så att den som installerar vet vad som behövs
(t.ex. "en Docker-container med X").

## Koden

```js
export const meta = {
  // Inställningar som visas i kontrollpanelen (läses med api.settings.<key>)
  settings: [{ key: 'apiKey', label: 'API-nyckel', type: 'text', default: '' }],
};

export default function setup(api) {
  api.source({
    name: 'YouTube',
    iconPath: 'M10 15l5-3-5-3z',          // ikonen i menyn: en SVG-sökväg i en 24×24-ruta

    // Det som visas när man väljer källan i menyn
    async browse() {
      return { sections: [{ id: 'popular', title: 'Populärt', items: [/* item, … */] }] };
    },

    // Träffar när man söker i appen
    async search(q) { return [/* item, … */]; },

    // Strömmen som ska spelas (HLS, .m3u8). options = valen från spelarens inställningar (se nedan).
    async resolve(itemId, { options }) {
      return { url: 'https://…/playlist.m3u8' };
    },

    // Valfritt: livechatt. Anropa onMessage för varje meddelande, returnera en stoppfunktion.
    chat(itemId, onMessage) {
      // onMessage({ user: 'Karin', color: '#FF8800', text: 'Hej!' })
      return () => { /* stäng anslutningen */ };
    },

    // Valfritt: knappar i spelarens inställningar (type 'actions').
    async action(itemId, actionId, { by }) {
      api.room.notify(`${by} tryckte på ${actionId}`);
    },

    // Valfritt: hur spelaren ser ut och styrs.
    player: { keys: { /* … */ }, settings: [ /* … */ ] },
  });

  return () => { /* städa upp när pluginet stängs av */ };
}
```

Ett **item** ser ut så här:

```js
{ id: 'abc123', title: 'Videons titel', subtitle: 'Kanal · Kategori', image: 'https://…/bild.jpg', live: false, viewers: 1234 }
```

`image` måste vara en `https`-adress. `live: true` gör att strömmen behandlas som live
(ingen spolning).

## Spelaren

Med `player` bestämmer pluginet vad fjärrkontrollens knappar gör och vad som finns i
inställningspanelen. Det gäller alla appar (Android TV, Apple TV och Windows).

### Knappar: `keys`

```js
keys: { ok: 'pause', up: 'info', down: 'settings', left: 'none', right: 'chat' }
```

| Värde      | Vad som händer                       |
|------------|--------------------------------------|
| `pause`    | Pausa eller spela (för alla)         |
| `settings` | Öppna inställningspanelen            |
| `chat`     | Visa eller dölj chatten (kräver `chat`) |
| `info`     | Visa titel och info                  |
| `none`     | Ingenting                            |

Hjälptexten längst ner i spelaren byggs automatiskt utifrån knapparna.
På Windows gäller samma sak för piltangenterna och Enter.

### Inställningspanelen: `settings`

En lista med rutor som visas i den ordningen:

| Ruta | Vad den visar |
|------|---------------|
| `{ type: 'quality', title: 'Kvalitet' }` | Strömmens kvaliteter. Läses från HLS-spellistan, pluginet behöver inte göra något. |
| `{ type: 'chat', title: 'Chatt' }` | Visa/dölj chatten. Kräver `chat`. |
| `{ type: 'audio', title: 'Ljud' }` | Ljudspåren i strömmen (visas bara om det finns fler än ett). |
| `{ type: 'subtitles', title: 'Undertext' }` | Undertexterna i strömmen (visas bara om det finns några). |
| `{ type: 'choice', id, title, options: [{ id, label }], default }` | Ett eget val. Sparas per enhet och skickas till `resolve()` som `options[id]`. Strömmen laddas om när man byter. |
| `{ type: 'actions', id, title, options: [{ id, label }] }` | Knappar. Anropar `action(itemId, knappens id)` på servern. Kräver `action`. |

`title` kan utelämnas för de inbyggda rutorna – då används en standardtext.

### Exempel (Twitch-pluginet)

```js
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
```

och i `resolve`:

```js
async resolve(login, { options }) {
  const lowLatency = options.latency !== 'normal';
  // …
}
```

### Utan `player`

Om pluginet inte anger något används: OK pausar, ▼ och ▶ öppnar inställningarna, ◀ visar chatten
(om det finns), och panelen visar chatt, kvalitet och ljud.

## Mer som pluginet kan göra

- `api.on(händelse, fn)`: `load`, `play`, `pause`, `seek`, `stop`, `member_join`, `member_leave`, `reminder`, `state`
- `api.room`: `state()`, `members()`, `load(media)`, `play()`, `pause()`, `seek(sekunder)`, `stop()`, `notify(text)`
- `api.route('GET', '/sökväg', (req, res) => …)`: egna adresser under `/plugins/<id>/…`
- `api.settings`: värdena från kontrollpanelen
- `api.log(...)`: syns i kontrollpanelens logg

## Bygga zip-filen

Lägg mappen i `server/plugins/` och kör:

```
node plugins/build.mjs
```

Zip-filen hamnar i `server/plugins/dist/`. Ladda upp den i kontrollpanelen och slå på pluginet.
Twitch-pluginet i `server/plugins/twitch/` är ett komplett exempel.
