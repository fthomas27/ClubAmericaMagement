// Minimal iCalendar (.ics) reader — fetches a public calendar feed (e.g. a
// Google Calendar "Secret address in iCal format" / public ICS link) and
// returns the next upcoming events. No external dependencies.

const cache = new Map(); // url -> { at, events }
const TTL_MS = 5 * 60 * 1000; // 5 minutes

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
