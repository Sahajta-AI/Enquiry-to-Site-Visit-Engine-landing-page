// Signals from Odoo to Meta, after the call (Odoo Brief v1, part 6). A job every 15 minutes on Vercel Pro (once a day on Hobby)
// finds Meta leads that reached Qualified, Proposal Sent or Deal Closed, and sends QualifiedAfterCall and Purchase.
// Production sends to the live Pixel only while NEW_TRACKING is on. Tests ("[TEST] " leads) go to the Sandbox only.
const cfg = require('./config');
const logsafe = require('./logsafe');
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
  // No email on the lead: no search at all (a blank search could return other people's bookings)
  if (!String(lead.email_from || '').trim()) return null;
  const list = await cal.bookingsFullForEmail(lead.email_from);
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
    // The last one has its own limit (once per lead), so a daily reminder sent earlier the same day never holds it back
    last ? `odoo-rev0-last:${lead.id}` : `odoo-rev0:${lead.id}:${t.istDay()}`, { backup: false }).catch(() => {});
}

// "Odoo 4" (ODOO_V2 only): a Warm-Chain lead that reached Proposal Sent gets one to-do for Shubhang, due that day.
// Found the same way as the signals (stage and date_last_stage_update). One per arrival in the stage: a mark per lead
// and stage date, so a to-do he marks Done isn't made again; none if one is already open.
const PROPOSAL_TODO = 'Update Expected Revenue and MRR to the proposal amount';
async function proposalTodos(o, log) {
  if (!cfg.odooV2()) return;
  if (!(await store.set('odoo:todo-lock', 1, { nx: true, ttl: 600 }))) return;
  try {
    const stage = await odoo.stageId('Proposal Sent');
    const tag = await odoo.warmChainTagId();
    if (!stage || !tag) { log('Proposal Sent to-do: stage or Warm-Chain tag not found'); return; }
    const domain = [
      [odoo.SERVICE_FIELD, 'in', [tag]],
      ['stage_id', '=', stage],
      ['date_last_stage_update', '>=', utcString(Date.now() - WINDOW_DAYS * DAY)],
      o.tests ? ['name', '=like', ol.TEST_PREFIX + '%'] : ['name', 'not like', ol.TEST_PREFIX]
    ];
    const leads = await odoo.searchRead('crm.lead', domain, ['id', 'name', 'user_id', 'date_last_stage_update'], { limit: 200 });
    for (const lead of leads) {
      const mark = `odootodo:proposal:${lead.id}:${lead.date_last_stage_update}`;
      try {
        if (await store.get(mark)) continue;
        const day = t.istDay();
        const open = await odoo.searchRead('mail.activity', [['res_model', '=', 'crm.lead'], ['res_id', '=', lead.id], ['summary', '=', PROPOSAL_TODO]], ['id']);
        if (!(open || []).length) {
          await odoo.call('crm.lead', 'activity_schedule', {
            ids: [lead.id], summary: PROPOSAL_TODO, activity_type_id: await odoo.todoTypeId(),
            user_id: (Array.isArray(lead.user_id) ? lead.user_id[0] : lead.user_id) || (await odoo.userId()), date_deadline: day
          }, {
            check: async () => ((await odoo.searchRead('mail.activity', [['res_model', '=', 'crm.lead'], ['res_id', '=', lead.id], ['summary', '=', PROPOSAL_TODO]], ['id'])) || []).length ? true : null
          });
          log(`${lead.id}: Proposal Sent to-do made, due ${day}`);
        }
        await store.set(mark, { at: Date.now() }, { ttl: 30 * 86400 });
      } catch (err) {
        log(`${lead.id}: Proposal Sent to-do failed (${err.message}), will try again next run`);
        alerts.rateLimited('odoo-todo-fail', 24 * 3600, 'An Odoo to-do could not be made',
          `The "${PROPOSAL_TODO}" to-do could not be made for ${lead.name} (Odoo lead ${lead.id}): ${err.message}. It will be tried again every 15 minutes.`, { backup: false }).catch(() => {});
      }
    }
  } finally {
    await store.del('odoo:todo-lock').catch(() => {});
  }
}

// "Odoo 10" (ODOO_V2 only): a Warm-Chain lead marked Lost loses every open reminder our code made (by title), with
// no note and nothing marked Done. Odoo already clears open activities when a lead is archived (checked on the live
// Odoo, 22 Nov): this is the safety net. Found like the signals: recently changed leads.
async function lostCleanup(o, log) {
  if (!cfg.odooV2()) return;
  const tag = await odoo.warmChainTagId();
  if (!tag) return;
  const domain = [
    ['active', '=', false], [odoo.SERVICE_FIELD, 'in', [tag]], ['write_date', '>=', utcString(Date.now() - WINDOW_DAYS * DAY)],
    o.tests ? ['name', '=like', ol.TEST_PREFIX + '%'] : ['name', 'not like', ol.TEST_PREFIX]
  ];
  const lost = await odoo.searchRead('crm.lead', domain, ['id'], { context: { active_test: false }, limit: 200 });
  for (const lead of lost || []) {
    try {
      const n = await odoo.removeOurReminders(lead.id, odoo.OUR_REMINDERS);
      if (n) log(`${lead.id}: Lost, ${n} of our reminder(s) removed`);
    } catch (err) { log(`${lead.id}: removing reminders failed (${err.message}), will try again next run`); }
  }
}

// "Test bookings" (ODOO_V2 only): "[TEST] " leads and their test Contacts are archived 24 hours after they were made.
// Archive only (never deleted). A lead counts as Lost only when it is archived with probability 0 (as seen on the live
// Odoo, 22 Nov), so a test lead keeps a probability above 0 and stays "Pending", out of the Lost filter.
// A test Contact still linked to an open lead (or the company of an open test person) waits.
const DAY_MS = 86400000;
async function testCleanup(log) {
  if (!cfg.odooV2()) return;
  const before = utcString(Date.now() - DAY_MS);
  const isTestName = (n) => String(n || '').startsWith(ol.TEST_PREFIX);
  const leads = ((await odoo.searchRead('crm.lead', [['name', '=like', ol.TEST_PREFIX + '%'], ['create_date', '<=', before]], ['id', 'name', 'probability'], { limit: 200 })) || [])
    .filter(l => isTestName(l.name));
  for (const l of leads) {
    try {
      const vals = { active: false };
      if (!(Number(l.probability) > 0)) vals.probability = 1; // archived with 0 would count as Lost
      await odoo.write('crm.lead', [l.id], vals);
      const back = await odoo.searchRead('crm.lead', [['id', '=', l.id]], ['id', 'won_status'], { context: { active_test: false }, limit: 1 });
      if (back && back[0] && back[0].won_status === 'lost') {
        alerts.rateLimited('odoo-test-lost', 24 * 3600, 'A test lead shows as Lost in Odoo',
          `Test lead ${l.id} (${l.name}) was archived but Odoo shows it as Lost. Please check it.`, { backup: false }).catch(() => {});
      }
      log(`${l.id}: test lead archived`);
    } catch (err) { log(`${l.id}: archiving the test lead failed (${err.message})`); }
  }
  const contacts = ((await odoo.searchRead('res.partner', [['name', '=like', ol.TEST_PREFIX + '%'], ['create_date', '<=', before]], ['id', 'name'], { limit: 200 })) || [])
    .filter(c => isTestName(c.name));
  if (!contacts.length) return;
  const ids = contacts.map(c => c.id);
  const linked = new Set(((await odoo.searchRead('crm.lead', [['partner_id', 'in', ids]], ['partner_id'], { limit: 500 })) || []).map(r => (Array.isArray(r.partner_id) ? r.partner_id[0] : r.partner_id)));
  const parents = new Set(((await odoo.searchRead('res.partner', [['parent_id', 'in', ids]], ['id', 'parent_id'], { limit: 500 })) || [])
    .filter(r => !ids.includes(r.id) || linked.has(r.id)).map(r => (Array.isArray(r.parent_id) ? r.parent_id[0] : r.parent_id)));
  const archive = ids.filter(id => !linked.has(id) && !parents.has(id));
  if (archive.length) {
    await odoo.write('res.partner', archive, { active: false });
    log(`${archive.length} test Contact(s) archived`);
  }
}

// "Odoo 12" (ODOO_V2 only), daily at 8 am IST: every open Warm-Chain lead (not Won, not Lost, not [TEST]) must have an
// open reminder. Skipped: leads still in the nudge sequence or waiting on the 1-day "Reply to their email" check
// (they get their own reminder), and leads made in the last 3 hours (the 2-hour "didn't book" step comes first).
// Any other lead with no open reminder gets "Next step: plan what's next for this lead" today (no description, no
// note). A failure is tried again once, then Shubhang gets an alert.
const NEXT_STEP = 'Next step: plan what\'s next for this lead';
async function dailySafetyNet(opts) {
  const o = opts || {};
  const lines = [];
  const log = (l) => { lines.push(l); console.log('🛟 [Odoo safety net]: ' + logsafe.safe(l)); };
  if (!cfg.odooV2()) return { ok: true, result: 'off', log: lines };
  if (!o.tests && !cfg.isProduction()) return { ok: true, result: 'production-only', log: lines };
  if (!odoo.configured()) return { ok: false, result: 'odoo-not-configured', log: lines };
  if (!o.tests && !(await store.set('odoo:daily:' + t.istDay(), 1, { nx: true, ttl: 3 * 86400 }))) return { ok: true, result: 'already-ran-today', log: lines };
  try {
    const tag = await odoo.warmChainTagId();
    const won = await odoo.stageId(ol.STAGES.won);
    if (!tag) { log('Warm-Chain tag not found'); return { ok: false, result: 'no-tag', log: lines }; }
    const domain = [[odoo.SERVICE_FIELD, 'in', [tag]], ['stage_id', '!=', won], ['create_date', '<=', utcString(Date.now() - 3 * 3600 * 1000)],
      o.tests ? ['name', '=like', ol.TEST_PREFIX + '%'] : ['name', 'not like', ol.TEST_PREFIX]];
    const leads = (await odoo.searchRead('crm.lead', domain, ['id', 'name', 'email_from', 'user_id'], { limit: 500 })) || [];
    if (!leads.length) return { ok: true, result: 'done', log: lines };
    const acts = (await odoo.searchRead('mail.activity', [['res_model', '=', 'crm.lead'], ['res_id', 'in', leads.map(l => l.id)]], ['res_id'], { limit: 2000 })) || [];
    const withReminder = new Set(acts.map(a => a.res_id));
    let made = 0;
    for (const lead of leads) {
      if (withReminder.has(lead.id)) continue;
      if (lead.email_from && await store.get('odoowait:' + norm(lead.email_from)).catch(() => null)) { log(`${lead.id}: waiting on the nudges or the reply check`); continue; }
      try {
        await odoo.call('crm.lead', 'activity_schedule', {
          ids: [lead.id], summary: NEXT_STEP, activity_type_id: await odoo.todoTypeId(),
          user_id: (Array.isArray(lead.user_id) ? lead.user_id[0] : lead.user_id) || (await odoo.userId()), date_deadline: t.istDay()
        }, {
          check: async () => ((await odoo.searchRead('mail.activity', [['res_model', '=', 'crm.lead'], ['res_id', '=', lead.id], ['summary', '=', NEXT_STEP]], ['id'])) || []).length ? true : null
        });
        made++;
        log(`${lead.id}: "${NEXT_STEP}" made`);
      } catch (err) {
        log(`${lead.id}: failed (${err.message})`);
        alerts.rateLimited('odoo-safety-net-fail', 24 * 3600, 'An Odoo reminder could not be made',
          `The 8 am safety net could not add "${NEXT_STEP}" to ${lead.name} (Odoo lead ${lead.id}): ${err.message}. Please add a next step by hand.`, { backup: false }).catch(() => {});
      }
    }
    log(`${leads.length} Warm-Chain lead(s) checked, ${made} reminder(s) made`);
    return { ok: true, result: 'done', log: lines };
  } catch (err) {
    log('run failed: ' + err.message);
    if (!o.tests) await store.del('odoo:daily:' + t.istDay()).catch(() => {});
    alerts.rateLimited('odoo-safety-net-fail', 24 * 3600, 'The Odoo 8 am safety net failed',
      `The daily check that every Warm-Chain lead has a next step could not run: ${err.message}.`, { backup: false }).catch(() => {});
    return { ok: false, result: 'failed', log: lines };
  }
}

// opts.tests: only "[TEST] " leads, this environment's event type, the Sandbox, and every step in the returned log
async function run(opts) {
  const o = opts || {};
  const lines = [];
  const log = (l) => { lines.push(l); console.log('📡 [Odoo signals]: ' + logsafe.safe(l)); };

  if (!o.tests && !cfg.isProduction()) return { ok: true, result: 'production-only', log: lines };
  if (!odoo.configured()) return { ok: false, result: 'odoo-not-configured', log: lines };
  // Its own step: it doesn't depend on NEW_TRACKING, and a failure here never stops the signals
  await proposalTodos(o, log).catch(err => log('Proposal Sent to-dos failed: ' + err.message));
  await lostCleanup(o, log).catch(err => log('Lost clean-up failed: ' + err.message));
  await testCleanup(log).catch(err => log('Test clean-up failed: ' + err.message));
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
    // A real (cron) run that reached Odoo is a good run; a test run ("Check Odoo now") never counts, so it can't hide a dead cron job
    if (!o.tests) await store.set('odoo:lastrun', { at: Date.now() });
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

// /api/lead calls this after its reply: no good run for 2 days means one email to Shubhang (brief 6.2).
// "Once" means once per stall: the key carries the time of the last good run, so a new email comes only
// after the job has worked again and then stopped again. Before the first good run ever, the 2 days
// count from the first time this check ran, so going live doesn't send an email before the first cron run.
async function checkHealth() {
  // Checked whether NEW_TRACKING is on or off: the cron job runs either way (with it off, a run only records itself)
  if (!cfg.isProduction() || !odoo.configured()) return;
  let at = await lastGoodRun();
  if (!at) {
    await store.set('odoo:health-since', { at: Date.now() }, { nx: true }).catch(() => {});
    const since = await store.get('odoo:health-since').catch(() => null);
    at = since && since.at;
    if (!at) return;
  }
  if (Date.now() - at < 2 * DAY) return;
  await alerts.send('The Odoo signal job has not run for 2 days',
    'The job that sends QualifiedAfterCall and Purchase to Meta has had no good run in 2 days. Check CRON_SECRET and the cron entry in Vercel, and that the Odoo API key still works.',
    'odoo-nosignal:' + at, { backup: false }).catch(() => {});
}

module.exports = { run, proposalTodos, lostCleanup, testCleanup, dailySafetyNet, NEXT_STEP, PROPOSAL_TODO, buildSignalEvent, lastGoodRun, checkHealth, utcSeconds };
