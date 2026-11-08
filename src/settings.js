// Serverns inställningar som går att ändra i adminpanelen.
// Startvärden kommer från miljövariabler (.env); ändringar sparas i data/settings.json och vinner över .env.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Alla inställningar som visas i adminpanelen.
 * type: text | secret (visas aldrig i klartext) | number | bool | select
 * live: true = gäller direkt, false = kräver omstart av servern
 */
export const SCHEMA = [
  // ---- Dispatcharr
  { key: 'xtreamUrl', env: 'XTREAM_URL', group: 'dispatcharr', type: 'text', def: 'http://localhost:9191', live: true,
    sv: 'Dispatcharr-adress', en: 'Dispatcharr address', help_sv: 'Som servern når Dispatcharr på, t.ex. http://host.docker.internal:9191', help_en: 'How the server reaches Dispatcharr, e.g. http://host.docker.internal:9191' },
  { key: 'user', env: 'XTREAM_USER', group: 'dispatcharr', type: 'text', def: '', live: true, sv: 'Xtream-användare', en: 'Xtream user' },
  { key: 'pass', env: 'XTREAM_PASS', group: 'dispatcharr', type: 'secret', def: '', live: true, sv: 'Xtream-lösenord', en: 'Xtream password' },
  { key: 'streamMode', env: 'STREAM_MODE', group: 'dispatcharr', type: 'select', options: ['proxy', 'direct'], def: 'proxy', live: true,
    sv: 'Strömläge', en: 'Stream mode', help_sv: 'proxy = all video går via servern (rekommenderas). direct = apparna hämtar direkt från Dispatcharr.', help_en: 'proxy = all video goes through the server (recommended). direct = apps fetch straight from Dispatcharr.' },
  { key: 'publicXtreamUrl', env: 'PUBLIC_XTREAM_URL', group: 'dispatcharr', type: 'text', def: '', live: true,
    sv: 'Publik Dispatcharr-adress', en: 'Public Dispatcharr address', help_sv: 'Bara för strömläge direct: adressen som apparna når Dispatcharr på.', help_en: 'Only for direct mode: the address the apps use to reach Dispatcharr.' },
  { key: 'sharedVod', env: 'SHARED_VOD', group: 'dispatcharr', type: 'bool', def: true, live: true,
    sv: 'Delad nedladdning av filmer', en: 'Shared movie download', help_sv: 'Filmer och avsnitt hämtas en gång och delas till alla – bara en anslutning hos leverantören.', help_en: 'Movies and episodes are fetched once and shared with everyone – only one provider connection.' },
  { key: 'cacheSeconds', env: 'CACHE_SECONDS', group: 'dispatcharr', type: 'number', def: 300, min: 0, max: 86400, live: true,
    sv: 'Cache för katalogen (sekunder)', en: 'Catalogue cache (seconds)' },

  // ---- Rummet
  { key: 'pin', env: 'ROOM_PIN', group: 'room', type: 'secret', def: '', live: true,
    sv: 'PIN-kod', en: 'PIN code', help_sv: 'Det apparna loggar in med. Byter du PIN måste alla skriva in den nya i sina appar.', help_en: 'What the apps log in with. If you change it, everyone has to enter the new one in their apps.' },
  { key: 'startTimeoutMs', env: 'START_TIMEOUT_MS', group: 'room', type: 'number', def: 12000, min: 2000, max: 60000, live: true,
    sv: 'Max väntan på att alla är redo (ms)', en: 'Max wait for everyone to be ready (ms)' },
  { key: 'upnextSeconds', env: 'UPNEXT_SECONDS', group: 'room', type: 'number', def: 10, min: 0, max: 120, live: true,
    sv: 'Nästa avsnitt startar efter (sekunder)', en: 'Next episode starts after (seconds)' },
  { key: 'reminderSwitchSeconds', env: 'REMINDER_SWITCH_SECONDS', group: 'room', type: 'number', def: 30, min: 0, max: 600, live: true,
    sv: 'Påminnelse: byt kanal så här långt innan start (sekunder)', en: 'Reminder: switch channel this long before start (seconds)' },
  { key: 'reminderWarnSeconds', env: 'REMINDER_WARN_SECONDS', group: 'room', type: 'number', def: 30, min: 5, max: 600, live: true,
    sv: 'Påminnelse: visa kortet så här långt innan bytet (sekunder)', en: 'Reminder: show the card this long before switching (seconds)' },
  { key: 'favCheckMinutes', env: 'FAV_CHECK_MINUTES', group: 'room', type: 'number', def: 30, min: 5, max: 1440, live: true,
    sv: 'Leta efter nya avsnitt i favoriter var (minuter)', en: 'Check favourites for new episodes every (minutes)' },

  // ---- Tablå
  { key: 'epgPrimaryUrl', env: 'EPG_PRIMARY_URL', group: 'epg', type: 'secret', def: '', live: true,
    sv: 'Originaltablå (XMLTV-länk)', en: 'Primary guide (XMLTV link)', help_sv: 'Leverantörens XMLTV. Tomt = ingen sammanslagen tablå.', help_en: "Your provider's XMLTV. Empty = no merged guide." },
  { key: 'epgFallbackCountries', env: 'EPG_FALLBACK_COUNTRIES', group: 'epg', type: 'text', def: 'auto', live: true,
    sv: 'Reservtablå för länder', en: 'Fallback guide for countries', help_sv: '"auto" = länderna bland kanalerna som visas, eller t.ex. "se,no".', help_en: '"auto" = the countries of the channels shown, or e.g. "se,no".' },
  { key: 'epgFallbackTemplate', env: 'EPG_FALLBACK_TEMPLATE', group: 'epg', type: 'text', def: 'https://epgshare01.online/epgshare01/epg_ripper_{CC}1.xml.gz', live: true,
    sv: 'Reservkälla per land (mall)', en: 'Fallback source per country (template)', help_sv: '{CC} byts mot landskoden, t.ex. SE.', help_en: '{CC} is replaced by the country code, e.g. SE.' },
  { key: 'epgFallbackUrl', env: 'EPG_FALLBACK_URL', group: 'epg', type: 'text', def: '', live: true,
    sv: 'Egna reservkällor', en: 'Extra fallback sources', help_sv: 'Fler XMLTV-länkar, separerade med komma.', help_en: 'More XMLTV links, separated by commas.' },
  { key: 'epgFallbackMap', env: 'EPG_FALLBACK_MAP', group: 'epg', type: 'text', def: '', live: true,
    sv: 'Egna kanalkopplingar', en: 'Manual channel mappings', help_sv: 'originalid=reservid, separerade med komma.', help_en: 'originalid=fallbackid, separated by commas.' },
  { key: 'epgMergeHours', env: 'EPG_MERGE_HOURS', group: 'epg', type: 'number', def: 3, min: 1, max: 48, live: true,
    sv: 'Bygg om tablån var (timmar)', en: 'Rebuild the guide every (hours)' },
];

export const GROUPS = [
  { key: 'dispatcharr', sv: 'Dispatcharr', en: 'Dispatcharr' },
  { key: 'room', sv: 'Rummet', en: 'Room' },
  { key: 'epg', sv: 'Tablå', en: 'Guide' },
];

function fromEnv(def, raw) {
  if (raw === undefined || raw === '') return def.def;
  if (def.type === 'number') return Number(raw);
  if (def.type === 'bool') return String(raw).toLowerCase() !== 'false';
  return String(raw);
}

export class Settings {
  constructor(file, env) {
    this.file = file;
    this.listeners = [];
    this.saved = {};
    try { this.saved = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { /* inga sparade ändringar än */ }
    this.values = {};
    for (const d of SCHEMA) this.values[d.key] = d.key in this.saved ? this.saved[d.key] : fromEnv(d, env[d.env]);
  }

  get(key) { return this.values[key]; }

  /** För adminpanelen: hemliga värden visas bara som "satt/inte satt". */
  forAdmin() {
    return SCHEMA.map((d) => ({
      ...d,
      value: d.type === 'secret' ? undefined : this.values[d.key],
      isSet: d.type === 'secret' ? Boolean(this.values[d.key]) : undefined,
      fromAdmin: d.key in this.saved,
    }));
  }

  /** Validerar och sparar ändringar. Hemliga fält som skickas tomma lämnas orörda. Returnerar ändrade nycklar. */
  update(patch) {
    const changed = [];
    for (const d of SCHEMA) {
      if (!(d.key in patch)) continue;
      let v = patch[d.key];
      if (d.type === 'secret' && (v === null || v === undefined || v === '')) continue;
      if (d.type === 'number') {
        v = Number(v);
        if (!Number.isFinite(v)) throw new Error(`${d.sv}: måste vara ett tal`);
        if (d.min !== undefined && v < d.min) throw new Error(`${d.sv}: minst ${d.min}`);
        if (d.max !== undefined && v > d.max) throw new Error(`${d.sv}: högst ${d.max}`);
      } else if (d.type === 'bool') {
        v = v === true || v === 'true';
      } else {
        v = String(v).trim().slice(0, 2000);
        if (d.type === 'select' && !d.options.includes(v)) throw new Error(`${d.sv}: ogiltigt val`);
      }
      if (this.values[d.key] !== v) {
        this.values[d.key] = v;
        this.saved[d.key] = v;
        changed.push(d.key);
      }
    }
    if (changed.length) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.saved, null, 1));
      for (const fn of this.listeners) fn(changed);
    }
    return changed;
  }

  onChange(fn) { this.listeners.push(fn); }
}
