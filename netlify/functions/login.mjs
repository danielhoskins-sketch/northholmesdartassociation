// netlify/functions/login.mjs
// POST /api/login  ← { pw }  → { token }
// The site password is checked here, on the server, so it never appears in the page source.
import { configured, checkPassword, makeToken } from '../lib/auth.mjs';

const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!configured()) return json({ error: 'Login is not set up' }, 500);
  let body;
  try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
  if (!body || !checkPassword(body.pw)) {
    await new Promise(r => setTimeout(r, 600)); // slow down guessing
    return json({ error: 'Incorrect password' }, 401);
  }
  return json({ token: makeToken() });
};

export const config = { path: '/api/login' };
