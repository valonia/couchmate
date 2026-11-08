// Exempelplugin: skickar en notis till en Discord-kanal när något startas, när någon ansluter
// och när en påminnelse byter kanal.
//
// Så får du en webhook-adress: Discord → kanalens inställningar → Integrationer → Webhooks → Ny webhook → Kopiera URL.

export const meta = {
  name: 'Discord-notiser',
  version: '1.0',
  description: 'Skickar en notis till Discord när något startas, när någon ansluter och när en påminnelse slår till.',
  settings: [
    { key: 'webhook', label: 'Discord webhook-adress', type: 'secret' },
    { key: 'onLoad', label: 'Notis när något startas', type: 'bool', default: true },
    { key: 'onJoin', label: 'Notis när någon ansluter', type: 'bool', default: false },
    { key: 'onReminder', label: 'Notis när en påminnelse byter kanal', type: 'bool', default: true },
  ],
};

export default function setup(api) {
  const send = async (content) => {
    const url = api.settings.webhook;
    if (!url) return api.log('ingen webhook-adress inställd');
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'Couchmates', content }),
    });
    if (!r.ok) api.log(`Discord svarade ${r.status}`);
  };

  api.on('load', ({ media, by }) => {
    if (!api.settings.onLoad || !media) return;
    const what = media.type === 'live' ? `📺 **${media.title}**` : `🎬 **${media.title}**${media.subtitle ? ` – ${media.subtitle}` : ''}`;
    send(`${what} startades${by ? ` av ${by}` : ''}`);
  });

  api.on('member_join', ({ name, device }) => {
    if (api.settings.onJoin) send(`👋 ${name} anslöt${device ? ` (${device})` : ''}`);
  });

  api.on('reminder', ({ title, channel }) => {
    if (api.settings.onReminder) send(`🔔 Påminnelse: **${title}** börjar – bytte till ${channel?.name ?? 'kanalen'}`);
  });
}
