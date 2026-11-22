// The record of each visit's details (/api/lead), the "Didn't book" and "No times shown" signals (part 7),
// and the nudges' own links (8.3). Nudges start only from the record this keeps after its checks,
// never from details the browser sends with the signal.
const crypto = require('crypto');
const logsafe = require('./logsafe');
const cfg = require('./config');
const t = require('./time');
const store = require('./store');
const gmail = require('./gmail');
const emails = require('./emails');
const alerts = require('./alerts');
const scheduler = require('./scheduler');
const qualify = require('./qualify');
const meta = require('./meta');
const odooleads = require('./odooleads');
const cal = require('./cal');
const after = require('./after');

const DAY = 86400;
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const idRegex = /^[A-Za-z0-9_-]{8,64}$/; // ids we look up internally (the Lead event ID is a UUID)
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let recordWaitMs = 2000; // how long to wait for the details record before checking again (a few seconds)
const norm = (e) => String(e || '').trim().toLowerCase();

// Only our own pages may call these (Backend and Tracking Brief, part 4): the live address, the old addresses,
// this deployment's preview addresses, and localhost in development. No Origin header is allowed: the other checks still apply.
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  let host;
  try { host = new URL(origin).host; } catch (e) { return false; }
  const allowed = new Set([
    req.headers.host, req.headers['x-forwarded-host'],
    'warmchain.sahajta.com', 'site-visit-engine-landing-page.vercel.app',
    process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL
  ].filter(Boolean));
  try { allowed.add(new URL(cfg.siteUrl()).host); } catch (e) {}
  if (allowed.has(host)) return true;
  return !cfg.isProduction() && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
}

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ATTRIB_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'angle', 'landing_url', 'referrer', 'first_seen'];

// The browser's saved source data (sv_attrib): only the known keys, as short text
function cleanAttrib(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  ATTRIB_KEYS.forEach(k => {
    const v = raw[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, 500);
  });
  return out;
}

// 7.1 Server checks: name 2 to 80, company 1 to 100, a valid email, a WhatsApp number (10 digits starting 6 to 9,
// or + and 8 to 15 digits), and the 2 answers exactly as the form saves them
function validateDetails(body) {
  const s = (v) => String(v == null ? '' : v).trim();
  const lead = {
    name: s(body.name), company: s(body.company), email: s(body.email), whatsapp_number: s(body.whatsapp_number),
    q1_situation: s(body.q1_situation), q2_urgency: s(body.q2_urgency),
    timezone: t.isValidTimeZone(body.timezone) ? body.timezone : 'Asia/Kolkata'
  };
  const ok = lead.name.length >= 2 && lead.name.length <= 80
    && lead.company.length >= 1 && lead.company.length <= 100
    && emailRegex.test(lead.email) && lead.email.length <= 200
    && (/^[6-9]\d{9}$/.test(lead.whatsapp_number) || /^\+\d{8,15}$/.test(lead.whatsapp_number))
    && qualify.Q1_VALUES.includes(lead.q1_situation) && qualify.Q2_VALUES.includes(lead.q2_urgency);
  return { ok, lead };
}

// Reads a cookie value from the request (the browser also posts fbp and fbc itself)
function cookieFrom(req, name) {
  const m = String((req && req.headers && req.headers.cookie) || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}

// POST /api/lead (5.3): checks, then keeps the details for 24 hours under the Lead event ID.
// Bots (a filled trap, or a form sent in under 3 seconds): reply as if all is fine, keep nothing, do nothing.
async function saveLead(body, req) {
  const id = String(body.lead_event_id || '');
  if (!uuidRegex.test(id)) return { status: 400, body: { ok: false, code: 'invalid' } };
  if (body.hp_note || !(Number(body.form_ms) >= 3000)) return { status: 200, body: { ok: true, test: false } };

  const v = validateDetails(body);
  if (!v.ok) return { status: 400, body: { ok: false, code: 'invalid' } };
  const test = cfg.isTest(v.lead.email);
  const attrib = cleanAttrib(body.sv_attrib);
  const fbp = String(body.fbp || cookieFrom(req, '_fbp')).slice(0, 120);
  const fbc = String(body.fbc || cookieFrom(req, '_fbc')).slice(0, 200);
  const pageUrl = String(body.page_url || '').slice(0, 500);

  // The source data is kept only while NEW_TRACKING is on (the privacy and cookie policy check comes first)
  const lead = Object.assign({}, v.lead);
  const consentAt = new Date().toISOString();
  if (cfg.newTracking()) {
    lead.sv_attrib = attrib;
    lead.fbp = fbp;
    lead.fbc = fbc;
    lead.page_url = pageUrl;
    lead.consent_at = consentAt;
  }

  try {
    const existing = await store.get('lead:' + id);
    await store.set('lead:' + id, {
      lead, test, createdAt: existing ? existing.createdAt : Date.now(), consentAt: existing ? existing.consentAt : consentAt,
      booked: existing ? !!existing.booked : false
    }, { ttl: DAY });
    // ODOO_V2 ("Odoo 7"): if leaving without booking never registers (tab closed), 2 hours after the form it counts
    // as "didn't book" when there's still no booking. Once per visit; a failure to queue it never fails the form.
    if (!existing && cfg.odooV2()) {
      await scheduler.schedule('didnt-book-check', { key: id }, Date.now() + 2 * 3600 * 1000)
        .catch(e => console.error('⚠️ [2-hour check not queued]:', logsafe.safe(e.message)));
    }

    // Back, with changed details: update the nudge's copy too (same lead_event_id)
    const link = await store.get('nudgelead:' + id);
    if (link && link.code) {
      const n = await store.get('nudge:' + link.code);
      if (n && !n.used) await store.update('nudge:' + link.code, { lead: Object.assign({}, n.lead, lead) });
    }
  } catch (err) {
    console.error('❌ [/api/lead store]:', logsafe.safe(err.message));
    // The store refused the write: the browser tries again, and Shubhang gets this person's details
    alerts.send('A lead could not be saved',
      `The store refused a lead's details, so the browser will try again.\n\nName: ${v.lead.name}\nCompany: ${v.lead.company}\nEmail: ${v.lead.email}\nWhatsApp: ${v.lead.whatsapp_number}`,
      'leadstore:' + id, { backup: false }).catch(() => {});
    return { status: 503, body: { ok: false, code: 'store' } };
  }

  return {
    status: 200,
    body: { ok: true, test },
    // What goes into Odoo after the reply (the lead, even while NEW_TRACKING is off: Shubhang needs it to follow up)
    odooLead: {
      leadEventId: id, name: v.lead.name, company: v.lead.company, email: v.lead.email, phone: v.lead.whatsapp_number,
      q1: v.lead.q1_situation, q2: v.lead.q2_urgency, attrib, consentAt, test
    },
    // What the server sends to Meta after the reply
    leadEvent: {
      eventName: 'Lead', eventId: id, req,
      person: { name: v.lead.name, email: v.lead.email, phone: v.lead.whatsapp_number },
      sourceUrl: pageUrl, customName: 'Lead Conversion Clarity Call form',
      fbp, fbc: meta.buildFbc(fbc, attrib), test
    }
  };
}

// Called when a booking succeeds: nobody who booked gets a "Didn't book" email or a nudge
async function markBooked(leadEventId, email) {
  if (email) await store.set('booked:' + norm(email), { at: Date.now() }, { ttl: 30 * DAY });
  const id = String(leadEventId || '');
  if (!idRegex.test(id)) return;
  await store.update('lead:' + id, { booked: true });
  const link = await store.get('nudgelead:' + id);
  if (link && link.code) await store.update('nudge:' + link.code, { booked: true });
}

// ---------- The nudge's own link ----------
async function createNudge(lead, leadEventId) {
  const code = crypto.randomBytes(16).toString('base64url'); // 128 bits, URL-safe, holds no name, email or number
  const leftAt = Date.now();
  const ttl = Math.ceil(cfg.resumeCodeTtlMs() / 1000);

  const waits = cfg.nudgeTestWaits();
  const due = waits ? new Date(leftAt + waits.first) : t.holdToMorning(new Date(leftAt + 3600 * 1000), lead.timezone);

  await store.set('nudge:' + code, {
    code, lead, leadEventId, leftAt, createdAt: leftAt, used: false, booked: false, nudge1Due: due.getTime()
  }, { ttl });
  await store.set('nudgelead:' + leadEventId, { code }, { ttl });
  await scheduler.schedule('task', { name: 'nudge1', key: code }, due.getTime());
  return code;
}

// One pair per email address in 30 days, at most N pairs a day (by IST day)
async function startPair(lead, leadEventId) {
  if (!cfg.nudgesEnabled()) return false;
  const email = norm(lead.email);
  const claimed = await store.set('pair:' + email, { at: Date.now() }, { nx: true, ttl: 30 * DAY });
  if (!claimed) return false;

  const day = t.istDay();
  const n = await store.incr('nudgeday:' + day, 2 * DAY);
  if (n > cfg.nudgeDailyLimit()) {
    await store.del('pair:' + email);
    alerts.send('Nudge emails: daily limit reached',
      `${cfg.nudgeDailyLimit()} nudge pairs have started today, so no more start today. This is most likely a bot, and Cloudflare Turnstile may be needed.`,
      'limit:' + day).catch(() => {});
    return false;
  }
  try {
    await createNudge(lead, leadEventId);
    return true;
  } catch (err) {
    console.error('❌ [Nudge start failed]:', logsafe.safe(err.message));
    await store.del('pair:' + email).catch(() => {});
    return false;
  }
}

async function loadLead(leadEventId) {
  for (let i = 0; i < 4; i++) {
    const rec = await store.get('lead:' + leadEventId);
    if (rec) return rec;
    if (i < 3) await sleep(recordWaitMs); // the two calls can cross: check again a few seconds later
  }
  return null;
}

// POST /api/lead-signal { kind: 'didnt_book' | 'no_times', lead_event_id | resume_code }
async function handleSignal({ kind, leadEventId, resumeCode }) {
  if (kind !== 'didnt_book' && kind !== 'no_times') return 'bad-kind';
  if (cfg.odooV2()) return handleSignalV2({ kind, leadEventId, resumeCode });

  let lead, sigKey, canStartPair = false, eventId = null;
  if (resumeCode) {
    const n = await store.get('nudge:' + resumeCode);
    if (!n) return 'no-record';
    if (kind === 'didnt_book') return 'skipped:already-nudged'; // they were reported when they first left
    lead = n.lead;
    sigKey = `sig:r:${resumeCode}:${kind}`;
  } else {
    if (!idRegex.test(String(leadEventId || ''))) return 'no-record';
    const rec = await loadLead(leadEventId);
    if (!rec) return 'no-record'; // never checked, or more than 24 hours old: send nothing
    if (rec.booked) return 'skipped:booked';
    lead = rec.lead;
    eventId = leadEventId;
    sigKey = `sig:${leadEventId}:${kind}`;
    canStartPair = kind === 'didnt_book';
  }

  if (!(await store.set(sigKey, 1, { nx: true, ttl: 2 * DAY }))) return 'duplicate';
  if (!(await store.set(`sigday:${kind}:${norm(lead.email)}:${t.istDay()}`, 1, { nx: true, ttl: 2 * DAY }))) return 'duplicate-email';
  if (await store.get('booked:' + norm(lead.email))) return 'skipped:booked';

  if (kind === 'no_times') after.after(() => odooleads.onNoTimes(lead)); // the lead's follow-up reminder becomes due today
  const pairStarted = canStartPair ? await startPair(lead, eventId) : false;
  const tpl = emails.leaveEmail(kind, lead, pairStarted ? emails.NUDGE_STARTED_LINE : emails.NUDGE_NONE_LINE);

  if (!gmail.isConfigured()) {
    console.warn('⚠️ [Leave email not sent]: Gmail is not configured. Would send:', logsafe.subjectOnly(tpl.subject));
    return 'gmail-not-configured';
  }
  // From his mailbox to itself (check with him that this makes his phone alert)
  await gmail.send({ to: cfg.senderEmail(), subject: tpl.subject, text: tpl.text, html: emails.toHtml(tpl.text, []) });
  return pairStarted ? 'sent+nudges' : 'sent';
}

// ODOO_V2 ("Odoo 7", "Odoo 13", "Odoo 15"): the same checks, but no "Didn't book" or "No times shown" email to
// Shubhang: it all goes into Odoo (a note and, where something needs doing, a reminder). Nudges as before, except for
// a returning lead (no new nudges) and a lead whose open times didn't load (no nudges, no "didn't book" note).
async function handleSignalV2({ kind, leadEventId, resumeCode }) {
  let lead, sigKey, canStartPair = false, eventId = null, test;
  if (resumeCode) {
    const n = await store.get('nudge:' + resumeCode);
    if (!n) return 'no-record';
    if (kind === 'didnt_book') return 'skipped:already-nudged';
    lead = n.lead;
    test = cfg.isTest(lead.email);
    sigKey = `sig:r:${resumeCode}:${kind}`;
  } else {
    if (!idRegex.test(String(leadEventId || ''))) return 'no-record';
    const rec = await loadLead(leadEventId);
    if (!rec) return 'no-record';
    if (rec.booked) return 'skipped:booked';
    lead = rec.lead;
    test = !!rec.test;
    eventId = leadEventId;
    sigKey = `sig:${leadEventId}:${kind}`;
    canStartPair = kind === 'didnt_book';
  }

  if (!(await store.set(sigKey, 1, { nx: true, ttl: 2 * DAY }))) return 'duplicate';
  if (!(await store.set(`sigday:${kind}:${norm(lead.email)}:${t.istDay()}`, 1, { nx: true, ttl: 2 * DAY }))) return 'duplicate-email';
  if (await store.get('booked:' + norm(lead.email))) return 'skipped:booked';

  const noTimesKeys = [`notimes:${norm(lead.email)}:${t.istDay()}`].concat(eventId ? ['notimes:' + eventId] : []);
  if (kind === 'no_times') {
    for (const k of noTimesKeys) await store.set(k, 1, { ttl: 2 * DAY }).catch(() => {});
    after.after(() => odooleads.onNoTimesV2(lead, test));
    return 'noted';
  }
  for (const k of noTimesKeys) if (await store.get(k).catch(() => null)) return 'skipped:no-times';

  const visit = eventId ? await odooleads.visitOf(eventId, 3000) : null;
  if (visit && visit.kind === 'again-booked') return 'skipped:call-booked';
  if (visit && visit.kind === 'again') {
    after.after(() => odooleads.onDidntBookV2(lead, eventId, { again: true, test }));
    return 'noted-again';
  }
  const pairStarted = canStartPair ? await startPair(lead, eventId) : false;
  // "Odoo 12": the 8 am safety net leaves this lead alone while the nudges run (until the day-after-nudge-2 check)
  if (pairStarted) await store.set('odoowait:' + norm(lead.email), 1, { ttl: 5 * DAY }).catch(() => {});
  after.after(() => odooleads.onDidntBookV2(lead, eventId, { nudges: pairStarted, test }));
  return pairStarted ? 'noted+nudges' : 'noted';
}

// The 2-hour "didn't book" check (ODOO_V2): still no booking, no signal yet: the same steps as leaving without booking.
// If Cal.com can't confirm there's no booking, nothing is done (the daily safety net picks the lead up).
async function runDidntBookCheck(id) {
  if (!cfg.odooV2()) return 'off';
  if (!(await store.set('dbcheck:' + id, 1, { nx: true, ttl: 2 * DAY }))) return 'duplicate';
  const rec = await store.get('lead:' + id);
  if (!rec) return 'no-record';
  if (rec.booked || await store.get('booked:' + norm(rec.lead.email))) return 'skipped:booked';
  if (!cal.configured()) return 'skipped:cal-not-configured';
  try {
    if (await cal.hasBookedOrUpcoming(rec.lead.email, rec.createdAt)) return 'skipped:booked';
  } catch (err) {
    console.warn('⚠️ [2-hour check]: Cal.com could not be checked:', logsafe.safe(err.message));
    return 'skipped:cal-unsure';
  }
  return handleSignalV2({ kind: 'didnt_book', leadEventId: id });
}

// ---------- Opening a nudge's link ----------
async function lookupResume(code) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(code || ''))) return null;
  const n = await store.get('nudge:' + code);
  if (!n || n.used) return null;
  if (Date.now() - n.createdAt > cfg.resumeCodeTtlMs()) return null;
  return n;
}

module.exports = { _setRecordWaitMs: (ms) => { recordWaitMs = ms; }, originAllowed, validateDetails, cleanAttrib, cookieFrom, saveLead, markBooked, handleSignal, runDidntBookCheck, lookupResume, startPair, norm };
