// Alerts to Shubhang when something fails (Thank-you Page Brief 8.1 and 8.3; Backend and Tracking Brief 7.4).
// Through Gmail (the shared sender, to ALERT_EMAIL). Where the brief asks for it (the emails, and open times failing to
// load) also a second way, in case Gmail itself is failing: a free transactional email service (Resend).
// The limits live in the store: separate copies of a function don't share memory.
const cfg = require('./config');
const gmail = require('./gmail');
const emails = require('./emails');
const store = require('./store');

async function viaGmail(subject, text) {
  if (!gmail.isConfigured()) throw new Error('Gmail is not configured');
  await gmail.send({ to: cfg.alertEmail(), subject, text, html: emails.toHtml(text, []) });
}

async function viaResend(subject, text) {
  if (!process.env.RESEND_API_KEY || process.env.RESEND_API_KEY.includes('placeholder')) throw new Error('Resend is not configured');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(8000),
    body: JSON.stringify({
      from: process.env.FROM_EMAIL || 'onboarding@resend.dev',
      to: [cfg.backupAlertTo()],
      subject,
      text
    }),
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error('Resend ' + res.status + ': ' + (await res.text().catch(() => '')));
}

// One alert per person, never merged or held back. `onceKey` stops a repeat for the same failure.
// options.backup (default true): also try the backup path.
async function send(subject, text, onceKey, options) {
  const backup = !options || options.backup !== false;
  if (onceKey) {
    const first = await store.set('alerted:' + onceKey, 1, { nx: true, ttl: 90 * 86400 }).catch(() => true);
    if (!first) return false;
  }
  console.error('🚨 [Alert]:', subject);
  const paths = [viaGmail(subject, text)];
  if (backup) paths.push(viaResend(subject, text));
  const results = await Promise.allSettled(paths);
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.warn(`⚠️ [Alert path ${i === 0 ? 'Gmail' : 'Resend'} failed]:`, r.reason && r.reason.message);
  });
  return results.some(r => r.status === 'fulfilled');
}

// At most one alert per key every `seconds` (for example 30 minutes per kind), kept in the store
async function rateLimited(key, seconds, subject, text, options) {
  const first = await store.set('alertwin:' + key, 1, { nx: true, ttl: seconds }).catch(() => true);
  if (!first) return false;
  return send(subject, text, null, options);
}

module.exports = { send, rateLimited };
