// Discord notifications: posts to a Discord channel through a webhook.
// A plugin without a menu entry – it only listens to what happens in the room.

const plain = (v) => (v && typeof v === 'object' && typeof v.$t === 'string' ? v.$t : v);

export default function setup(api) {
  const send = async (content) => {
    const url = api.settings.webhook;
    if (!url) return api.log('no webhook address set');
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'Couchmate', content }),
    });
    if (!r.ok) api.log(`Discord answered ${r.status}`);
  };

  api.on('load', ({ media, by }) => {
    if (!api.settings.onLoad || !media) return;
    const title = plain(media.title);
    const subtitle = plain(media.subtitle);
    const what = media.live ? `📺 **${title}**` : `🎬 **${title}**${subtitle ? ` – ${subtitle}` : ''}`;
    send(`${what} started${by ? ` by ${by}` : ''}`);
  });

  api.on('member_join', ({ name, device }) => {
    if (api.settings.onJoin) send(`👋 ${name} joined${device ? ` (${device})` : ''}`);
  });

  api.on('reminder', ({ title, channel }) => {
    if (api.settings.onReminder) send(`🔔 Reminder: **${title}** is starting – switched to ${channel?.title ?? 'the channel'}`);
  });
}
