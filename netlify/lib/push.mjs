// netlify/lib/push.mjs
// Stores phone push subscriptions in Netlify Blobs and sends Web Push messages.
// Netlify env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (keep private), VAPID_SUBJECT (mailto:)
import webpush from 'web-push';
import { getStore } from '@netlify/blobs';
import { createHash } from 'node:crypto';

const SUBS_KEY = 'push-subs';
export const store = () => getStore('nhda');
export const idFor = (endpoint) => createHash('sha256').update(String(endpoint)).digest('hex').slice(0, 24);

export async function readSubs() { return (await store().get(SUBS_KEY, { type: 'json' })) || {}; }
export async function writeSubs(subs) { await store().setJSON(SUBS_KEY, subs); }

export function pushReady() {
  const { VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: priv, VAPID_SUBJECT: subj } = process.env;
  if (!pub || !priv) return false;
  webpush.setVapidDetails(subj || 'mailto:admin@northholmesdartassociation.com', pub, priv);
  return true;
}

// Sends one message to each subscription. Returns { sent, failed, gone: [ids no longer valid] }
export async function sendAll(subs, message) {
  const payload = JSON.stringify({ url: '/', tag: 'nhda-match-night', ...message });
  let sent = 0, failed = 0; const gone = [];
  await Promise.all(Object.entries(subs).map(async ([id, s]) => {
    try { await webpush.sendNotification(s.sub, payload, { TTL: 6 * 3600, urgency: 'normal' }); sent++; }
    catch (e) { failed++; if (e.statusCode === 404 || e.statusCode === 410) gone.push(id); else console.error('push failed', id, e.statusCode, e.body); }
  }));
  return { sent, failed, gone };
}
