// The IPTV plugin's views, built from Couchmate's building blocks (see PLUGINS.md → Views).
// The apps only draw these; everything about how Live TV, Movies and Series look is decided here.

/** The groups column on the left (only when there is more than one group). */
function groupsColumn(t, groups, onSelect) {
  return {
    type: 'column', width: 250, height: 'fill', background: 'panel', radius: 12, padding: 8,
    children: [
      { type: 'text', text: t('Groups'), style: 'label', padding: [10, 6, 10, 8] },
      {
        type: 'list', id: 'groups', items: groups, focus: 'row', itemHeight: 46,
        selected: '{{state.group}}', onClick: onSelect,
        item: { type: 'text', text: '{{item.title}}', style: 'body', maxLines: 1 },
      },
    ],
  };
}

/** One channel in a list: number, logo, name, what is on now and its progress. */
const channelRow = {
  type: 'row', align: 'center', children: [
    { type: 'text', text: '{{item.number}}', style: 'dim', width: 48 },
    { type: 'image', src: '{{item.image}}', fallback: '{{item.title}}', fit: 'contain', width: 64, height: 38 },
    { type: 'spacer', width: 14 },
    {
      type: 'column', weight: 1, children: [
        {
          type: 'row', align: 'center', children: [
            { type: 'text', text: '{{item.title}}', style: 'bodyStrong', maxLines: 1 },
            { type: 'text', text: '  ★', color: 'gold', size: 14, when: '{{item.$favorite}}' },
            { type: 'text', text: '  ▶', size: 13, when: '{{item.$playing}}' },
          ],
        },
        {
          type: 'column', when: '{{item.$now}}', children: [
            {
              type: 'row', children: [
                { type: 'time', value: '{{item.$now.start}}', style: 'caption' },
                { type: 'text', text: '  {{item.$now.title}}', style: 'caption', maxLines: 1 },
              ],
            },
            { type: 'spacer', height: 4 },
            { type: 'progress', start: '{{item.$now.start}}', end: '{{item.$now.end}}', color: 'textSoft', track: 'trackSoft' },
          ],
        },
      ],
    },
  ],
};

/** One programme in a channel's guide. */
const guideRow = {
  type: 'row', align: 'center', children: [
    {
      type: 'column', width: 70, children: [
        { type: 'time', value: '{{item.start}}', style: 'bodyStrong' },
        { type: 'row', children: [{ type: 'text', text: '– ', style: 'faint', size: 12 }, { type: 'time', value: '{{item.end}}', style: 'faint', size: 12 }] },
      ],
    },
    {
      type: 'column', weight: 1, children: [
        {
          type: 'row', align: 'center', children: [
            { type: 'badge', text: '{{view.onNow}}', color: 'live', when: '{{item.$live}}', padding: [0, 0, 8, 0] },
            { type: 'text', text: '{{item.title}}', style: 'bodyStrong', size: 15, maxLines: 1 },
          ],
        },
        { type: 'progress', start: '{{item.start}}', end: '{{item.end}}', when: '{{item.$live}}', padding: [0, 6, 0, 0] },
        { type: 'text', text: '{{item.$reminder}}', color: 'gold', size: 12, maxLines: 1, when: '{{item.$reminder}}', unless: '{{item.$live}}' },
        { type: 'text', text: '{{item.description}}', style: 'dim', size: 12, maxLines: 1, unless: ['{{item.$live}}', '{{item.$reminder}}'] },
      ],
    },
    { type: 'icon', name: 'bell', size: 20, color: 'gold', when: '{{item.$reminder}}', unless: '{{item.$live}}' },
    { type: 'icon', name: 'bell', size: 20, color: 'faint', unless: ['{{item.$live}}', '{{item.$reminder}}'] },
  ],
};

/** The channel's schedule on the right; OK on a programme on now plays, on a coming one sets a reminder. */
function guideColumn(t) {
  return {
    type: 'column', weight: 1, height: 'fill', background: 'panel', radius: 12, padding: [22, 22, 14, 16], when: '{{state.channel}}',
    children: [
      {
        type: 'row', align: 'center', children: [
          { type: 'image', src: '{{state.channel.image}}', fallback: '{{state.channel.title}}', fit: 'contain', width: 120, height: 68, radius: 8 },
          { type: 'spacer', width: 16 },
          {
            type: 'column', weight: 1, children: [
              { type: 'row', align: 'center', children: [{ type: 'text', text: '{{state.channel.number}}  ', style: 'dim', size: 16 }, { type: 'badge', text: 'LIVE', color: 'live' }] },
              { type: 'text', text: '{{state.channel.title}}', style: 'headline', maxLines: 2 },
            ],
          },
        ],
      },
      { type: 'spacer', height: 14 },
      {
        type: 'list', id: 'guide', weight: 1, focus: 'row', itemHeight: 64,
        data: { name: 'guide', params: { id: '{{state.channel.id}}' }, delay: 350 },
        channel: '{{state.channel}}', sectionBy: 'day',
        empty: t('No programme information'),
        onClick: { if: '{{item.$live}}', then: { play: '{{state.channel}}' }, else: { remind: { channel: '{{state.channel}}', program: '{{item}}' } } },
        item: guideRow,
      },
      { type: 'spacer', height: 8 },
      { type: 'text', text: t('→  guide   ·   OK on a programme  –  reminder'), style: 'faint', size: 13 },
      { type: 'text', text: t('OK on a channel  –  play   ·   Hold OK  –  favorite'), style: 'faint', size: 13 },
    ],
  };
}

/** Live TV: groups │ channels with what is on now │ the focused channel's guide. */
export function liveView(t, groups) {
  const first = groups[0] || null;
  return {
    type: 'row', gap: 14,
    state: { group: first?.id || null, groupTitle: first?.title || '', channel: null },
    view: { onNow: t('ON NOW') },
    children: [
      groups.length > 1 && groupsColumn(t, groups, { set: { group: '{{item.id}}', groupTitle: '{{item.title}}' } }),
      {
        type: 'column', weight: 1.3, height: 'fill', background: 'panel', radius: 12, padding: 8,
        data: { name: 'group', params: { menu: 'live', group: '{{state.group}}' } },
        loading: t('Loading channels…'),
        children: [
          {
            type: 'row', padding: [10, 6, 10, 8], children: [
              { type: 'text', text: '{{state.groupTitle}}', style: 'label' },
              { type: 'text', text: t('  ·  {n} channels', { n: '{{item.items.length}}' }), style: 'label' },
            ],
          },
          {
            type: 'list', id: 'channels', weight: 1, items: '{{item.items}}', focus: 'row', itemHeight: 64,
            initial: '{{state.channel.id}}',
            enrich: { name: 'epg', as: 'programs', refresh: 180 },
            onFocus: { set: { channel: '{{item}}' } },
            onClick: { play: '{{item}}', subtitle: '{{state.groupTitle}}' },
            onLongClick: { favorite: '{{item}}' },
            item: channelRow,
          },
        ],
      },
      guideColumn(t),
    ].filter(Boolean),
  };
}

/** The info panel above the posters: backdrop, poster, title, facts and description of the item at [path]. */
function hero(path) {
  const v = (field) => `{{${path}.${field}}}`;
  return {
    type: 'box', height: 200, width: 'fill', background: 'panel', radius: 12, when: `{{${path}}}`, children: [
      { type: 'image', src: `{{${path}.backdrop || ${path}.image}}`, fit: 'cover', align: 'centerEnd', width: '65%', height: 'fill', opacity: 0.55 },
      { type: 'box', width: 'fill', height: 'fill', background: 'heroFade' },
      {
        type: 'row', padding: 20, height: 'fill', children: [
          { type: 'image', src: v('image'), fallback: v('title'), fit: 'cover', aspect: 0.6667, height: 'fill', radius: 8 },
          { type: 'spacer', width: 24 },
          {
            type: 'column', weight: 1, padding: [0, 6, 0, 0], children: [
              { type: 'text', text: v('title'), style: 'title', maxLines: 2 },
              { type: 'spacer', height: 6 },
              { type: 'text', join: [v('year'), v('genre'), `★ ${v('rating')}`], color: 'gold', size: 15 },
              { type: 'spacer', height: 12 },
              { type: 'text', text: v('description'), style: 'dim', size: 15, maxLines: 4 },
            ],
          },
        ],
      },
    ],
  };
}

/** Movies or Series: groups │ an info panel and a grid of posters. */
export function postersView(t, menu, groups) {
  const first = groups[0] || null;
  const opens = menu === 'series';
  return {
    type: 'row', gap: 14,
    state: { group: first?.id || null, focused: null },
    children: [
      groups.length > 1 && groupsColumn(t, groups, { set: { group: '{{item.id}}', focused: null } }),
      {
        type: 'column', weight: 1, height: 'fill',
        data: { name: 'group', params: { menu, group: '{{state.group}}' } },
        children: [
          hero('state.focused'),
          { type: 'text', text: t('Hold OK to add to favorites'), style: 'faint', size: 13, padding: [6, 10, 0, 0] },
          {
            type: 'grid', id: 'posters', weight: 1, items: '{{item.items}}', minWidth: 92, gap: 18, focus: 'poster', aspect: 0.6667, padding: [6, 12, 6, 24],
            label: '{{item.title}}',
            onFocus: { set: { focused: '{{item}}' } },
            onClick: opens ? { open: 'show', params: { id: '{{item.id}}' } } : { play: '{{item}}' },
            onLongClick: { favorite: '{{item}}' },
            item: {
              type: 'box', children: [
                { type: 'image', src: '{{item.image}}', fallback: '{{item.title}}', fit: 'cover', width: 'fill', height: 'fill', radius: 8 },
                { type: 'badge', text: '★', color: 'dark', textColor: 'gold', align: 'topStart', padding: 6, when: '{{item.$favorite}}' },
                { type: 'badge', text: t('{n} NEW', { n: '{{item.$newCount}}' }), color: 'accent', align: 'topEnd', padding: 6, when: '{{item.$newCount}}' },
              ],
            },
          },
        ],
      },
    ].filter(Boolean),
  };
}

/** A series: info panel, favourite button, seasons and the season's episodes. */
export function seriesView(t, info, item) {
  const seasons = info.seasons.filter((s) => s.items.length);
  const first = seasons[0];
  return {
    type: 'column',
    state: { season: first?.id || null, episodes: first?.items || [] },
    children: [
      hero('view.item'),
      { type: 'spacer', height: 14 },
      {
        type: 'row', gap: 6, align: 'center', children: [
          { type: 'button', text: t('☆ Add to favorites'), onClick: { favorite: '{{view.item}}' }, unless: '{{view.item.$favorite}}' },
          { type: 'button', text: t('★ Favorite'), selected: true, onClick: { favorite: '{{view.item}}' }, when: '{{view.item.$favorite}}' },
          { type: 'text', text: t('New: {episode}', { episode: '{{view.item.$newLabel}}' }), color: 'accent', bold: true, size: 15, padding: [10, 8, 10, 8], when: '{{view.item.$newCount}}' },
          seasons.length > 1 && {
            type: 'list', id: 'seasons', direction: 'horizontal', items: seasons.map(({ id, title, items }) => ({ id, title, items })),
            focus: 'pill', gap: 6, selected: '{{state.season}}',
            onFocus: { set: { season: '{{item.id}}', episodes: '{{item.items}}' } },
            item: { type: 'text', text: '{{item.title}}' },
          },
        ].filter(Boolean),
      },
      { type: 'spacer', height: 10 },
      {
        type: 'list', id: 'episodes', weight: 1, items: '{{state.episodes}}', focus: 'row', itemHeight: 70,
        background: 'panel', radius: 12, padding: 8, autofocus: true,
        empty: t('No episodes found'),
        onClick: { play: '{{item}}' },
        item: {
          type: 'row', align: 'center', children: [
            { type: 'text', text: '{{item.subtitle}}', style: 'soft', size: 15, width: 96, maxLines: 1 },
            { type: 'image', src: '{{item.image}}', fallback: '{{item.title}}', fit: 'cover', width: 96, height: 54 },
            { type: 'spacer', width: 16 },
            {
              type: 'column', weight: 1, children: [
                { type: 'text', text: '{{item.title}}', style: 'body', size: 17, maxLines: 1 },
                { type: 'text', text: '{{item.description}}', style: 'soft', size: 13, maxLines: 1 },
              ],
            },
            { type: 'text', text: t('{m} min', { m: '{{item.minutes}}' }), style: 'soft', size: 13, when: '{{item.minutes}}' },
          ],
        },
      },
    ],
    // The series itself, for the info panel and the favourite button.
    view: { item },
  };
}

/** The overlay on top of a live channel: number, name, what is on now and next, and the key hints. */
export function liveOverlay(t) {
  return {
    type: 'box', width: 'fill', height: 'fill', children: [
      { type: 'topbar', align: 'topStart' },
      {
        type: 'column', align: 'bottomStart', width: 'fill', background: 'bottomFade', padding: [56, 80, 56, 40],
        data: { name: 'now', params: { id: '{{media.id}}' }, refresh: 60 },
        children: [
          {
            type: 'row', align: 'center', children: [
              { type: 'image', src: '{{media.image}}', fallback: '{{media.title}}', fit: 'contain', width: 150, height: 84, radius: 10 },
              { type: 'spacer', width: 24 },
              {
                type: 'column', weight: 1, children: [
                  {
                    type: 'row', align: 'center', children: [
                      { type: 'text', text: '{{item.number}}  ', style: 'dim', size: 20, when: '{{item.number}}' },
                      { type: 'text', text: '{{media.title}}', style: 'title', size: 26, maxLines: 1 },
                      { type: 'spacer', width: 12 },
                      { type: 'badge', text: 'LIVE', color: 'live' },
                    ],
                  },
                  { type: 'spacer', height: 6 },
                  { type: 'text', text: '{{item.now.title}}', fallback: t('No programme information'), size: 19, maxLines: 1 },
                  {
                    type: 'row', align: 'center', padding: [0, 10, 0, 0], when: '{{item.now}}', children: [
                      { type: 'time', value: '{{item.now.start}}', style: 'dim', size: 14 },
                      { type: 'progress', start: '{{item.now.start}}', end: '{{item.now.end}}', weight: 1, padding: [12, 0, 12, 0] },
                      { type: 'time', value: '{{item.now.end}}', style: 'dim', size: 14 },
                    ],
                  },
                  {
                    type: 'row', padding: [0, 8, 0, 0], when: '{{item.next}}', children: [
                      { type: 'text', text: t('Up next'), style: 'dim', size: 15 },
                      { type: 'text', text: '  ', size: 15 },
                      { type: 'time', value: '{{item.next.start}}', style: 'dim', size: 15 },
                      { type: 'text', text: '  {{item.next.title}}', style: 'dim', size: 15, maxLines: 1 },
                    ],
                  },
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
}
