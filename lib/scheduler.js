// The delayed job. Default: Upstash QStash (free tier), which calls /api/jobs/run when a job is due.
// To move to Vercel Cron later, set SCHEDULER=cron: the same jobs are kept in the store and /api/jobs/tick
// (called by a cron entry in vercel.json) runs whatever is due. Nothing else in the code changes.
const crypto = require('crypto');
const cfg = require('./config');
const store = require('./store');

const JOB_TTL = 8 * 86400;

function callbackUrl() {
  let url = cfg.siteUrl() + '/api/jobs/run';
  // A protected preview: the queue's call-back needs Vercel's automation bypass
  if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) url += '?x-vercel-protection-bypass=' + encodeURIComponent(process.env.VERCEL_AUTOMATION_BYPASS_SECRET);
  return url;
}

// kind: 'task' | 'retry' | 'check'
async function schedule(kind, payload, runAtMs) {
  const id = crypto.randomBytes(9).toString('hex');
  const job = { id, kind, payload, runAt: runAtMs };
  await store.set('job:' + id, job, { ttl: JOB_TTL });

  if (cfg.schedulerMode() === 'cron') {
    await store.zadd('jobs', runAtMs, id);
    return id;
  }

  const base = (process.env.QSTASH_URL || 'https://qstash.upstash.io').replace(/\/+$/, '');
  const res = await fetch(`${base}/v2/publish/${callbackUrl()}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.QSTASH_TOKEN || ''}`,
      'Content-Type': 'application/json',
      'Upstash-Not-Before': String(Math.max(Math.ceil(runAtMs / 1000), Math.ceil(Date.now() / 1000))),
      'Upstash-Retries': '3'
    },
    body: JSON.stringify({ jobId: id })
  });
  if (!res.ok) {
    // Keep it in the due list too, so a later switch to cron still finds it
    await store.zadd('jobs', runAtMs, id).catch(() => {});
    throw new Error('QStash publish failed: ' + res.status + ' ' + (await res.text().catch(() => '')));
  }
  return id;
}

// Only the queue may start a job: check QStash's signature (a JWT signed with one of the two signing keys)
function verifyQStash(rawBody, signature) {
  if (!signature) return false;
  const parts = String(signature).split('.');
  if (parts.length !== 3) return false;
  const keys = [process.env.QSTASH_CURRENT_SIGNING_KEY, process.env.QSTASH_NEXT_SIGNING_KEY].filter(Boolean);
  const data = parts[0] + '.' + parts[1];
  const okSig = keys.some(key => {
    const expected = crypto.createHmac('sha256', key).update(data).digest('base64url');
    const a = Buffer.from(expected);
    const b = Buffer.from(parts[2]);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
  if (!okSig) return false;
  let claims;
  try { claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch (e) { return false; }
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp && now > claims.exp) return false;
  if (claims.nbf && now < claims.nbf - 5) return false;
  if (claims.iss && claims.iss !== 'Upstash') return false;
  const bodyHash = crypto.createHash('sha256').update(rawBody || '').digest('base64url');
  if (claims.body && claims.body.replace(/=+$/, '') !== bodyHash) return false;
  try { if (claims.sub && !new URL(claims.sub).pathname.endsWith('/api/jobs/run')) return false; } catch (e) { return false; }
  return true;
}

// Vercel Cron sends "Authorization: Bearer {CRON_SECRET}"
function verifyCron(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const given = String(req.headers.authorization || '');
  const expected = 'Bearer ' + secret;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { schedule, verifyQStash, verifyCron, callbackUrl };
