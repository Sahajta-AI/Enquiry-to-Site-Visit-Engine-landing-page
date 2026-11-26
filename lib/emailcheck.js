// The email check before the open times show (Notion "URGENT: A wrong email must never block a booking", 26 Nov).
// Cal.com refuses a booking when the email's domain can't receive mail (its check can't be switched off on our plan),
// so we ask the person to fix it first. Two parts:
// - suggest(): a likely typo of a common provider ("gmial.com", "gmail.co", "yahoo.con") -> "Did you mean …?"
// - domainStatus(): 'ok' (it has mail servers, or an address record mail can fall back to), 'none' (the domain
//   doesn't exist, or exists with no way to take mail), 'unsure' (slow DNS, any error).
// The check FAILS OPEN: only a definite 'none' ever stops someone. Anything unsure lets them through.
const dns = require('dns').promises;
let defaultResolver = dns; // tests swap in a fake (no network)

const COMMON = ['gmail.com', 'yahoo.com', 'yahoo.co.in', 'yahoo.in', 'hotmail.com', 'outlook.com', 'live.com',
  'icloud.com', 'rediffmail.com', 'protonmail.com', 'proton.me', 'aol.com', 'zoho.com', 'msn.com', 'me.com', 'ymail.com'];
// Real providers close to a common one: never "corrected" (mail.com is one letter from gmail.com)
const KNOWN_OK = ['mail.com', 'email.com', 'gmx.com', 'gmx.net', 'live.in', 'outlook.in', 'hotmail.co.uk', 'yahoo.co.uk',
  'rocketmail.com', 'mac.com', 'aim.com', 'inbox.com', 'zohomail.com', 'zohomail.in', 'hey.com', 'fastmail.com'];
const TLD_FIX = { con: 'com', cmo: 'com', ocm: 'com', comm: 'com', vom: 'com', xom: 'com', cpm: 'com', coom: 'com', om: 'com', co: 'com' };

// Damerau-Levenshtein (optimal string alignment): one swap of two neighbouring letters counts as one change
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i].concat(Array(b.length).fill(0)));
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

function split(email) {
  const v = String(email || '').trim();
  const at = v.lastIndexOf('@');
  if (at < 1 || at === v.length - 1) return null;
  return { local: v.slice(0, at), domain: v.slice(at + 1).toLowerCase() };
}

// A corrected address for a likely typo of a common provider, or '' (never for a domain that's already right)
function suggest(email) {
  const p = split(email);
  if (!p) return '';
  const domain = p.domain;
  if (COMMON.includes(domain) || KNOWN_OK.includes(domain)) return '';
  // Wrong ending on a common provider: "gmail.con", "gmail.co", "hotmail.cmo"
  const dot = domain.lastIndexOf('.');
  if (dot > 0) {
    const fixed = domain.slice(0, dot) + '.' + (TLD_FIX[domain.slice(dot + 1)] || domain.slice(dot + 1));
    if (fixed !== domain && COMMON.includes(fixed)) return p.local + '@' + fixed;
  }
  // A misspelt provider: "gmial.com", "gamil.com", "hotmial.com", "yahooo.com", "outlok.com"
  let best = '', bestD = 3;
  for (const c of COMMON) {
    const dd = distance(domain, c);
    const limit = c.length <= 7 ? 1 : 2; // short names ("me.com", "aol.com") only one letter off
    if (dd <= limit && dd < bestD) { best = c; bestD = dd; }
  }
  return best ? p.local + '@' + best : '';
}

const cache = new Map(); // domain -> { status, at }
const CACHE_MS = 10 * 60 * 1000;

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), ms))]);
}

// 'ok' | 'none' | 'unsure'. NXDOMAIN ('ENOTFOUND') is the only "doesn't exist"; a domain with no mail servers
// can still take mail at its address record (RFC 5321), so 'none' needs both to be missing.
async function domainStatus(domain, opts) {
  const o = opts || {};
  const resolver = o.resolver || defaultResolver;
  const ms = o.timeoutMs || 2500;
  const d = String(domain || '').toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(d)) return 'unsure'; // odd shapes (unicode etc.): never block
  const hit = cache.get(d);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.status;
  let status = 'unsure';
  try {
    const mx = await withTimeout(resolver.resolveMx(d), ms);
    const real = (mx || []).filter(r => r && r.exchange && r.exchange !== '.');
    if (real.length) status = 'ok';
    else if ((mx || []).length) status = 'none'; // a "null MX": the domain says it takes no mail
    else status = await addressStatus(resolver, d, ms);
  } catch (err) {
    if (err.code === 'ENOTFOUND') status = 'none';
    else if (err.code === 'ENODATA') status = await addressStatus(resolver, d, ms);
    else status = 'unsure';
  }
  if (status !== 'unsure') cache.set(d, { status, at: Date.now() });
  return status;
}

async function addressStatus(resolver, d, ms) {
  try {
    const a = await withTimeout(resolver.resolve4(d), ms);
    return a && a.length ? 'ok' : 'none';
  } catch (err) {
    if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') return 'none';
    return 'unsure';
  }
}

// { ok, reason, suggestion }. ok is false only when the domain definitely can't take mail.
async function check(email, opts) {
  const p = split(email);
  if (!p) return { ok: true, reason: 'unsure', suggestion: '' };
  const suggestion = suggest(email);
  const status = await domainStatus(p.domain, opts);
  return { ok: status !== 'none', reason: status === 'none' ? 'no-domain' : status, suggestion };
}

module.exports = { suggest, domainStatus, check, distance, _clearCache: () => cache.clear(), _setResolver: (r) => { defaultResolver = r || dns; cache.clear(); } };
