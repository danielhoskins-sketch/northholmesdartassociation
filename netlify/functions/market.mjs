// netlify/functions/market.mjs
// NHDA Exchange API — Kalshi-style pick'em on league matches, played for league points.
//
//   GET  /api/market                         → board: markets, leaderboard, recent trades
//   POST /api/market  { action: 'join',   token, name, pin }   → { ptoken, me, board }
//   POST /api/market  { action: 'signin', token, name, pin }   → { ptoken, me, board }
//   POST /api/market  { action: 'me',     ptoken }             → { me, board }
//   POST /api/market  { action: 'trade',  ptoken, key, side: 'home'|'away', n, limit }
//        n > 0 buys n contracts (limit = most pts you'll pay); n < 0 sells (limit = fewest pts you'll take)
//   POST /api/market  { action: 'bailout', ptoken }            → refill a broke player's balance
//
// `token` is the league login token from /api/login, so only members can create a player.

import { authorized } from '../lib/auth.mjs';
import {
  START_CASH, PAYOUT, MAX_PER_TRADE, BAILOUT_CASH, OPEN_DAYS, LIQUIDITY,
  leagueMatches, syncMarkets, statusOf, priceHome, tradeCost, round2,
  readDb, mutate, hashPin, newSalt, newId, pinOk, playerToken, tokenPlayer
} from '../lib/market.mjs';

const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });
class Fail extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }
const nameKey = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ');

// What open contracts would fetch if sold right now (so buying never shows an instant paper profit)
function cashOut(mk, p) {
  if (!mk || mk.settled) return 0;
  const m = { ...mk };
  let v = 0;
  if (p.h) { v -= tradeCost(m, 'home', -p.h); m.qh -= p.h; }
  if (p.a) { v -= tradeCost(m, 'away', -p.a); }
  return v;
}
function openValue(db, pid) {
  let v = 0, n = 0;
  for (const [key, p] of Object.entries(db.pos[pid] || {})) {
    if (!p.h && !p.a) continue;
    v += cashOut(db.markets[key], p); n++;
  }
  return { v, n };
}

function board(db, matches, now = Date.now()) {
  const markets = [];
  for (const m of matches) {
    const mk = db.markets[m.key]; if (!mk) continue;
    const ph = mk.settled ? (mk.settled === 'home' ? 1 : 0) : priceHome(mk);
    let holders = 0;
    for (const book of Object.values(db.pos)) { const p = book[m.key]; if (p && (p.h || p.a)) holders++; }
    markets.push({
      key: m.key, date: m.date, home: m.home, away: m.away, closesAt: m.closesAt, makeup: m.makeup,
      status: statusOf(m, mk, now), ph: round2(ph * 100) / 100, seed: mk.seed, vol: mk.vol || 0, holders,
      settled: mk.settled || null, final: mk.final || null, settledAt: mk.settledAt || null
    });
  }
  const leaderboard = Object.entries(db.players).map(([id, pl]) => {
    const o = openValue(db, id);
    return { name: pl.name, cash: Math.round(pl.cash), worth: Math.round(pl.cash + o.v), open: o.n, bailouts: pl.bailouts || 0,
      pnl: Math.round(pl.cash + o.v - START_CASH - (pl.bailouts || 0) * BAILOUT_CASH) };
  }).sort((a, b) => b.worth - a.worth || a.name.localeCompare(b.name));
  const trades = db.trades.slice(0, 25).map(t => ({ ...t, name: (db.players[t.pid] || {}).name || '—', pid: undefined }));
  return { now, markets, leaderboard, trades, rules: { START_CASH, PAYOUT, MAX_PER_TRADE, BAILOUT_CASH, OPEN_DAYS, LIQUIDITY } };
}

function meView(db, pid) {
  const pl = db.players[pid];
  const positions = Object.entries(db.pos[pid] || {}).filter(([, p]) => p.h || p.a).map(([key, p]) =>
    ({ key, h: p.h, a: p.a, spent: Math.round(p.spent), value: Math.round(cashOut(db.markets[key], p)) }));
  const o = positions.reduce((s, p) => s + p.value, 0);
  return { name: pl.name, cash: Math.round(pl.cash), worth: Math.round(pl.cash + o), bailouts: pl.bailouts || 0, positions,
    history: (pl.history || []).slice(0, 15), canBailout: pl.cash + o < 100 && positions.length === 0 };
}

export default async (req) => {
  try {
    if (req.method === 'GET') {
      const matches = await leagueMatches();
      const now = Date.now();
      let { db } = await readDb();
      if (syncMarkets(structuredClone(db), matches, now)) {
        db = await mutate(d => { syncMarkets(d, matches, now); return d; });
      }
      return json(board(db, matches, now));
    }
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    if (!process.env.NHDA_SECRET) return json({ error: 'Exchange is not set up' }, 500);

    let body;
    try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
    const action = body && body.action;
    const matches = await leagueMatches();
    const now = Date.now();

    if (action === 'join' || action === 'signin') {
      if (!authorized(body)) return json({ error: 'League login expired — reload the page' }, 401);
      const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
      const pin = typeof body.pin === 'string' ? body.pin.trim() : '';
      if (name.length < 2 || name.length > 32) throw new Fail('Pick a name (2–32 characters)');
      if (!/^\d{4}$/.test(pin)) throw new Fail('PIN must be 4 digits');
      const out = await mutate(db => {
        syncMarkets(db, matches, now);
        const found = Object.entries(db.players).find(([, p]) => nameKey(p.name) === nameKey(name));
        if (action === 'join') {
          if (found) throw new Fail('That name is taken — sign in instead', 409);
          const id = newId(), salt = newSalt();
          db.players[id] = { name, salt, hash: hashPin(pin, salt), cash: START_CASH, bailouts: 0, created: now };
          db.pos[id] = {};
          return { id };
        }
        if (!found) throw new Fail('No player by that name — join first', 404);
        const [id, pl] = found;
        if (pl.lockUntil && pl.lockUntil > now) throw new Fail('Too many wrong PINs — try again in 15 minutes', 429);
        if (!pinOk(pl, pin)) {
          pl.fails = (pl.fails || 0) + 1;
          if (pl.fails >= 5) { pl.fails = 0; pl.lockUntil = now + 15 * 60000; }
          return { bad: true };
        }
        if (pl.fails || pl.lockUntil) { pl.fails = 0; pl.lockUntil = 0; } else return { id, noWrite: true };
        return { id };
      });
      if (out.bad) { await new Promise(r => setTimeout(r, 600)); return json({ error: 'Wrong PIN' }, 401); }
      const { db } = await readDb();
      const b = board(db, matches, now);
      return json({ ptoken: playerToken(out.id), me: meView(db, out.id), board: b });
    }

    const pid = tokenPlayer(body.ptoken);
    if (!pid) return json({ error: 'Sign in again' }, 401);

    if (action === 'me') {
      const { db } = await readDb();
      if (!db.players[pid]) return json({ error: 'Sign in again' }, 401);
      const b = board(db, matches, now);
      return json({ me: meView(db, pid), board: b });
    }

    if (action === 'trade') {
      const { key, side } = body; const n = body.n; const limit = Number(body.limit);
      if (side !== 'home' && side !== 'away') throw new Fail('Pick a team');
      if (!Number.isInteger(n) || n === 0 || Math.abs(n) > MAX_PER_TRADE) throw new Fail(`Trade 1–${MAX_PER_TRADE} contracts`);
      const m = matches.find(x => x.key === key); if (!m) throw new Fail('Unknown match', 404);
      const db = await mutate(db => {
        syncMarkets(db, matches, now);
        const pl = db.players[pid]; if (!pl) throw new Fail('Sign in again', 401);
        const mk = db.markets[key]; if (!mk) throw new Fail('This market isn’t open yet');
        const st = statusOf(m, mk, now);
        if (st !== 'open') throw new Fail(st === 'paused' ? 'Match postponed — trading paused until a make-up date is set'
          : st === 'closed' ? 'Trading closed — match night has started' : 'This market is settled');
        const book = db.pos[pid] = db.pos[pid] || {};
        const p = book[key] = book[key] || { h: 0, a: 0, spent: 0 };
        const held = side === 'home' ? p.h : p.a;
        if (n < 0 && -n > held) throw new Fail(`You only hold ${held} of those`);
        const cost = round2(tradeCost(mk, side, n));
        if (n > 0) {
          if (cost > pl.cash + 0.005) throw new Fail(`Not enough points — that costs ${Math.ceil(cost)}`);
          if (Number.isFinite(limit) && cost > limit + 0.5) throw new Fail('Price moved — check the new quote', 409);
        } else if (Number.isFinite(limit) && -cost < limit - 0.5) throw new Fail('Price moved — check the new quote', 409);
        const avgBefore = held ? p.spent / (p.h + p.a) : 0;
        pl.cash = round2(pl.cash - cost);
        if (side === 'home') { p.h += n; mk.qh += n; } else { p.a += n; mk.qa += n; }
        p.spent = n > 0 ? round2(p.spent + cost) : round2(Math.max(0, p.spent - avgBefore * -n));
        if (!p.h && !p.a) delete book[key];
        mk.vol = (mk.vol || 0) + Math.abs(n);
        db.trades.unshift({ at: now, pid, key, side, n, pts: Math.round(Math.abs(cost)), price: Math.round(Math.abs(cost) / Math.abs(n)) });
        db.trades = db.trades.slice(0, 300);
        return db;
      });
      const b = board(db, matches, now);
      return json({ me: meView(db, pid), board: b });
    }

    if (action === 'bailout') {
      const db = await mutate(db => {
        syncMarkets(db, matches, now);
        const pl = db.players[pid]; if (!pl) throw new Fail('Sign in again', 401);
        const hasOpen = Object.values(db.pos[pid] || {}).some(p => p.h || p.a);
        if (hasOpen || pl.cash >= 100) throw new Fail('Bailouts are only for players under 100 pts with nothing riding');
        pl.cash = round2(pl.cash + BAILOUT_CASH); pl.bailouts = (pl.bailouts || 0) + 1;
        return db;
      });
      const b = board(db, matches, now);
      return json({ me: meView(db, pid), board: b });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    if (e instanceof Fail) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: e.message || 'Server error' }, 500);
  }
};

export const config = { path: '/api/market' };
