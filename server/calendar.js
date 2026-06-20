// Minimal iCalendar (.ics) reader — fetches a public calendar feed (e.g. a
// Google Calendar "Secret address in iCal format" / public ICS link) and
// returns the next upcoming events. No external dependencies.

const dns = require('dns').promises;
const net = require('net');

const cache = new Map(); // url -> { at, events }
const TTL_MS = 5 * 60 * 1000; // 5 minutes

// ---- SSRF guard -------------------------------------------------------------
// The calendar URL is operator-configured (privileged), but we still refuse to
// fetch anything that resolves to a private / loopback / link-local / reserved
// address, so a misconfigured or malicious feed URL can't be used to probe the
// internal network or cloud metadata endpoints (169.254.169.254).
function ipIsPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;          // link-local / metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true;          // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true;                         // multicast / reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === '::1' || low === '::') return true;
    if (low.startsWith('fe80')) return true;          // link-local
    if (low.startsWith('fc') || low.startsWith('fd')) return true; // unique-local
    const mapped = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return ipIsPrivate(mapped[1]);
    return false;
  }
  return true; // unparseable → treat as unsafe
}

async function isSafeFeedUrl(url) {
  let u;
  try { u = new URL(url); } catch (_) { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  let host = u.hostname;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (net.isIP(host)) return !ipIsPrivate(host);
  try {
    const records = await dns.lookup(host, { all: true });
    return records.length > 0 && records.every((r) => !ipIsPrivate(r.address));
  } catch (_) {
    return false;
  }
}

// Unfold lines: per RFC 5545, a leading space/tab continues the previous line.
function unfold(text) {
  return text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
}

// Parse an ICS date/time value into a JS Date.
// Handles: 20260612 (date), 20260612T153000Z (UTC), 20260612T153000 (local).
function parseDate(value) {
  if (!value) return null;
  const v = value.trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, hh = '00', mm = '00', ss = '00', z] = m;
  if (z) {
    return new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss));
  }
  return new Date(+y, +mo - 1, +d, +hh, +mm, +ss);
}

function parseEvents(ics) {
  const text = unfold(ics);
  const events = [];
  const blocks = text.split('BEGIN:VEVENT').slice(1);
  for (const block of blocks) {
    const body = block.split('END:VEVENT')[0];
    const ev = {};
    for (const rawLine of body.split(/\r?\n/)) {
      const idx = rawLine.indexOf(':');
      if (idx === -1) continue;
      const key = rawLine.slice(0, idx);
      const val = rawLine.slice(idx + 1);
      const name = key.split(';')[0].toUpperCase();
      if (name === 'SUMMARY') ev.title = val.trim();
      else if (name === 'LOCATION') ev.location = val.trim();
      else if (name === 'DTSTART') ev.start = parseDate(val);
      else if (name === 'DESCRIPTION') ev.description = val.trim();
      else if (name === 'UID') ev.uid = val.trim();
    }
    if (ev.start && ev.title) events.push(ev);
  }
  return events;
}

// Return the next `count` events at or after now, soonest first.
async function fetchUpcoming(url, count = 3) {
  if (!url) return [];
  const now = Date.now();
  const hit = cache.get(url);
  if (hit && now - hit.at < TTL_MS) return upcoming(hit.events, count);

  // Refuse to fetch URLs that resolve to internal/reserved addresses (SSRF).
  if (!(await isSafeFeedUrl(url))) {
    return hit ? upcoming(hit.events, count) : [];
  }

  let ics;
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    ics = await res.text();
  } catch (e) {
    // On any fetch/parse failure, return whatever we last had (or nothing).
    return hit ? upcoming(hit.events, count) : [];
  }
  const events = parseEvents(ics);
  cache.set(url, { at: now, events });
  return upcoming(events, count);
}

function upcoming(events, count) {
  const now = Date.now();
  return events
    .filter((e) => e.start && e.start.getTime() >= now - 60 * 60 * 1000) // include events within the last hour
    .sort((a, b) => a.start - b.start)
    .slice(0, count)
    .map((e) => ({
      uid: e.uid || '',
      title: e.title,
      location: e.location || '',
      start: e.start.toISOString(),
    }));
}

module.exports = { fetchUpcoming, parseEvents, clearCache: (url) => cache.delete(url) };
