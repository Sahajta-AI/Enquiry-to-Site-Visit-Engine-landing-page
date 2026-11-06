// Signals from Odoo to Meta, after the call (Odoo Brief v1, part 6). A job every 15 minutes on Vercel Pro (once a day on Hobby)
// finds Meta leads that reached Qualified, Proposal Sent or Deal Closed, and sends QualifiedAfterCall and Purchase.
// Production sends to the live Pixel only while NEW_TRACKING is on. Tests ("[TEST] " leads) go to the Sandbox only.
const cfg = require('./config');
const t = require('./time');
const store = require('./store');
const alerts = require('./alerts');
const meta = require('./meta');
const cal = require('./cal');
const odoo = require('./odoo');
const ol = require('./odooleads');

const DAY = 86400000;
const WINDOW_DAYS = 6;
const TRANSIENT_CODES = [4, 17, 32, 613];
const norm = ol.norm;

function utcSeconds(s) {
  const ms = Date.parse(String(s || '').replace(' ', 'T') + 'Z');
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : Math.floor(Date.now() / 1000);
}
const utcString = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

// What goes to Meta (6.3). Never the answers, the notes, or a name or email in clear.
function buildSignalEvent(a) {
  const hashList = (vals, fn) => [...new Set(vals.filter(Boolean).map(fn).filter(Boolean))];
  const { fn, ln } = meta.nameParts(a.name);
  const md = a.metadata || {};
  const user = {
    external_id: [meta.hashEmail(a.email)],
    em: hashList([a.email, a.leadEmail && norm(a.leadEmail) !== norm(a.email) ? a.leadEmail : ''], meta.hashEmail),
    ph: hashList([a.phone, a.leadPhone], meta.hashPhone),
    fn: fn ? [meta.sha256(fn)] : undefined,
    ln: ln ? [meta.sha256(ln)] : undefined,
    country: meta.phoneDigits(a.phone).length === 12 && meta.phoneDigits(a.phone).startsWith('91') ? [meta.sha256('in')] : undefined,
    fbc: md.fbc || undefined, fbp: md.fbp || undefined,
    client_ip_address: md.client_ip || undefined, client_user_agent: md.client_user_agent || undefined
  };
  Object.keys(user).forEach(k => { if (user[k] === undefined || (Array.isArray(user[k]) && !user[k].length)) delete user[k]; });
  const ev = {
    event_name: a.eventName,
    event_time: a.eventTime,
    event_id: a.eventId,
    action_source: 'system_generated',
    user_data: user
  };
  ev.custom_data = a.eventName === 'Purchase'
    ? { value: a.value, currency: 'INR', content_name: 'Enquiry-to-Site-Visit Engine' }
    : { content_name: 'Lead Conversion Clarity Call' };
  return ev;
}

async function bookingFor(lead) {
  const kept = await store.get('odoouid:' + lead.id);
  if (kept && kept.uid) {
    try {
      const b = await cal.getBookingFull(kept.uid);
      if (b.metadata && b.metadata.lead_event_id) return b;
    } catch (e) { /* fall back to the search below */ }
  }
  const list = await cal.bookingsFullForEmail(lead.email_from || '');
  return list.find(b => b.metadata && b.metadata.lead_event_id) || null;
}

async function one(lead, ids, opts, log) {
  const isTestLead = String(lead.name || '').startsWith(ol.TEST_PREFIX) || cfg.testEmails().includes(norm(lead.email_from));
  if (!opts.tests && isTestLead) { log(`${lead.id}: skipped (test lead)`); return; }

  const stage = Array.isArray(lead.stage_id) ? lead.stage_id[0] : lead.stage_id;
  const due = [];
  if (!(await store.get(`odoosent:${lead.id}:QualifiedAfterCall`))) due.push('QualifiedAfterCall');
  if (stage === ids.won && !(await store.get(`odoosent:${lead.id}:Purchase`))) due.push('Purchase');
  if (!due.length) return;

  const booking = await bookingFor(lead);
  if (!booking) { log(`${lead.id}: no booking with lead_event_id yet, will look again`); return; }
  if (!opts.tests && booking.metadata.test === 'yes') { log(`${lead.id}: skipped (test booking)`); return; }
  const leadEventId = booking.metadata.lead_event_id;
  const notes = ol.parseNotes(booking.notes);

  for (const eventName of due) {
    let value;
    if (eventName === 'Purchase') {
      value = Number(lead.expected_revenue) || 0;
      if (value <= 0) { await revenueMissing(lead, log); continue; }
    }
    const rawEvent = buildSignalEvent({
      eventName, eventId: `${leadEventId}-${eventName === 'Purchase' ? 'won' : 'qualified'}`,
      eventTime: utcSeconds(eventName === 'Purchase' ? (lead.date_closed || lead.date_last_stage_update) : lead.date_last_stage_update),
      email: booking.email, leadEmail: lead.email_from, name: booking.name,
      phone: notes.phone || '', leadPhone: lead.phone_sanitized || '', metadata: booking.metadata, value
    });
    const target = opts.tests ? 'sandbox' : 'live';
    const r = await meta.send({ eventName, rawEvent, target }, { noAlert: true });
    if (r.skipped) { log(`${lead.id}: ${eventName} not sent (${r.skipped})`); continue; }
    if (r.ok) {
      await store.set(`odoosent:${lead.id}:${eventName}`, { leadId: lead.id, event: eventName });
      await odoo.note(lead.id, eventName === 'Purchase' ? `Sent to Meta: Purchase ₹${value}` : 'Sent to Meta: QualifiedAfterCall');
      log(`${lead.id}: ${eventName} sent to ${target}, event ID ${rawEvent.event_id}, fbtrace ${r.fbtraceId || '-'}`);
    } else if (!r.status || r.status === 429 || r.status >= 500 || TRANSIENT_CODES.includes(Number(r.code))) {
      log(`${lead.id}: ${eventName} will be tried again next run (${r.error})`);
    } else {
      await store.set(`odoosent:${lead.id}:${eventName}`, { leadId: lead.id, event: eventName, refused: true });
      log(`${lead.id}: ${eventName} refused by Meta (${r.error})`);
      await alerts.send(`Meta refused ${eventName} for an Odoo lead`,
        `Meta refused the ${eventName} event for Odoo lead ${lead.id} (${lead.name}). It will not be tried again.\n\nMeta's message: ${r.error}\nfbtrace_id: ${r.fbtraceId || 'none'}`,
        `odoo-meta:${lead.id}:${eventName}`, { backup: false }).catch(() => {});
    }
  }
}

// A won lead with Expected Revenue 0: no Purchase. One email a day to fill it; on the sixth day, a last one.
async function revenueMissing(lead, log) {
  const link = `${(process.env.ODOO_URL || 'https://sahajta.odoo.com').replace(/\/+$/, '')}/odoo/action-crm.crm_lead_action_pipeline/${lead.id}`;
  const days = Math.floor((Date.now() - Date.parse(String(lead.date_last_stage_update).replace(' ', 'T') + 'Z')) / DAY);
  const last = days >= WINDOW_DAYS - 1;
  log(`${lead.id}: Purchase waits, Expected Revenue is 0`);
  await alerts.send(last ? 'Last chance: a won lead has no Expected Revenue' : 'A won lead has no Expected Revenue',
    `${lead.name} is in Deal Closed, but Expected Revenue is 0, so the Purchase signal can't go to Meta.\n\n` +
    (last ? 'This is the last email: after today it can no longer go to Meta.\n\n' : 'Please fill it with the first payment (first month\'s fee), before GST.\n\n') + link,
    `odoo-rev0:${lead.id}:${t.istDay()}`, { backup: false }).catch(() => {});
}

// opts.tests: only "[TEST] " leads, this environment's event type, the Sandbox, and every step in the returned log
async function run(opts) {
  const o = opts || {};
  const lines = [];
  const log = (l) => { lines.push(l); console.log('📡 [Odoo signals]: ' + l); };

  if (!o.tests && !cfg.isProduction()) return { ok: true, result: 'production-only', log: lines };
  if (!odoo.configured()) return { ok: false, result: 'odoo-not-configured', log: lines };
  if (!o.tests && !cfg.newTracking()) {
    await store.set('odoo:lastrun', { at: Date.now() });
    return { ok: true, result: 'new-tracking-off', log: lines };
  }
  if (!(await store.set('odoo:signals-lock', 1, { nx: true, ttl: 600 }))) return { ok: true, result: 'locked', log: lines };

  try {
    const ids = {
      qualified: await odoo.stageId('Qualified'), proposal: await odoo.stageId('Proposal Sent'), won: await odoo.stageId(ol.STAGES.won)
    };
    const domain = [
      ['x_studio_lead_channel', '=', await ol.metaChannel()],
      ['stage_id', 'in', [ids.qualified, ids.proposal, ids.won].filter(Boolean)],
      ['date_last_stage_update', '>=', utcString(Date.now() - WINDOW_DAYS * DAY)]
    ];
    if (o.tests) domain.push(['name', '=like', ol.TEST_PREFIX + '%']);
    const leads = await odoo.searchRead('crm.lead', domain,
      ['id', 'name', 'email_from', 'phone_sanitized', 'stage_id', 'date_last_stage_update', 'date_closed', 'expected_revenue'], { limit: 200 });
    log(`${leads.length} lead(s) to look at`);
    for (const lead of leads) {
      try { await one(lead, ids, o, log); } catch (err) { log(`${lead.id}: ${err.message}`); }
    }
    await store.set('odoo:lastrun', { at: Date.now() }); // a run that reached Odoo is a good run
    return { ok: true, result: 'done', log: lines };
  } catch (err) {
    log('run failed: ' + err.message);
    return { ok: false, result: 'failed', log: lines };
  } finally {
    await store.del('odoo:signals-lock').catch(() => {});
  }
}

async function lastGoodRun() {
  const r = await store.get('odoo:lastrun');
  return r ? r.at : null;
}

// /api/lead calls this after its reply: no good run for 2 days means an email to Shubhang, once a day at most
async function checkHealth() {
  if (!cfg.isProduction() || !cfg.newTracking() || !odoo.configured()) return;
  const at = await lastGoodRun();
  if (at && Date.now() - at < 2 * DAY) return;
  await alerts.send('The Odoo signal job has not run for 2 days',
    'The job that sends QualifiedAfterCall and Purchase to Meta has had no good run in 2 days. Check CRON_SECRET and the cron entry in Vercel, and that the Odoo API key still works.',
    'odoo-nosignal:' + t.istDay(), { backup: false }).catch(() => {});
}

module.exports = { run, buildSignalEvent, lastGoodRun, checkHealth, utcSeconds };
