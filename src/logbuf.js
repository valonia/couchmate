// Captures the server log lines (console.log/warn/error) so they can be shown live in the admin panel.
// Passwords and PIN codes are removed from the lines before they are kept.

const MAX = 1500;
const lines = [];
const listeners = new Set();
let seq = 0;
let secrets = [];

/** Values that must never appear in the log (PIN, passwords, links with logins). */
export function setLogSecrets(values) {
  secrets = values.filter((v) => typeof v === 'string' && v.length >= 3);
}

function scrub(text) {
  let t = text;
  for (const s of secrets) t = t.split(s).join('•••');
  return t.replace(/(password|pass|pin)=([^&\s"']+)/gi, '$1=•••');
}

export function installLogCapture() {
  for (const level of ['log', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      const text = scrub(args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      const line = { id: ++seq, t: Date.now(), level, text: text.slice(0, 4000) };
      lines.push(line);
      if (lines.length > MAX) lines.shift();
      for (const fn of listeners) { try { fn(line); } catch { /* lyssnaren borta */ } }
    };
  }
}

export const logSince = (id = 0) => lines.filter((l) => l.id > id);
export function onLog(fn) { listeners.add(fn); return () => listeners.delete(fn); }
