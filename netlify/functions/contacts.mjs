// netlify/functions/contacts.mjs
// Member contact list for the Contacts tab.
// The list lives in the Netlify environment variable NHDA_CONTACTS (not in this
// public repo) as JSON: [["Name","Phone","Email"], ...].
// Returned only when the site password is posted.

const PASSWORD = process.env.NHDA_PASSWORD || 'doobie';
const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
  if (!body || body.pw !== PASSWORD) return json({ error: 'Not authorized' }, 401);

  let list = [];
  try { list = JSON.parse(process.env.NHDA_CONTACTS || '[]'); } catch { return json({ error: 'Contact list is not set up' }, 500); }
  const contacts = list
    .filter(r => Array.isArray(r) && r[0])
    .map(([name, phone = '', email = '']) => ({ name: String(name).trim(), phone: String(phone).trim(), email: String(email).trim() }));
  return json({ contacts });
};

export const config = { path: '/api/contacts' };
