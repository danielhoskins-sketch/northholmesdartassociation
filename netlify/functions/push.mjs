// netlify/functions/push.mjs
// Match-night reminders: phones opt in / out here.
//   GET  /api/push                                   → { publicKey }
//   POST /api/push { token, action: 'subscribe', sub } → { ok }
//   POST /api/push { token, action: 'unsubscribe', endpoint }
//   POST /api/push { token, action: 'test', endpoint }  → sends a test to that one phone
import { authorized } from '../lib/auth.mjs';
import { readSubs, writeSubs, idFor, pushReady, sendAll } from '../lib/push.mjs';

const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const validSub = (s) => s && typeof s.endpoint === 'string' && /^https:\/\//.test(s.endpoint) && s.endpoint.length < 1000
  && s.keys && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string';

export default async (req) => {
  if (req.method === 'GET') return json({ publicKey: process.env.VAPID_PUBLIC_KEY || '' });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
  if (!authorized(body)) return json({ error: 'Not authorized' }, 401);
  if (!pushReady()) return json({ error: 'Reminders are not set up yet' }, 500);

  const subs = await readSubs();
  if (body.action === 'subscribe') {
    const s = body.sub;
    if (!validSub(s)) return json({ error: 'Bad subscription' }, 400);
    subs[idFor(s.endpoint)] = { sub: { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } }, at: new Date().toISOString() };
    await writeSubs(subs);
    return json({ ok: true, count: Object.keys(subs).length });
  }
  if (body.action === 'unsubscribe') {
    delete subs[idFor(body.endpoint)];
    await writeSubs(subs);
    return json({ ok: true });
  }
  if (body.action === 'test') {
    const id = idFor(body.endpoint); const one = subs[id];
    if (!one) return json({ error: 'This phone is not signed up' }, 404);
    const r = await sendAll({ [id]: one }, { title: '🎯 NHDA reminders are on', body: "You'll get a heads-up at 6 PM the night before each match night.", tag: 'nhda-test' });
    if (r.gone.length) { delete subs[id]; await writeSubs(subs); }
    return json({ ok: r.sent === 1 });
  }
  return json({ error: 'Unknown action' }, 400);
};

export const config = { path: '/api/push' };
