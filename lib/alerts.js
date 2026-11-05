// Alerts to Shubhang when an automatic email fails (Thank-you Page Brief v1, 8.1 and 8.3).
// Two ways, in case Gmail itself is failing: Gmail first, then a free transactional email service (Resend).
const cfg = require('./config');
const gmail = require('./gmail');
const emails = require('./emails');
const store = require('./store');

async function viaGmail(subject, text) {
  if (!gmail.isConfigured()) throw new Error('Gmail is not configured');
  await gmail.send({ to: cfg.senderEmail(), subject, text, html: emails.toHtml(text, []) });
}

async function viaResend(subject, text) {
  if (!process.env.RESEND_API_KEY || process.env.RESEND_API_KEY.includes('placeholder')) throw new Error('Resend is not configured');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.FROM_EMAIL || 'onboarding@resend.dev',
      to: [cfg.backupAlertTo()],
      subject,
      text
    })
  });
  if (!res.ok) throw new Error('Resend ' + res.status + ': ' + (await res.text().catch(() => '')));
}

// One alert per person, never merged or held back. `onceKey` stops a repeat for the same failure.
async function send(subject, text, onceKey) {
  if (onceKey) {
    const first = await store.set('alerted:' + onceKey, 1, { nx: true, ttl: 90 * 86400 }).catch(() => true);
    if (!first) return false;
  }
  console.error('🚨 [Alert]:', subject, '|', text);
  const results = await Promise.allSettled([viaGmail(subject, text), viaResend(subject, text)]);
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.warn(`⚠️ [Alert path ${i === 0 ? 'Gmail' : 'Resend'} failed]:`, r.reason && r.reason.message);
  });
  return results.some(r => r.status === 'fulfilled');
}

module.exports = { send };
