// The record of each visit's details (/api/lead), the "Didn't book" and "No times shown" signals (part 7),
// and the nudges' own links (8.3). Nudges start only from the record this keeps after its checks,
// never from details the browser sends with the signal.
const crypto = require('crypto');
const cfg = require('./config');
const t = require('./time');
const store = require('./store');
const gmail = require('./gmail');
const emails = require('./emails');
const alerts = require('./alerts');
const scheduler = require('./scheduler');

const DAY = 86400;
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const idRegex = /^[A-Za-z0-9_-]{8,64}$/;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let recordWaitMs = 2000; // how long to wait for the details record before checking again (a few seconds)
const norm = (e) => String(e || '').trim().toLowerCase();

// Only this site may call these (part 8.3: refuse another website's Origin)
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  let host;
  try { host = new URL(origin).host; } catch (e) { return false; }
  const allowed = new Set([req.headers.host, req.headers['x-forwarded-host']].filter(Boolean));
  try { allowed.add(new URL(cfg.siteUrl()).host); } catch (e) {}
  return allowed.has(host);
}

function cleanLead(body) {
  const s = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  return {
    name: s(body.name, 120),
    company: s(body.company, 160),
    email: s(body.email, 200),
    whatsapp_number: s(body.whatsapp_number, 30),
    q1_situation: s(body.q1_situation, 200),
    q2_urgency: s(body.q2_urgency, 200),
    timezone: t.isValidTimeZone(body.timezone) ? body.timezone : 'Asia/Kolkata',
    fbp: s(body.fbp, 120),
    fbc: s(body.fbc, 200)
  };
}

// POST /api/lead: keep the details for 24 hours (and in the nudge's copy, if one exists)
async function saveLead(body) {
  const id = String(body.lead_event_id || '');
  if (!idRegex.test(id)) return { ok: false, reason: 'bad-id' };
  // Bots: a filled trap field, or a form sent too fast: keep nothing
  if (body.trap) return { ok: true, kept: false };
  if (!(Number(body.form_ms) >= 2500)) return { ok: true, kept: false };
  const lead = cleanLead(body);
  if (!lead.name || !lead.company || !emailRegex.test(lead.email) || !lead.whatsapp_number) return { ok: false, reason: 'bad-details' };

  const existing = await store.get('lead:' + id);
  await store.set('lead:' + id, { lead, createdAt: existing ? existing.createdAt : Date.now(), booked: existing ? !!existing.booked : false }, { ttl: DAY });

  // Back, with changed details: update the nudge's copy too (same lead_event_id)
  const link = await store.get('nudgelead:' + id);
  if (link && link.code) {
    const n = await store.get('nudge:' + link.code);
    if (n && !n.used) await store.update('nudge:' + link.code, { lead: Object.assign({}, n.lead, lead) });
  }
  return { ok: true, kept: true };
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
    console.error('❌ [Nudge start failed]:', err.message);
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

  const pairStarted = canStartPair ? await startPair(lead, eventId) : false;
  const tpl = emails.leaveEmail(kind, lead, pairStarted ? emails.NUDGE_STARTED_LINE : emails.NUDGE_NONE_LINE);

  if (!gmail.isConfigured()) {
    console.warn('⚠️ [Leave email not sent]: Gmail is not configured. Would send:', tpl.subject);
    return 'gmail-not-configured';
  }
  // From his mailbox to itself (check with him that this makes his phone alert)
  await gmail.send({ to: cfg.senderEmail(), subject: tpl.subject, text: tpl.text, html: emails.toHtml(tpl.text, []) });
  return pairStarted ? 'sent+nudges' : 'sent';
}

// ---------- Opening a nudge's link ----------
async function lookupResume(code) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(code || ''))) return null;
  const n = await store.get('nudge:' + code);
  if (!n || n.used) return null;
  if (Date.now() - n.createdAt > cfg.resumeCodeTtlMs()) return null;
  return n;
}

module.exports = { _setRecordWaitMs: (ms) => { recordWaitMs = ms; }, originAllowed, saveLead, markBooked, handleSignal, lookupResume, startPair, norm };
