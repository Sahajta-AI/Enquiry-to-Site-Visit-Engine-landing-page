// The small store (Upstash Redis over its REST API). With no Upstash settings it keeps everything in memory,
// which is enough for local runs and the tests, and loses it on restart.
const cfg = require('./config');

const mem = new Map();   // key -> { v, exp }
const memZ = new Map();  // key -> Map(member -> score)

function remote() {
  return !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

async function cmd(args) {
  const res = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error('Store error: ' + (json.error || res.status));
  return json.result;
}

const k = (key) => cfg.keyPrefix() + key;
const live = (e) => e && !(e.exp && e.exp < Date.now());

async function get(key) {
  if (!remote()) {
    const e = mem.get(k(key));
    return live(e) ? JSON.parse(e.v) : null;
  }
  const v = await cmd(['GET', k(key)]);
  return v == null ? null : JSON.parse(v);
}

// ttl in seconds; nx = "set only if new" (returns false when the key already exists); keepTtl keeps the old expiry
async function set(key, obj, opts) {
  const { ttl, nx, keepTtl } = opts || {};
  const v = JSON.stringify(obj);
  if (!remote()) {
    const kk = k(key);
    const e = mem.get(kk);
    if (nx && live(e)) return false;
    const exp = keepTtl && live(e) ? e.exp : (ttl ? Date.now() + ttl * 1000 : 0);
    mem.set(kk, { v, exp });
    return true;
  }
  const args = ['SET', k(key), v];
  if (ttl && !keepTtl) args.push('EX', String(Math.ceil(ttl)));
  if (keepTtl) args.push('KEEPTTL');
  if (nx) args.push('NX');
  return (await cmd(args)) === 'OK';
}

async function update(key, patch) {
  const cur = await get(key);
  if (!cur) return null;
  const next = Object.assign({}, cur, patch);
  await set(key, next, { keepTtl: true });
  return next;
}

async function del(key) {
  if (!remote()) { mem.delete(k(key)); return; }
  await cmd(['DEL', k(key)]);
}

async function incr(key, ttl) {
  if (!remote()) {
    const kk = k(key);
    const e = mem.get(kk);
    const n = (live(e) ? parseInt(e.v, 10) : 0) + 1;
    mem.set(kk, { v: String(n), exp: live(e) ? e.exp : (ttl ? Date.now() + ttl * 1000 : 0) });
    return n;
  }
  const n = await cmd(['INCR', k(key)]);
  if (n === 1 && ttl) await cmd(['EXPIRE', k(key), String(Math.ceil(ttl))]);
  return n;
}

// Sorted set (the due-jobs list, used only when the scheduler is Vercel Cron)
async function zadd(key, score, member) {
  if (!remote()) {
    if (!memZ.has(k(key))) memZ.set(k(key), new Map());
    memZ.get(k(key)).set(member, score);
    return;
  }
  await cmd(['ZADD', k(key), String(score), member]);
}

async function zdueBefore(key, maxScore) {
  if (!remote()) {
    const z = memZ.get(k(key));
    return z ? [...z.entries()].filter(([, s]) => s <= maxScore).map(([m]) => m) : [];
  }
  return cmd(['ZRANGEBYSCORE', k(key), '-inf', String(maxScore)]);
}

async function zrem(key, member) {
  if (!remote()) { const z = memZ.get(k(key)); if (z) z.delete(member); return; }
  await cmd(['ZREM', k(key), member]);
}

function _resetMemory() { mem.clear(); memZ.clear(); }

module.exports = { remote, get, set, update, del, incr, zadd, zdueBefore, zrem, _resetMemory };
