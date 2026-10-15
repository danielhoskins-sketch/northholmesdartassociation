// netlify/lib/matchnight.mjs
// Works out who plays on a given night, the same way the website does:
// rows from the league sheet, minus postponed matches, plus confirmed make-ups
// moved onto that date.

// Keep these in step with the SEASON / teamNames block in index.html
export const SCHEDULE_URL = 'https://docs.google.com/spreadsheets/d/118o-iPzoDMT0ckZMnK8YFS_r_1dgXU7qCzspJOahIa4/export?format=csv&gid=1613193003';
export const MAKEUPS_KEY = 'makeups-2026-27';
export const VENUE = 'The Dugout';
export const START_TIME = '8:30 PM';
const DISPLAY = { Fagen: 'Fagan' }; // sheet spelling → display name
export const teamName = (t) => DISPLAY[t] || t;

export function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function rowKind(dateRaw) {
  const l = (dateRaw || '').toLowerCase();
  if (/championship/.test(l)) return 'championship';
  if (/playoff/.test(l)) return 'playoff';
  if (/\bmu\b|make\s*-?\s*up/.test(l)) return 'makeup';
  return 'match';
}
const leadDate = (d) => { const m = (d || '').match(/^(\d{1,2}\.\d{1,2}\.\d{2})/); return m ? m[1] : ''; };
const isPPD = (v) => /^ppd$/i.test((v || '').trim());
const isoToSheet = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${m}.${d}.${String(y).slice(-2)}`; };

// Calendar date in Chicago (handles CST/CDT), as the sheet writes it: M.D.YY
export function chicagoParts(date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23'
  }).formatToParts(date).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, hour: +p.hour };
}
export function sheetDateFor({ y, m, d }, addDays = 0) {
  const t = new Date(Date.UTC(y, m - 1, d + addDays));
  return `${t.getUTCMonth() + 1}.${t.getUTCDate()}.${String(t.getUTCFullYear()).slice(-2)}`;
}

// → { kind: 'match' | 'playoff' | 'championship' | null, matches: [{home, away, makeup}], bye: [] }
export function nightFor(sheetDate, rows, overrides = {}) {
  const matches = []; const teams = new Set(); let special = null;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]; const d = (r[0] || '').trim(); if (!d) continue;
    const kind = rowKind(d);
    if (kind === 'playoff' || kind === 'championship') { if (leadDate(d) === sheetDate) special = special || kind; continue; }
    if (kind !== 'match') continue;
    const home = (r[1] || '').trim(), away = (r[3] || '').trim();
    if (!home || !away) continue;
    teams.add(home); teams.add(away);
    const o = overrides[`${d}|${home}|${away}`] || {};
    const postponed = isPPD(r[2]) || isPPD(r[4]) || !!o.postponed;
    if (!postponed) { if (d === sheetDate) matches.push({ home, away, makeup: false }); }
    else if (o.makeupDate && o.confirmed && isoToSheet(o.makeupDate) === sheetDate) matches.push({ home, away, makeup: true });
  }
  if (matches.length) {
    const playing = new Set(matches.flatMap(m => [m.home, m.away]));
    return { kind: 'match', matches, bye: [...teams].filter(t => !playing.has(t)) };
  }
  return { kind: special, matches: [], bye: [] };
}

export function reminderText(night) {
  if (night.kind === 'match') {
    const list = night.matches.map(m => `${teamName(m.home)} (H) vs ${teamName(m.away)}${m.makeup ? ' — make-up' : ''}`).join(' · ');
    return {
      title: `🎯 Match night tomorrow · ${START_TIME}`,
      body: `${VENUE}: ${list}${night.bye.length ? `. Bye: ${night.bye.map(teamName).join(', ')}` : ''}`
    };
  }
  if (night.kind === 'playoff') return { title: `🏆 Playoffs tomorrow · ${START_TIME}`, body: `${VENUE}. Check the bracket for matchups.` };
  if (night.kind === 'championship') return { title: `🏆 Championship tomorrow · ${START_TIME}`, body: `${VENUE}. See you there!` };
  return null;
}
