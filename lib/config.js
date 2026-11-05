// Settings for the automatic emails (Thank-you Page Brief v1, parts 1 and 8).
// Everything is read from environment variables at call time, so nothing here needs a restart.

const PRODUCTION_URL = 'https://sahajta-landing-page-brown.vercel.app'; // until warmchain.sahajta.com is live

function isProduction() {
  const env = process.env.VERCEL_ENV || (process.env.NODE_ENV === 'production' ? 'production' : 'development');
  return env === 'production';
}

// Preview and production records live side by side in one store: a key prefix keeps them apart
function keyPrefix() {
  return isProduction() ? 'prod:' : 'pre:';
}

// This site's own address: SITE_URL on production, the preview's own address on a preview
function siteUrl() {
  const set = (process.env.SITE_URL || '').trim().replace(/\/+$/, '');
  if (set) return set;
  if (!isProduction()) {
    const host = process.env.VERCEL_BRANCH_URL || process.env.VERCEL_URL;
    if (host) return 'https://' + host;
    return 'http://localhost:' + (process.env.PORT || 3000);
  }
  return PRODUCTION_URL;
}

function senderEmail() {
  return (process.env.GMAIL_SENDER || 'shubhang@sahajta.com').trim();
}

const SENDER_NAME = 'Shubhang Sethi';

function eventTypeId() {
  const n = parseInt(process.env.CAL_EVENT_TYPE_ID || '6659881', 10);
  return Number.isFinite(n) ? n : 6659881;
}

function backupAlertTo() {
  return (process.env.ALERT_EMAIL_TO || 'shubhangsethi@gmail.com').trim();
}

function nudgesEnabled() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.NUDGES_ENABLED || '').toLowerCase());
}

function nudgeDailyLimit() {
  const n = parseInt(process.env.NUDGE_DAILY_LIMIT || '20', 10);
  return Number.isFinite(n) && n > 0 ? n : 20;
}

// Previews only: "2,5" = first nudge 2 minutes after they leave, second 5 minutes after the first
function nudgeTestWaits() {
  if (isProduction()) return null;
  const raw = (process.env.NUDGE_TEST_WAITS || '').trim();
  if (!raw) return null;
  const parts = raw.split(',').map(s => parseFloat(s));
  if (parts.length !== 2 || parts.some(p => !Number.isFinite(p) || p <= 0)) return null;
  return { first: parts[0] * 60 * 1000, second: parts[1] * 60 * 1000 };
}

function resumeCodeTtlMs() {
  const min = parseFloat(process.env.RESUME_CODE_TTL_MINUTES || '');
  if (!isProduction() && Number.isFinite(min) && min > 0) return min * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000;
}

function schedulerMode() {
  return String(process.env.SCHEDULER || 'qstash').toLowerCase() === 'cron' ? 'cron' : 'qstash';
}

module.exports = {
  isProduction, keyPrefix, siteUrl, senderEmail, SENDER_NAME, eventTypeId, backupAlertTo,
  nudgesEnabled, nudgeDailyLimit, nudgeTestWaits, resumeCodeTtlMs, schedulerMode
};
