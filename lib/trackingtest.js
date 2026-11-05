// The private test page's server side (Backend and Tracking Brief, part 11).
// It uses the same Meta helper and hashing as the real form, only with test settings. Otherwise it proves nothing.
const crypto = require('crypto');
const cfg = require('./config');
const store = require('./store');
const meta = require('./meta');
const leads = require('./leads');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function ipOf(req) { return meta.clientIp(req) || 'unknown'; }

// Constant-time password check, slowed down after repeated wrong tries
async function checkPassword(req) {
  const expected = cfg.testPagePassword();
  if (!expected) return { ok: false, status: 503, error: 'TEST_PAGE_PASSWORD is not set' };
  const key = 'ttfail:' + ipOf(req);
  const given = String(req.headers['x-test-password'] || '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  if (crypto.timingSafeEqual(a, b)) return { ok: true };
  const fails = await store.incr(key, 15 * 60).catch(() => 1);
  await sleep(Math.min(fails * 500, 5000)); // slower after each wrong try
  return { ok: false, status: 401, error: 'Wrong password' };
}

function target(name) {
  const t = cfg.metaTarget(name);
  return { pixelId: t.pixelId, tokenSet: !!t.token, testCodeSet: !!t.testCode };
}

// What the page shows at the top: yes or no only, never the values of the token or the test code
function info() {
  return {
    ok: true,
    production: cfg.isProduction(),
    graphVersion: cfg.graphVersion(),
    sandbox: target('sandbox'),
    live: target('live'),
    newTracking: cfg.newTracking()
  };
}

// The dummy lead: Test Lead, the first email in TEST_EMAILS, a dummy number. Makes no Cal.com booking.
function dummyPerson() {
  return { name: 'Test Lead', email: cfg.testEmails()[0] || 'test-lead@example.com', phone: '9876500000' };
}

const SERVER_EVENTS = {
  Lead: 'Lead Conversion Clarity Call form',
  Schedule: 'Lead Conversion Clarity Call',
  QualifiedBooking: 'Lead Conversion Clarity Call',
  TrackingCheck: 'Tracking check'
};

// One server send. target: 'sandbox' (default) or 'live' (the live check: production only, TrackingCheck only, never a Lead or Schedule).
async function sendEvent(req, body) {
  const event = String(body.event || '');
  if (!(event in SERVER_EVENTS)) return { ok: false, error: 'Unknown event' };
  const eventId = String(body.eventId || crypto.randomUUID());
  const isLive = body.target === 'live';

  if (isLive) {
    if (!cfg.isProduction()) return { ok: false, error: 'The live check works on production only' };
    if (event !== 'TrackingCheck') return { ok: false, error: 'Only TrackingCheck goes to the live Pixel' };
  } else if (event === 'TrackingCheck') {
    return { ok: false, error: 'TrackingCheck is the live check' };
  }

  const person = dummyPerson();
  const result = await meta.send({
    eventName: event, eventId, req, person,
    sourceUrl: String(body.pageUrl || '').slice(0, 500) || undefined,
    customName: SERVER_EVENTS[event],
    fbp: leads.cookieFrom(req, '_fbp') || undefined, fbc: leads.cookieFrom(req, '_fbc') || undefined,
    target: isLive ? 'live' : 'sandbox'
  }, { liveCheck: isLive, noAlert: true });

  // The match keys sent: yes or no only
  const built = meta.buildEvent({ eventName: event, eventId, req, person, fbp: leads.cookieFrom(req, '_fbp'), fbc: leads.cookieFrom(req, '_fbc') });
  const u = built.user_data;
  const keys = {
    email: !!u.em, phone: !!u.ph, name: !!(u.fn || u.ln), country: !!u.country, external_id: !!u.external_id,
    fbp: !!u.fbp, fbc: !!u.fbc, ip: !!u.client_ip_address, user_agent: !!u.client_user_agent
  };
  return Object.assign({ eventId, target: isLive ? 'live' : 'sandbox', matchKeys: keys }, result);
}

async function handle(req) {
  const auth = await checkPassword(req);
  if (!auth.ok) return { status: auth.status, body: { ok: false, error: auth.error } };
  const action = String((req.body && req.body.action) || '');
  if (action === 'info') return { status: 200, body: info() };
  if (action === 'send') return { status: 200, body: await sendEvent(req, req.body) };
  return { status: 400, body: { ok: false, error: 'Unknown action' } };
}

module.exports = { handle, info, sendEvent };
