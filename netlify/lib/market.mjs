// netlify/lib/market.mjs
// NHDA Exchange — a Kalshi-style prediction market on league matches, played with
// free league points (no real money).
//
// Each match is a two-outcome market: "Who wins?" Home or Away. A contract pays
// 100 pts if its team wins and 0 if it loses, so its price (1–99¢) reads as the
// crowd's win probability. Prices are set by an automated market maker (LMSR),
// so every buy pushes that team's price up and every sell pushes it down.
//
// Markets open 14 days before match night, lock at first throw (8:30 PM Chicago),
// and settle automatically once a score shows up in the sheet or on the website.

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { getStore } from '@netlify/blobs';
import { SCHEDULE_URL, MAKEUPS_KEY, parseCSV } from './matchnight.mjs';

export const MARKET_KEY = 'market-2026-27';
export const START_CASH = 1000;      // pts each player starts with
export const PAYOUT = 100;           // pts a winning contract pays
export const LIQUIDITY = 30;         // LMSR "b": higher = prices move less per trade
export const OPEN_DAYS = 14;         // markets open this many days before match night
export const MAX_PER_TRADE = 50;     // contracts per order
export const BAILOUT_CASH = 500;     // refill for players who go broke
const START_HOUR = 20, START_MIN = 30; // 8:30 PM — trading locks at first throw
const TOKEN_DAYS = 180;

// ── LMSR market maker ───────────────────────────────────────────────
// Quantities qh / qa are contracts sold of each side. Cost function C = b·ln(e^(qh/b) + e^(qa/b)).
const lse = (x, y) => { const m = Math.max(x, y); return m + Math.log(Math.exp(x - m) + Math.exp(y - m)); };
const C = (qh, qa, b) => b * lse(qh / b, qa / b);
export const priceHome = (m) => 1 / (1 + Math.exp((m.qa - m.qh) / m.b));
// Points to buy n (>0) or proceeds to sell -n (<0) contracts of a side
export function tradeCost(m, side, n) {
  const qh = m.qh + (side === 'home' ? n : 0), qa = m.qa + (side === 'away' ? n : 0);
  return PAYOUT * (C(qh, qa, m.b) - C(m.qh, m.qa, m.b));
}
export function seedMarket(pHome) {
  const p = Math.min(0.8, Math.max(0.2, pHome));
  return { qh: LIQUIDITY * Math.log(p / (1 - p)), qa: 0, b: LIQUIDITY, seed: p, vol: 0, settled: null };
}

// ── Time ────────────────────────────────────────────────────────────
// UTC ms for a wall-clock time in Chicago (handles CST/CDT)
function chicagoMs(y, mo, d, h, mi) {
  let t = Date.UTC(y, mo - 1, d, h + 6, mi);
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
      .formatToParts(new Date(t)).map(x => [x.type, +x.value || x.value]));
    const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    t += Date.UTC(y, mo - 1, d, h, mi) - seen;
  }
  return t;
}
const sheetDateMs = (s) => { const [m, d, y] = s.split('.').map(Number); return chicagoMs(2000 + y, m, d, START_HOUR, START_MIN); };
const isoDateMs = (s) => { const [y, m, d] = s.split('-').map(Number); return chicagoMs(y, m, d, START_HOUR, START_MIN); };

// ── League schedule → match list ────────────────────────────────────
const isPPD = (v) => /^ppd$/i.test((v || '').trim());
const isMatchRow = (d) => !/championship|playoff|\bmu\b|make\s*-?\s*up/i.test(d) && /^\d{1,2}\.\d{1,2}\.\d{2}$/.test(d);

let sheetCache = { at: 0, rows: null };
async function sheetRows() {
  if (sheetCache.rows && Date.now() - sheetCache.at < 60000) return sheetCache.rows;
  const r = await fetch(SCHEDULE_URL, { cache: 'no-store' });
  if (!r.ok) { if (sheetCache.rows) return sheetCache.rows; throw new Error('Schedule unavailable'); }
  sheetCache = { at: Date.now(), rows: parseCSV(await r.text()) };
  return sheetCache.rows;
}

// → [{ key, date, home, away, closesAt, postponed, makeup, h, a }]
export async function leagueMatches() {
  const [rows, overrides] = await Promise.all([sheetRows(), getStore('nhda').get(MAKEUPS_KEY, { type: 'json' }).then(x => x || {})]);
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]; const date = (r[0] || '').trim();
    if (!isMatchRow(date)) continue;
    const home = (r[1] || '').trim(), away = (r[3] || '').trim(); if (!home || !away) continue;
    const key = `${date}|${home}|${away}`; const o = overrides[key] || {};
    let h = parseInt(r[2]), a = parseInt(r[4]);
    if (o.score) { h = o.score.h; a = o.score.a; }
    const scored = Number.isFinite(h) && Number.isFinite(a) && h !== a;
    const postponed = isPPD(r[2]) || isPPD(r[4]) || !!o.postponed;
    let closesAt = sheetDateMs(date), makeup = false;
    if (postponed) {
      if (o.makeupDate && o.confirmed) { closesAt = isoDateMs(o.makeupDate); makeup = true; }
      else closesAt = null;
    }
    out.push({ key, date, home, away, closesAt, postponed, makeup, h: scored ? h : null, a: scored ? a : null });
  }
  return out;
}

// Opening price from legs won so far: better leg-win rate → higher price
function seedProb(matches, home, away) {
  const won = {}, played = {};
  for (const m of matches) if (m.h !== null) {
    won[m.home] = (won[m.home] || 0) + m.h; won[m.away] = (won[m.away] || 0) + m.a;
    played[m.home] = (played[m.home] || 0) + 5; played[m.away] = (played[m.away] || 0) + 5;
  }
  const rate = (t) => played[t] ? won[t] / played[t] : 0.5;
  return 0.5 + (rate(home) - rate(away)) / 2;
}

export function statusOf(m, mk, now = Date.now()) {
  if (mk && mk.settled) return 'settled';
  if (m.h !== null) return 'final';                 // score is in, about to settle
  if (m.closesAt === null) return 'paused';          // postponed, no make-up date yet
  if (now >= m.closesAt) return 'closed';            // match night has started
  if (now < m.closesAt - OPEN_DAYS * 86400000) return 'upcoming';
  return 'open';
}

// Create markets that just opened and settle markets whose score is in.
// Mutates `db`; returns true if anything changed.
export function syncMarkets(db, matches, now = Date.now()) {
  let changed = false;
  for (const m of matches) {
    let mk = db.markets[m.key];
    const st = statusOf(m, mk, now);
    // Open a market once it's inside the 14-day window (a postponed match keeps its
    // market, paused, if it was already in the window on its original date)
    const inWindow = st === 'open' || (st === 'paused' && now >= sheetDateMs(m.date) - OPEN_DAYS * 86400000 && now < sheetDateMs(m.date) + 86400000);
    if (!mk && inWindow) {
      mk = db.markets[m.key] = seedMarket(seedProb(matches, m.home, m.away)); changed = true;
    }
    if (mk && !mk.settled && m.h !== null) {
      const winner = m.h > m.a ? 'home' : 'away';
      for (const [pid, book] of Object.entries(db.pos)) {
        const p = book[m.key]; if (!p) continue;
        const pay = PAYOUT * (winner === 'home' ? p.h : p.a);
        const pl = db.players[pid];
        if (pl) {
          pl.cash = round2(pl.cash + pay);
          (pl.history = pl.history || []).unshift({ key: m.key, h: p.h, a: p.a, spent: round2(p.spent), paid: pay, at: now });
          pl.history = pl.history.slice(0, 40);
        }
        delete book[m.key];
      }
      mk.settled = winner; mk.settledAt = now; mk.final = { h: m.h, a: m.a }; mk.lastPh = priceHome(mk);
      changed = true;
    }
  }
  return changed;
}

export const round2 = (x) => Math.round(x * 100) / 100;

// ── Storage (one JSON blob, optimistic locking with ETags) ──────────
const emptyDb = () => ({ players: {}, markets: {}, pos: {}, trades: [] });
export async function readDb() {
  const r = await getStore('nhda').getWithMetadata(MARKET_KEY, { type: 'json' });
  return r ? { db: r.data || emptyDb(), etag: r.etag, exists: true } : { db: emptyDb(), etag: null, exists: false };
}
// fn(db) mutates and returns a result; retried if someone else wrote first
export async function mutate(fn) {
  const store = getStore('nhda');
  for (let i = 0; i < 6; i++) {
    const { db, etag, exists } = await readDb();
    const result = await fn(db);
    if (result && result.noWrite) return result;
    // ETag guards against two trades landing at once (plain write if the store doesn't report one)
    const w = await store.setJSON(MARKET_KEY, db, etag ? { onlyIfMatch: etag } : exists ? {} : { onlyIfNew: true });
    if (w.modified !== false) return result;
    await new Promise(r => setTimeout(r, 60 + Math.random() * 140));
  }
  throw new Error('Busy — try again');
}

// ── Players: name + 4-digit PIN ─────────────────────────────────────
const secret = () => process.env.NHDA_SECRET || '';
const sign = (data) => createHmac('sha256', secret()).update('mkt:' + data).digest('base64url');
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
export const hashPin = (pin, salt) => scryptSync(String(pin), salt, 32).toString('base64url');
export const newSalt = () => randomBytes(12).toString('base64url');
export const newId = () => randomBytes(6).toString('hex');
export const pinOk = (pl, pin) => same(hashPin(pin, pl.salt), pl.hash);
export function playerToken(id) {
  const data = `${id}.${Date.now() + TOKEN_DAYS * 86400000}`;
  return `${data}.${sign(data)}`;
}
export function tokenPlayer(token) {
  if (!secret() || typeof token !== 'string') return null;
  const i = token.lastIndexOf('.'); if (i < 0) return null;
  const data = token.slice(0, i), [id, exp] = data.split('.');
  return same(token.slice(i + 1), sign(data)) && +exp > Date.now() ? id : null;
}
