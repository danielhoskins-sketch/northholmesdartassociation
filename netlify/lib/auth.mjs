// netlify/lib/auth.mjs
// Shared login helpers. The password lives only in the Netlify environment
// variable NHDA_PASSWORD; tokens are signed with NHDA_SECRET.
import { createHmac, timingSafeEqual } from 'node:crypto';

const TOKEN_DAYS = 120; // one token lasts the season

const secret = () => process.env.NHDA_SECRET || '';
const sign = (data) => createHmac('sha256', secret()).update(data).digest('base64url');
const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export const configured = () => !!(process.env.NHDA_PASSWORD && process.env.NHDA_SECRET);

export function checkPassword(pw) {
  const real = process.env.NHDA_PASSWORD;
  return !!real && typeof pw === 'string' && same(pw.trim(), real);
}

export function makeToken() {
  const exp = Date.now() + TOKEN_DAYS * 86400000;
  const data = `nhda.${exp}`;
  return `${data}.${sign(data)}`;
}

export function checkToken(token) {
  if (!secret() || typeof token !== 'string') return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const data = token.slice(0, i), sig = token.slice(i + 1);
  const exp = Number(data.split('.')[1]);
  return same(sig, sign(data)) && Number.isFinite(exp) && exp > Date.now();
}

// Accepts a login token (current site) or the password itself (pages opened before this change)
export const authorized = (body) => !!body && (checkToken(body.token) || checkPassword(body.pw));
