// netlify/functions/picks.mjs
// Weekly pick'em. Players pick the winner of each match; picks lock at
// 8:30 PM Chicago time on match night (the make-up date if it was moved).
// Before the lock, nobody can see anyone else's picks.
//
//   POST /api/picks { token, action: 'get', name? }            → { picks: { "<key>": { "<name>": "<team>" } } }
//   POST /api/picks { token, action: 'set', name, key, team }  → same, team null clears the pick
import { getStore } from '@netlify/blobs';
import { authorized } from '../lib/auth.mjs';

const PICKS_KEY = 'picks-2026-27';
const MAKEUPS_KEY = 'makeups-2026-27';
const KEY_RE = /^\d{1,2}\.\d{1,2}\.\d{2}\|[^|]{1,40}\|[^|]{1,40}$/;
// Keep in step with teamRosters in index.html
const PLAYERS = new Set([
  'Brian Fagan', 'John Zanko', 'Dave Sabin',
  'Dan Hoskins', 'Andy Davis', 'Mike "Chaz" Chastain',
  'Brad "Sorta Aint" Byrne', 'Bill Cook', 'Pete Mitchell',
  'Greg Williams', 'John Martin', 'Roger Pecha',
  'Ryan Keller', 'Greg Bopp', 'Tim Medlock'
]);
const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });

// 8:30 PM in Chicago on y-m-d, as a UTC timestamp (handles CST/CDT)
function chicagoTime(y, m, d, h = 20, min = 30) {
  const guess = Date.UTC(y, m - 1, d, h + 6, min);
  const tz = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', timeZoneName: 'shortOffset' })
    .formatToParts(new Date(guess)).find(p => p.type === 'timeZoneName').value; // "GMT-5"
  const off = Number((tz.match(/GMT([+-]\d+)/) || [0, -6])[1]);
  return Date.UTC(y, m - 1, d, h - off, min);
}
// When this match's picks lock, or null if it's postponed with no date yet
function lockTime(key, overrides) {
  const o = overrides[key] || {};
  if (o.makeupDate) { const [y, m, d] = o.makeupDate.split('-').map(Number); return chicagoTime(y, m, d); }
  if (o.postponed) return null;
  const [m, d, yy] = key.split('|')[0].split('.').map(Number);
  return chicagoTime(2000 + yy, m, d);
}
// Everyone's picks for locked matches; only your own for open ones
function visible(picks, overrides, name) {
  const now = Date.now(), out = {};
  for (const [key, byName] of Object.entries(picks)) {
    const lock = lockTime(key, overrides);
    if (lock !== null && now >= lock) out[key] = byName;
    else if (name && byName[name]) out[key] = { [name]: byName[name] };
  }
  return out;
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
  if (!authorized(body)) return json({ error: 'Not authorized' }, 401);

  const store = getStore('nhda');
  const [picks, overrides] = await Promise.all([
    store.get(PICKS_KEY, { type: 'json' }).then(v => v || {}),
    store.get(MAKEUPS_KEY, { type: 'json' }).then(v => v || {})
  ]);
  const name = typeof body.name === 'string' ? body.name : '';
  if (name && !PLAYERS.has(name)) return json({ error: 'Unknown player' }, 400);

  if (body.action === 'get') return json({ picks: visible(picks, overrides, name), now: Date.now() });

  if (body.action === 'set') {
    if (!name) return json({ error: 'Pick your name first' }, 400);
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    if (!KEY_RE.test(key)) return json({ error: 'Unknown match' }, 400);
    const [, home, away] = key.split('|');
    const team = body.team;
    if (team !== null && team !== home && team !== away) return json({ error: 'Unknown team' }, 400);
    const lock = lockTime(key, overrides);
    if (lock === null) return json({ error: 'This match is postponed' }, 409);
    if (Date.now() >= lock) return json({ error: 'Picks are locked for this match' }, 423);
    const entry = { ...(picks[key] || {}) };
    if (team === null) delete entry[name]; else entry[name] = team;
    if (Object.keys(entry).length) picks[key] = entry; else delete picks[key];
    await store.setJSON(PICKS_KEY, picks);
    return json({ picks: visible(picks, overrides, name), now: Date.now() });
  }
  return json({ error: 'Unknown action' }, 400);
};

export const config = { path: '/api/picks' };
