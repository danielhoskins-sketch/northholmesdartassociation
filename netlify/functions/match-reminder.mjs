// netlify/functions/match-reminder.mjs
// Scheduled: at 6 PM Chicago time, if tomorrow is a match night, push a reminder
// to every phone that turned reminders on.
// Netlify schedules run in UTC, so this fires at both 23:00 and 00:00 UTC and
// only acts on the run where it's 6 PM in Chicago (CDT in summer/fall, CST in winter).
import { getStore } from '@netlify/blobs';
import { SCHEDULE_URL, MAKEUPS_KEY, parseCSV, chicagoParts, sheetDateFor, nightFor, reminderText } from '../lib/matchnight.mjs';
import { readSubs, writeSubs, pushReady, sendAll } from '../lib/push.mjs';

export default async () => {
  const now = chicagoParts();
  if (now.hour !== 18) return new Response('Not 6 PM in Chicago');
  if (!pushReady()) { console.error('VAPID keys missing'); return new Response('Not configured'); }

  const tomorrow = sheetDateFor(now, 1);
  const store = getStore('nhda');
  const sentFor = await store.get('push-last-sent', { type: 'text' });
  if (sentFor === tomorrow) return new Response('Already sent');

  const res = await fetch(SCHEDULE_URL, { cache: 'no-store' });
  if (!res.ok) { console.error('sheet fetch failed', res.status); return new Response('Sheet unavailable'); }
  const rows = parseCSV(await res.text());
  const overrides = (await store.get(MAKEUPS_KEY, { type: 'json' })) || {};
  const msg = reminderText(nightFor(tomorrow, rows, overrides));
  if (!msg) return new Response(`No match on ${tomorrow}`);

  const subs = await readSubs();
  const r = await sendAll(subs, msg);
  if (r.gone.length) { r.gone.forEach(id => delete subs[id]); await writeSubs(subs); }
  await store.set('push-last-sent', tomorrow);
  console.log(`Reminder for ${tomorrow}: sent ${r.sent}, failed ${r.failed}, removed ${r.gone.length}`);
  return new Response('ok');
};

export const config = { schedule: '0 23,0 * * *' };
