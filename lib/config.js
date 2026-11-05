// Settings for the automatic emails (Thank-you Page Brief v1, parts 1 and 8).
// Everything is read from environment variables at call time, so nothing here needs a restart.

const PRODUCTION_URL = 'https://site-visit-engine-landing-page.vercel.app'; // until warmchain.sahajta.com is live

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

// The Backend and Tracking Brief's switch (its part 12). It holds back the server's sends to the live Pixel,
// the source data on bookings, the new browser events and Clarity until the new policy pages are live.
// "on" / "off" (or 1 / 0) wins. Empty: on for previews and local copies, off on production.
function newTracking() {
  const v = String(process.env.NEW_TRACKING || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return !isProduction();
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

// ---- Meta (Backend and Tracking Brief, parts 5 and 13) ----
const clean = (v) => String(v || '').trim();

// Production uses the live Pixel; previews and local copies use the Sandbox Pixel. Never a fallback to the live one.
function pixelId() {
  return isProduction() ? clean(process.env.META_PIXEL_ID) : clean(process.env.META_SANDBOX_PIXEL_ID);
}

// target: 'live' or 'sandbox'
function metaTarget(target) {
  if (target === 'live') {
    return { pixelId: clean(process.env.META_PIXEL_ID), token: clean(process.env.META_CAPI_TOKEN), testCode: clean(process.env.META_TEST_EVENT_CODE) };
  }
  return { pixelId: clean(process.env.META_SANDBOX_PIXEL_ID), token: clean(process.env.META_SANDBOX_CAPI_TOKEN), testCode: clean(process.env.META_SANDBOX_TEST_EVENT_CODE) };
}

// Set in one place: Meta's latest stable Graph version
function graphVersion() {
  return clean(process.env.META_GRAPH_VERSION) || 'v26.0';
}

function clarityId() { return clean(process.env.CLARITY_PROJECT_ID); }

function testEmails() {
  return clean(process.env.TEST_EMAILS).split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
}

// A booking is a test when its email is in TEST_EMAILS, or when it is made on any preview or local copy
function isTest(email) {
  return !isProduction() || testEmails().includes(String(email || '').trim().toLowerCase());
}

function testPagePassword() { return clean(process.env.TEST_PAGE_PASSWORD); }

// Where failure alerts go (shubhang@sahajta.com unless a check says otherwise)
function alertEmail() { return clean(process.env.ALERT_EMAIL) || senderEmail(); }

function schedulerMode() {
  return String(process.env.SCHEDULER || 'qstash').toLowerCase() === 'cron' ? 'cron' : 'qstash';
}

module.exports = {
  isProduction, keyPrefix, siteUrl, senderEmail, SENDER_NAME, eventTypeId, backupAlertTo,
  nudgesEnabled, newTracking, pixelId, metaTarget, graphVersion, clarityId, testEmails, isTest, testPagePassword, alertEmail, nudgeDailyLimit, nudgeTestWaits, resumeCodeTtlMs, schedulerMode
};
