// netlify/functions/makeups.mjs
// Shared make-up board for the NHDA site.
// Stores which matches are postponed and their make-up dates in Netlify Blobs,
// so every member sees the same make-up schedule.
//
//   GET  /api/makeups  → { "<date>|<home>|<away>": { postponed: true, makeupDate: "2027-04-09" }, ... }
//   POST /api/makeups  ← { pw, key, postponed?, makeupDate? }

import { getStore } from '@netlify/blobs';

const SEASON_KEY = 'makeups-2026-27';
const PASSWORD = process.env.NHDA_PASSWORD || 'doobie';
const KEY_RE = /^\d{1,2}\.\d{1,2}\.\d{2}\|[^|]{1,40}\|[^|]{1,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });

export default async (req) => {
  const store = getStore('nhda');
  const read = async () => (await store.get(SEASON_KEY, { type: 'json' })) || {};

  if (req.method === 'GET') return json(await read());
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
  if (!body || body.pw !== PASSWORD) return json({ error: 'Not authorized' }, 401);

  const key = typeof body.key === 'string' ? body.key.trim() : '';
  if (!KEY_RE.test(key)) return json({ error: 'Unknown match' }, 400);

  const data = await read();
  const entry = { ...(data[key] || {}) };

  if ('postponed' in body) {
    if (typeof body.postponed !== 'boolean') return json({ error: 'Bad postponed value' }, 400);
    entry.postponed = body.postponed;
  }
  if ('makeupDate' in body) {
    const d = body.makeupDate || '';
    if (d && !DATE_RE.test(d)) return json({ error: 'Bad date' }, 400);
    entry.makeupDate = d;
  }

  if (!entry.postponed && !entry.makeupDate) delete data[key];
  else data[key] = entry;

  await store.setJSON(SEASON_KEY, data);
  return json(data);
};

export const config = { path: '/api/makeups' };
