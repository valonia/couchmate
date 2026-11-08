# Twitch-plugin för Couchmates

Lägger till **Twitch** i Couchmates:

- **Menyn:** "Twitch" dyker upp mellan Favoriter och Historik i alla appar och visar populära liveströmmar. Har du angett egna kanaler visas de överst när de sänder, och det finns också en rad för ett valt språk.
- **Sök:** när du söker i appen kommer även Twitch-kanaler som sänder just nu med.
- **Titta:** liveströmmen spelas synkat för alla i rummet, precis som en TV-kanal.

## Installera

1. Öppna adminpanelen: `http://<server>:8787/admin` → **Plugins**.
2. Klicka på **Ladda upp plugin** och välj `twitch.zip`.
3. Slå på pluginet. Starta om appen (eller gå ut och in i menyn) så syns Twitch.

## Krav

- Servern måste kunna nå twitch.tv.
- Inget Twitch-konto och ingen extra Docker-container behövs.

## Inställningar (i adminpanelen)

| Inställning | Vad den gör |
|---|---|
| Dina kanaler | Twitch-namn separerade med komma. Visas överst när de sänder. |
| Språk för egen rad | T.ex. `sv` för en rad med populära svenska strömmar. Tomt = ingen sådan rad. |
| Antal populära strömmar | Hur många strömmar raden "Populärt just nu" visar. |
| Klient-id | Det id som Twitchs webbsida använder. Byt bara om Twitch ändrar något. |

## Bra att veta

Pluginet hämtar data på samma sätt som Twitchs webbsida, och som verktyg som Streamlink och VLC. Det är alltså inte Twitchs officiella API, och Twitch kan ändra saker som kräver en ny version av pluginet. Reklam kan visas, precis som på webben.
