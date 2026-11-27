// Leads into Odoo (Odoo Brief v1, part 5): the lead from /api/lead, the booking webhook (created, moved, cancelled)
// and the no-times reminder. Never makes a contact, never deletes, never marks won or lost, never adds tags.
const cfg = require('./config');
const logsafe = require('./logsafe');
const t = require('./time');
const store = require('./store');
const alerts = require('./alerts');
const qualify = require('./qualify');
const odoo = require('./odoo');
const cal = require('./cal');
const testbookings = require('./testbookings');

const { esc } = odoo;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let lockPollMs = 500;
let bookWaitMs = 5000;

const TEST_PREFIX = '[TEST] ';
const STAGES = { new: 'New', replied: 'Replied', scheduled: 'Call Scheduled', won: 'Deal Closed' };
const REMINDER = {
  followUp: 'WhatsApp follow-up',
  getBooked: 'Get the call booked',
  evening: 'Personal message the evening before the call'
};
const META_SOURCES = ['fb', 'facebook', 'ig', 'instagram', 'msg', 'messenger', 'an', 'meta'];
const LEAD_FIELDS = ['id', 'name', 'active', 'stage_id', 'date_closed', 'write_date', 'lost_reason_id', 'priority',
  'x_studio_lead_channel', 'email_from', 'email_normalized', 'phone_sanitized', 'user_id'];

const norm = (e) => String(e || '').trim().toLowerCase();

// ---------- small helpers ----------
function odooPhone(raw) {
  const v = String(raw || '').trim();
  const digits = v.replace(/\D/g, '');
  if (!digits) return '';
  if (v.startsWith('+')) return '+' + digits;
  if (digits.length === 10) return '+91' + digits;
  if (digits.length === 12 && digits.startsWith('91')) return '+' + digits;
  return '+' + digits;
}

function isMetaVisit(attrib) {
  const a = attrib || {};
  return !!(a.fbclid || META_SOURCES.includes(norm(a.utm_source)));
}

// "3" both answers fit, "2" one, "1" neither, "0" no form answers (a booking made in Cal.com). Text, not a number.
function stars(q1, q2) {
  if (!q1 && !q2) return '0';
  const n = (qualify.q1Fits(q1) ? 1 : 0) + (qualify.q2Fits(q2) ? 1 : 0);
  return String(n + 1);
}

function leadName(d) {
  const base = d.company ? `${d.company} (${d.name})` : d.name;
  return (d.test ? TEST_PREFIX : '') + base;
}

const ist = (date) => t.describe(date || new Date(), 'Asia/Kolkata');
const dayText = (date) => `${ist(date).dayLong}`;
const timeText = (date) => `${ist(date).dayLong}, ${ist(date).time} IST`;
const dayAfter = (date, n) => t.istDay(new Date(date.getTime() + n * 86400000));

function descriptionHtml(d, newTracking) {
  const a = d.attrib || {};
  const parts = [];
  if (d.q1 || d.q2) {
    const fit = qualify.isQualified(d.q1, d.q2) ? 'yes' : 'no';
    parts.push(`<p>Situation: ${esc(d.q1)}<br>Timeline: ${esc(d.q2)}<br>Good fit: ${fit}</p>`);
  } else {
    parts.push('<p>No form answers (booked in Cal.com)</p>');
  }
  let where = isMetaVisit(a) ? 'Meta ad' : 'Website: no ad click found';
  if (newTracking && isMetaVisit(a)) {
    where += ` — ${esc(a.utm_campaign || '-')} › ${esc(a.utm_term || '-')} › ${esc(a.utm_content || '-')}, angle ${esc(a.angle || '-')}`;
  }
  parts.push(`<p>${where}</p>`);
  if (d.consentAt) parts.push(`<p>Agreed to be contacted: ${esc(timeText(new Date(d.consentAt)))}</p>`);
  return parts.join('');
}

function answersHtml(d) {
  if (!d.q1 && !d.q2) return 'No form answers (booked in Cal.com)';
  return `Situation: ${esc(d.q1)}<br>Timeline: ${esc(d.q2)}<br>Good fit: ${qualify.isQualified(d.q1, d.q2) ? 'yes' : 'no'}`;
}

// ---------- choice fields: the stored value for a label, found from Odoo itself ----------
const choices = new Map();
async function choiceValue(field, label) {
  const key = field + ':' + label;
  if (choices.has(key)) return choices.get(key);
  let value = label;
  try {
    const info = await odoo.call('crm.lead', 'fields_get', { allfields: [field], attributes: ['selection'] });
    const sel = (info && info[field] && info[field].selection) || [];
    const hit = sel.find(s => s[1] === label || s[0] === label);
    if (hit) value = hit[0];
  } catch (e) { /* use the label itself */ }
  choices.set(key, value);
  return value;
}
const metaChannel = () => choiceValue('x_studio_lead_channel', 'Meta Ads');
const inboundType = () => choiceValue('x_studio_lead_type', 'Inbound');

// ---------- the store lock (per lead_event_id and per email) ----------
async function withLock(key, fn) {
  const lockKey = 'odoolock:' + key;
  const start = Date.now();
  let owned = false;
  for (;;) {
    owned = await store.set(lockKey, 1, { nx: true, ttl: 60 });
    if (owned || Date.now() - start > 60000) break; // waits up to 60 seconds, then runs
    await sleep(lockPollMs);
  }
  try { return await fn(); } finally { if (owned) await store.del(lockKey).catch(() => {}); }
}

// ---------- finding the person's lead (5.3) ----------
async function findLeads(email, phone, test) {
  const wonId = await odoo.stageId(STAGES.won);
  const scope = test ? [['name', '=like', TEST_PREFIX + '%']] : [['name', 'not like', TEST_PREFIX]];
  const ctx = { context: { active_test: false }, order: 'id desc' };
  let fillEmail = false;
  let rows = email ? await odoo.searchRead('crm.lead', [['email_normalized', '=', norm(email)], ...scope], LEAD_FIELDS, ctx) : [];
  if (!rows.length && phone) {
    rows = await odoo.searchRead('crm.lead', [['phone_sanitized', '=', phone], ['email_normalized', '=', false], ...scope], LEAD_FIELDS, ctx);
    fillEmail = rows.length > 0;
  }
  const stageOf = (l) => (Array.isArray(l.stage_id) ? l.stage_id[0] : l.stage_id);
  const open = rows.filter(l => l.active && stageOf(l) !== wonId);
  const lost = rows.filter(l => !l.active);
  const won = rows.filter(l => l.active && stageOf(l) === wonId);
  lost.sort((a, b) => String(b.date_closed || b.write_date || '').localeCompare(String(a.date_closed || a.write_date || '')));
  return { open: open[0] || null, lost, won, fillEmail, stageOf, wonId };
}

// ======================================================================================================
// ODOO_V2 (Notion "Odoo 1" to "Odoo 4"). Used only when cfg.odooV2() is on; with it off nothing below runs.
// ======================================================================================================
const v2 = () => cfg.odooV2();
const tidy = (s) => String(s || '').replace(/\s+/g, ' ').trim(); // extra spaces only: never re-capitalised
const LEAD_FIELDS_V2 = LEAD_FIELDS.concat(['partner_id', 'expected_revenue', 'recurring_revenue', odoo.SERVICE_FIELD]);
const REVENUE = 99000;

// "Odoo 2": "{Company} – Warm-Chain System" ("{Person} – …" with no company); test leads keep "[TEST] "
function leadNameV2(d) {
  return (d.test ? TEST_PREFIX : '') + (tidy(d.company) || tidy(d.name)) + ' – ' + odoo.WARM_CHAIN;
}
const titleFor = (d) => (v2() ? leadNameV2(d) : leadName(d));

// Test Contacts carry "[TEST] " too, so a test never finds or changes a real Contact (and the clean-up finds them)
const contactScope = (test) => (test ? [['name', '=like', TEST_PREFIX + '%']] : [['name', 'not like', TEST_PREFIX]]);
const likeEscape = (s) => s.replace(/[\\%_]/g, m => '\\' + m);
const m2oId = (v) => (Array.isArray(v) ? v[0] : v) || null;

// Company: the same name, ignoring capitals and extra spaces. The search lets any spacing through; the exact
// comparison is done here.
async function findCompany(name, test) {
  const want = tidy(name).toLowerCase();
  const pattern = likeEscape(tidy(name)).split(' ').join('%');
  const rows = await odoo.searchRead('res.partner', [['is_company', '=', true], ['name', '=ilike', (test ? TEST_PREFIX : '') + pattern], ...contactScope(test)],
    ['id', 'name'], { order: 'id asc', limit: 200 });
  const hit = (rows || []).find(r => tidy(String(r.name).replace(test ? TEST_PREFIX : '', '')).toLowerCase() === want);
  return hit ? hit.id : null;
}

// Person: by email (lowercase), then by phone (+91 format). The first (oldest) match is reused.
async function findPerson(email, phone, test) {
  const fields = ['id', 'email', 'phone', 'parent_id'];
  const base = [['is_company', '=', false], ...contactScope(test)];
  const ctx = { order: 'id asc', limit: 1 };
  if (email) {
    const r = await odoo.searchRead('res.partner', [['email_normalized', '=', norm(email)], ...base], fields, ctx);
    if (r && r[0]) return r[0];
  }
  if (phone) {
    const r = await odoo.searchRead('res.partner', [['phone_sanitized', '=', phone], ...base], fields, ctx);
    if (r && r[0]) return r[0];
  }
  return null;
}

// "Odoo 1": the company is the main Contact, the person its point of contact (a person alone when no company was
// typed). Looked up first, only what's missing is made. A saved detail is never overwritten (a blank is only filled).
// Returns the person's id (the lead's Contact).
async function ensureContacts(d) {
  const test = !!d.test;
  const prefix = test ? TEST_PREFIX : '';
  const email = norm(d.email);
  const phone = odooPhone(d.phone);
  const company = tidy(d.company);
  let companyId = null;
  if (company) {
    // One lock per company name: two people from the same company at once still make one company Contact
    companyId = await withLock('company:' + (test ? 't:' : '') + company.toLowerCase(), async () =>
      (await findCompany(company, test)) || odoo.create('res.partner', { name: prefix + company, is_company: true }, ['name', 'is_company']));
  }
  const person = await findPerson(email, phone, test);
  if (person) {
    const fill = {};
    if (!person.email && email) fill.email = email;
    if (!person.phone && phone) fill.phone = phone;
    if (!m2oId(person.parent_id) && companyId) fill.parent_id = companyId;
    if (Object.keys(fill).length) await odoo.write('res.partner', [person.id], fill);
    return person.id;
  }
  const vals = { name: prefix + (tidy(d.name) || email), is_company: false, email: email || false, phone: phone || false };
  if (companyId) vals.parent_id = companyId;
  return odoo.create('res.partner', vals, ['name', 'email']);
}

// The tag, the Contact (when the lead has none) and nothing else, on a lead we use. A Contact that fails never
// fails the lead: it's logged and the lead goes on without it.
async function adoptVals(lead, d) {
  const vals = {};
  const tag = await odoo.warmChainTagId();
  if (!tag) tagMissing();
  else if (!odoo.tagIdsOf(lead).includes(tag)) vals[odoo.SERVICE_FIELD] = [[4, tag]];
  if (!m2oId(lead.partner_id)) {
    try { vals.partner_id = await ensureContacts(d); } catch (err) { console.warn('⚠️ [Odoo Contact]:', logsafe.safe(err.message)); }
  }
  return vals;
}

async function adoptLead(lead, d) {
  const vals = await adoptVals(lead, d);
  if (Object.keys(vals).length) await odoo.write('crm.lead', [lead.id], vals);
  if (vals[odoo.SERVICE_FIELD]) lead[odoo.SERVICE_FIELD] = odoo.tagIdsOf(lead).concat([await odoo.warmChainTagId()]);
  if (vals.partner_id) lead.partner_id = vals.partner_id;
}

function tagMissing() {
  console.error('❌ [Odoo]: the "Warm-Chain System" tag was not found');
  alerts.rateLimited('odoo-tag-missing', 24 * 3600, 'The Warm-Chain System tag is missing in Odoo',
    'The website could not find the "Warm-Chain System" tag (Service Interested In) in Odoo, so new leads go in without it. Please check the tag still exists with exactly that name.', { backup: false }).catch(() => {});
}

// "Odoo 1": which lead to use, matched by the person's email, else by phone. Open beats Lost. Among open leads: a
// Warm-Chain one, then one with no service, then the newest. A lead for another service is never used (a separate
// Warm-Chain lead is made for the same Contact). A Lost lead with no service or Warm-Chain is reopened.
async function findLeadsV2(email, phone, test) {
  const wonId = await odoo.stageId(STAGES.won);
  const tag = await odoo.warmChainTagId();
  const scope = test ? [['name', '=like', TEST_PREFIX + '%']] : [['name', 'not like', TEST_PREFIX]];
  const ctx = { context: { active_test: false }, order: 'id desc' };
  let byPhone = false;
  let rows = email ? await odoo.searchRead('crm.lead', [['email_normalized', '=', norm(email)], ...scope], LEAD_FIELDS_V2, ctx) : [];
  if (!rows.length && phone) {
    rows = await odoo.searchRead('crm.lead', [['phone_sanitized', '=', phone], ...scope], LEAD_FIELDS_V2, ctx);
    byPhone = rows.length > 0;
  }
  const stageOf = (l) => (Array.isArray(l.stage_id) ? l.stage_id[0] : l.stage_id);
  const tags = (l) => odoo.tagIdsOf(l);
  const warm = (l) => !!tag && tags(l).includes(tag);
  const usable = (l) => warm(l) || tags(l).length === 0;
  const open = rows.filter(l => l.active && stageOf(l) !== wonId && usable(l));
  open.sort((a, b) => (warm(b) - warm(a)) || (b.id - a.id));
  const lost = rows.filter(l => !l.active && usable(l));
  lost.sort((a, b) => String(b.date_closed || b.write_date || '').localeCompare(String(a.date_closed || a.write_date || '')));
  const won = rows.filter(l => l.active && stageOf(l) === wonId);
  const chosen = open[0] || lost[0] || null;
  // Found by phone with no email on it: add the one they gave us (a saved email is never replaced)
  const fillEmail = byPhone && !!chosen && !chosen.email_from;
  return { open: open[0] || null, lost, won, fillEmail, stageOf, wonId };
}
const find = (email, phone, test) => (v2() ? findLeadsV2(email, phone, test) : findLeads(email, phone, test));

// "Odoo 4": on booking, Expected Revenue and Recurring Revenues (MRR) ₹99,000, plan Monthly. Each only while it is
// still 0 (Shubhang, 22 Nov): an amount he already put in is never overwritten.
async function revenueVals(lead) {
  const vals = {};
  if (!(Number(lead.expected_revenue) > 0)) vals.expected_revenue = REVENUE;
  if (!(Number(lead.recurring_revenue) > 0)) {
    vals.recurring_revenue = REVENUE;
    const plan = await odoo.recurringPlanId('Monthly');
    if (plan) vals.recurring_plan = plan;
  }
  return vals;
}

// ---------- ODOO_V2 notes and reminders ("Odoo 5", "Odoo 6", "Odoo 8" to "Odoo 11") ----------
// Our reminders (exact titles, also in odoo.OUR_REMINDERS). Their types match the ones already used on live leads.
const R = {
  followUp: 'WhatsApp: follow up (didn\'t book)',
  evening: 'WhatsApp: personal message (evening before the call)',
  callDay: 'WhatsApp: call-day reminder',
  after: 'After the call: update the stage',
  rebook: 'WhatsApp: get the call rebooked'
};
const R_TYPES = { [R.evening]: 'Meeting', [R.callDay]: 'WhatsApp Message', [R.after]: 'To-Do', [R.rebook]: 'WhatsApp Message', [R.followUp]: 'WhatsApp Message' };
const FOLLOW_UPS = [R.followUp, REMINDER.followUp, REMINDER.getBooked]; // new and old titles
const CALL_REMINDERS = [R.evening, R.callDay, R.after, REMINDER.evening];
const actTypeId = (name) => odoo.cached('acttype:' + name, () => odoo.firstId('mail.activity.type', [['name', '=', name]]));

// "Fri 27 Nov, 3:35 pm" (IST), as in every note
const shortWhen = (date) => { const x = ist(date); return `${x.dayShort}, ${x.time}`; };
const htmlLines = (lines) => lines.filter(l => l != null && l !== '').map(esc).join('<br>');

// "Odoo 6": "Source: Meta ad IMG9 (TG1-CP2-A4), ad set TC1.4, campaign TC1.0[, angle: x]" from the ad names, or
// "Source: Website (no ad click)". The "[L:…]" tags are dropped. Ad names only while NEW_TRACKING is on (as before).
function sourceLine(attrib, metaLead) {
  const a = attrib || {};
  const meta = isMetaVisit(a) || !!a.utm_content || !!metaLead;
  if (!meta) return 'Source: Website (no ad click)';
  if (!cfg.newTracking()) return 'Source: Meta ad';
  const strip = (s) => String(s || '').replace(/\[L:[^\]]*\]/g, '').trim();
  const firstPart = (s) => strip(s).split('|')[0].trim();
  const parts = strip(a.utm_content).split('|').map(x => x.trim()).filter(Boolean);
  let s = 'Source: Meta ad';
  if (parts.length >= 3) s += ` ${parts[1]} (${parts[2]})`;
  else if (parts.length) s += ' ' + parts.join(' ');
  const adSet = a.utm_term ? firstPart(a.utm_term) : (parts[0] ? parts[0].replace(/\.\d+$/, '') : '');
  if (adSet) s += `, ad set ${adSet}`;
  const campaign = firstPart(a.utm_campaign);
  if (campaign) s += `, campaign ${campaign}`;
  const angle = String(a.angle || '').trim();
  if (angle) s += `, angle: ${angle}`;
  return s;
}

// Situation / Timeline in the words the person saw on screen, then Fit, Source and Consent
function detailLines(d, metaLead) {
  const lines = [];
  if (d.q1 || d.q2) {
    lines.push(`Situation: ${qualify.shownAnswer(d.q1)}`, `Timeline: ${qualify.shownAnswer(d.q2)}`, `Fit: ${qualify.isQualified(d.q1, d.q2) ? 'Good' : 'Not a fit'}`);
  }
  lines.push(sourceLine(d.attrib, metaLead));
  if (d.consentAt && Number.isFinite(new Date(d.consentAt).getTime())) lines.push(`Consent: ${shortWhen(new Date(d.consentAt))}`);
  return lines;
}

const isMetaLead = async (lead) => !!lead.x_studio_lead_channel && lead.x_studio_lead_channel === await metaChannel();
const ownerOf = async (lead) => m2oId(lead.user_id) || (await odoo.userId());

// One reminder per title: an open one moves to the new date (and note); otherwise one is made. A retry first
// checks it isn't already there. Never marked Done.
// Its "SMS/Call: " twin counts as the same reminder (moved, never doubled). A new one is made as "SMS/Call: " when the
// lead already has an open "SMS/Call: " reminder (not on WhatsApp).
async function upsertReminder(lead, w) {
  const open = await odoo.searchRead('mail.activity', [['res_model', '=', 'crm.lead'], ['res_id', '=', lead.id], ['summary', 'in', odoo.withTwins([w.title])]], ['id', 'date_deadline']);
  const noteHtml = w.note ? `<p>${esc(w.note)}</p>` : '';
  if (open && open.length) {
    const vals = { date_deadline: w.day };
    if (noteHtml) vals.note = noteHtml;
    await odoo.write('mail.activity', open.map(x => x.id), vals);
    return 'moved';
  }
  const title = odoo.smsTwin(w.title) && await isSmsLead(lead.id) ? odoo.smsTwin(w.title) : w.title;
  const args = { ids: [lead.id], summary: title, activity_type_id: await actTypeId(R_TYPES[odoo.baseTitle(title)] || 'To-Do'), user_id: await ownerOf(lead), date_deadline: w.day };
  if (noteHtml) args.note = noteHtml;
  await odoo.call('crm.lead', 'activity_schedule', args, {
    check: async () => {
      const rows = await odoo.searchRead('mail.activity', [['res_model', '=', 'crm.lead'], ['res_id', '=', lead.id], ['summary', '=', title], ['date_deadline', '=', w.day]], ['id']);
      return rows && rows.length ? true : null;
    }
  });
  return 'made';
}

// Not on WhatsApp: the lead has an open "SMS/Call: " reminder
async function isSmsLead(leadId) {
  const rows = await odoo.searchRead('mail.activity', [['res_model', '=', 'crm.lead'], ['res_id', '=', leadId], ['summary', '=like', 'SMS/Call: %']], ['id'], { limit: 1 });
  return !!(rows && rows.length);
}

// "Odoo 8": the 3 call reminders. Reminder 1 is skipped when booked after 8 pm the night before or on the call day;
// booked on the call day, reminder 2 says "as soon as you see this". The old-style evening reminder is replaced.
async function ensureCallReminders(lead, start, now) {
  const callDay = t.istDay(start);
  const prev = dayAfter(start, -1);
  const today = t.istDay(now);
  const hour = t.zoneParts(now, 'Asia/Kolkata').hour;
  const skipFirst = today >= callDay || (today === prev && hour >= 20);
  await odoo.removeOurReminders(lead.id, skipFirst ? [REMINDER.evening, R.evening] : [REMINDER.evening]);
  if (!skipFirst) await upsertReminder(lead, { title: R.evening, day: prev, note: 'Send around 7–8 pm. Confirm the time and share the Meet link.' });
  await upsertReminder(lead, {
    title: R.callDay, day: callDay,
    note: today === callDay ? 'Send as soon as you see this. Remind them of today\'s call time.' : 'Send in the morning. Remind them of today\'s call time.'
  });
  await upsertReminder(lead, { title: R.after, day: callDay, note: 'Held: Qualified, or Lost (Junk). Missed: back to Replied. Never rebooks: Lost (No-show).' });
}

// Booked: a follow-up reminder is no longer needed (removed, never Done), with one note; a rebook reminder just goes
async function clearFollowUps(leadId) {
  const n = await odoo.removeOurReminders(leadId, FOLLOW_UPS);
  // "Odoo 7": they booked after the "didn't book" note (nudges going, or a follow-up reminder): one note
  const afterDidntBook = await store.get('odoodb:' + leadId).catch(() => null);
  if (n || afterDidntBook) await odoo.note(leadId, esc('Booked a call: no WhatsApp follow-up needed'));
  if (afterDidntBook) await store.del('odoodb:' + leadId).catch(() => {});
  await odoo.removeOurReminders(leadId, [R.rebook]);
}

// "Odoo 6": an email Gmail accepted goes into the lead's log: "Email sent: {subject}", a blank line, the full text.
// Only Warm-Chain leads; once per email (a mark in the store); never before it went. A failure here never touches
// the email itself. Returns what happened.
async function logEmail(e) {
  if (!v2() || !odoo.configured()) return 'off';
  const mark = 'odoolog:' + e.key;
  if (!(await store.set(mark, 1, { nx: true, ttl: 90 * 86400 }))) return 'duplicate';
  try {
    let leadId = e.leadId;
    if (!leadId) {
      const cls = await findLeadsV2(e.email, '', !!e.test);
      const tag = await odoo.warmChainTagId();
      const lead = cls.open && tag && odoo.tagIdsOf(cls.open).includes(tag) ? cls.open : null;
      if (!lead) { await store.del(mark); return 'no-lead'; } // a booking's lead may come right after: logged then
      leadId = lead.id;
    }
    await odoo.note(leadId, `${esc('Email sent: ' + e.subject)}<br><br>${esc(e.text).replace(/\n/g, '<br>')}`);
    return 'logged';
  } catch (err) {
    await store.del(mark).catch(() => {});
    console.warn('⚠️ [Odoo email log]:', logsafe.safe(err.message));
    return 'failed';
  }
}

// One of our emails bounced (Notion URGENT, 26 Nov): one note on their open Warm-Chain lead and a WhatsApp reminder
// today (no copy), so Shubhang asks for the right email. Once per address (the caller's mark); no lead: nothing here.
async function onBounceV2(e) {
  if (!v2() || !odoo.configured()) return 'off';
  const cls = await findLeadsV2(e.email, '', !!e.test);
  const tag = await odoo.warmChainTagId();
  const lead = cls.open && tag && odoo.tagIdsOf(cls.open).includes(tag) ? cls.open : null;
  if (!lead) return 'no-lead';
  await odoo.note(lead.id, esc(`Email bounced: our ${e.what} email to ${e.email} couldn't be delivered. No more emails go to this address. WhatsApp them and ask for the right email.`));
  await reminderTodayOnce(lead, R4.bounced, '');
  return 'noted';
}

// The booking email can go before a brand-new booking's lead exists: log it once the lead is there
async function logBookingEmailIfSent(uid, leadId) {
  const rec = await store.get('booking:' + uid).catch(() => null);
  if (rec && rec.first && rec.first.sentAt && rec.first.text) {
    await logEmail({ key: 'first:' + uid, leadId, subject: rec.first.subject, text: rec.first.text });
  }
}

async function bookingLeadV2(cls, d, now) {
  let lead = cls.open;
  if (lead) {
    await fillEmailIfFoundByPhone(cls, lead.id, d);
    await adoptLead(lead, d);
    return lead;
  }
  if (cls.lost.length) {
    const id = await reopen(cls.lost[0], d, now, cls.fillEmail);
    return Object.assign({}, cls.lost[0], { id, active: true, stage_id: await odoo.stageId(STAGES.new) });
  }
  const id = await createLead(d, { pastClient: cls.won.length > 0 });
  return (await odoo.searchRead('crm.lead', [['id', '=', id]], LEAD_FIELDS_V2, { context: { active_test: false } }))[0];
}

// "Odoo 8": a booked call
async function onCreatedV2(p, d, now) {
  let cls = await withLock('email:' + norm(d.email), () => resolveForBooking(d, d.test));
  if (!cls.open) await sleep(bookWaitMs); // the lead's own call may still be on its way
  return withLock('email:' + norm(d.email), async () => {
    cls = await resolveForBooking(d, d.test);
    const lead = await bookingLeadV2(cls, d, now);
    lead.stageOf = cls.stageOf;
    const start = new Date(p.startTime);
    const { moved } = await applyScheduled(lead, p, d, now);
    const first = await pastClientPrefix(lead.id);
    await odoo.note(lead.id, htmlLines(first.concat([`Call booked: ${shortWhen(start)}`]).concat(detailLines(d, await isMetaLead(lead)))));
    await keepUid(lead.id, p, d);
    await clearFollowUps(lead.id);
    await ensureCallReminders(lead, start, now);
    await logBookingEmailIfSent(p.uid, lead.id);
    return moved ? 'scheduled' : 'scheduled-no-move';
  });
}

// "Odoo 9": a moved call. One note; the 3 reminders follow the new time (open ones move, a Done one is made again).
async function onRescheduledV2(p, d, now) {
  return withLock('email:' + norm(d.email), async () => {
    const cls = await resolveForBooking(d, d.test);
    const newStart = new Date(p.startTime);
    const oldUid = p.rescheduleUid || p.fromReschedule || '';
    const oldRec = oldUid ? await store.get('booking:' + oldUid).catch(() => null) : null;
    const oldIso = p.rescheduleStartTime || (oldRec && oldRec.startISO) || '';
    const oldStart = oldIso && Number.isFinite(new Date(oldIso).getTime()) ? new Date(oldIso) : null;
    const line = oldStart ? `Call moved: ${shortWhen(oldStart)} → ${shortWhen(newStart)}` : `Call moved to ${shortWhen(newStart)}`;
    if (!cls.open && !cls.lost.length && cls.won.length) {
      await odoo.note(cls.won[0].id, esc(line));
      return 'won-note-only';
    }
    if (!cls.open && !cls.lost.length) { console.log('ℹ️ [Odoo]: reschedule webhook with no lead found'); return 'no-lead'; }
    const lead = await bookingLeadV2(cls, d, now);
    lead.stageOf = cls.stageOf;
    await odoo.note(lead.id, esc(line));
    await keepUid(lead.id, p, d);
    const stageId = lead.stageOf(lead);
    const early = stageId === await odoo.stageId(STAGES.new) || stageId === await odoo.stageId(STAGES.replied);
    if (early) {
      await applyScheduled(lead, p, d, now);
      await clearFollowUps(lead.id);
    }
    await ensureCallReminders(lead, newStart, now);
    return 'moved';
  });
}

// Who cancelled, for the note. Cal.com often leaves "cancelled by" blank, even when Shubhang cancels from Cal.com
// (27 Nov: all 12 recent cancellations blank), so blank is "not recorded", never a guess.
function cancelledBy(auto, by, host, attendee) {
  if (auto) return 'you'; // our own test-booking cancel
  if (!by) return 'not recorded by Cal.com';
  if (host && by === host) return 'you';
  if (by === norm(attendee)) return 'them';
  return host ? 'them' : 'not recorded by Cal.com';
}

// "Odoo 11": a cancelled call. One note (who, and the reason if given); the call reminders removed (never Done);
// back to Replied if it was Call Scheduled; a rebook reminder for an open Warm-Chain lead. Revenue stays.
async function onCancelledV2(p, d, now) {
  return withLock('email:' + norm(d.email), async () => {
    const cls = await resolveForBooking(d, d.test);
    const lead = cls.open || cls.lost[0] || cls.won[0];
    if (!lead) { console.log('ℹ️ [Odoo]: cancel webhook with no lead found'); return 'no-lead'; }
    const by = norm(p.cancelledBy || '');
    const host = norm(p.organizer && p.organizer.email);
    const auto = await testbookings.wasAutoCancelled(p.uid); // a test booking we cancelled after 1 hour
    const reason = String(p.cancellationReason || '').trim();
    const who = cancelledBy(auto, by, host, d.email);
    await odoo.note(lead.id, htmlLines([
      `Call cancelled: ${shortWhen(new Date(p.startTime))}`,
      `Cancelled by: ${who}`,
      reason ? `Reason: ${reason}` : ''
    ]));
    await odoo.removeOurReminders(lead.id, CALL_REMINDERS);
    if (!cls.open) return 'note-only';
    if (cls.stageOf(lead) === await odoo.stageId(STAGES.scheduled)) {
      await odoo.write('crm.lead', [lead.id], { stage_id: await odoo.stageId(STAGES.replied) });
    }
    const tag = await odoo.warmChainTagId();
    if (!auto && tag && odoo.tagIdsOf(lead).includes(tag)) {
      const open = await odoo.searchRead('mail.activity', [['res_model', '=', 'crm.lead'], ['res_id', '=', lead.id], ['summary', 'in', odoo.withTwins([R.rebook])]], ['id']);
      if (!(open || []).length) {
        await odoo.removeOurReminders(lead.id, [REMINDER.getBooked]);
        const hour = t.zoneParts(now, 'Asia/Kolkata').hour;
        await upsertReminder(lead, { title: R.rebook, day: hour >= 19 ? dayAfter(now, 1) : t.istDay(now), note: (who === 'them' ? 'They cancelled the call.' : 'The call was cancelled.') + ' WhatsApp them to book a new time.' });
      }
    }
    return 'cancelled';
  });
}

// ---------- ODOO_V2 step 4 ("Odoo 7", "Odoo 13", "Odoo 14", "Odoo 15") ----------
const R4 = {
  checkAgain: 'Check why they filled the form again',
  cameBack: 'Came back: read the history first',
  pastClient: 'Past client is back: check what they need',
  openTimes: 'WhatsApp: share open times (the booking form didn\'t load)',
  replyEmail: 'Reply to their email',
  bounced: 'WhatsApp: email bounced, ask for the right email'
};
Object.assign(R_TYPES, { [R4.checkAgain]: 'To-Do', [R4.cameBack]: 'To-Do', [R4.pastClient]: 'To-Do', [R4.openTimes]: 'WhatsApp Message', [R4.replyEmail]: 'Email', [R4.bounced]: 'WhatsApp Message' });
const VISIT_TTL = 2 * 86400;

// The form's details (the /api/lead record or the nudge's copy) in the shape the notes use
function formDetails(lead, test) {
  const l = lead || {};
  return {
    name: l.name, company: l.company, email: l.email, phone: l.whatsapp_number, q1: l.q1_situation, q2: l.q2_urgency,
    attrib: l.sv_attrib || {}, consentAt: l.consent_at || '', test: test == null ? cfg.isTest(l.email) : !!test
  };
}

// What this visit was, kept for the later "didn't book" step: new, again (an open Warm-Chain lead), again-booked
// (a call is already booked), cameback (a Lost lead reopened), pastclient (a new lead for a past client)
async function saveVisit(leadEventId, v) {
  if (leadEventId) await store.set('odoovisit:' + leadEventId, v, { ttl: VISIT_TTL }).catch(() => {});
}
async function visitOf(leadEventId, waitMs) {
  const until = Date.now() + (waitMs || 0);
  for (;;) {
    const v = leadEventId ? await store.get('odoovisit:' + leadEventId).catch(() => null) : null;
    if (v || Date.now() >= until) return v;
    await sleep(Math.min(1000, Math.max(5, lockPollMs)));
  }
}

const odooDate = (s) => { const ms = Date.parse(String(s || '').replace(' ', 'T') + (String(s || '').endsWith('Z') ? '' : 'Z')); return Number.isFinite(ms) ? new Date(ms) : null; };

// A reminder due today, only if none with that title is open ("no duplicate")
async function reminderTodayOnce(lead, title, note) {
  const open = await odoo.searchRead('mail.activity', [['res_model', '=', 'crm.lead'], ['res_id', '=', lead.id], ['summary', 'in', odoo.withTwins([title])]], ['id']);
  if ((open || []).length) return 'already-open';
  return upsertReminder(lead, { title, day: t.istDay(new Date()), note });
}

// The "Past client" line opens the first note of a past client's new lead
async function pastClientPrefix(leadId) {
  const key = 'odoopast:' + leadId;
  if (!(await store.get(key).catch(() => null))) return [];
  await store.del(key).catch(() => {});
  return ['Past client'];
}

// "Odoo 13" C: is a call already booked for this person? Cal.com first; if it can't be asked, the lead's own record.
async function upcomingCall(email, lead) {
  try {
    if (cal.configured()) {
      const now = Date.now();
      const list = (await cal.bookingsForEmail(email)).filter(b => b.start > now && b.status !== 'cancelled' && b.status !== 'rejected');
      list.sort((a, b) => a.start - b.start);
      return list[0] ? new Date(list[0].start) : null;
    }
  } catch (e) { /* fall back below */ }
  if (lead.stageOf && lead.stageOf(lead) !== await odoo.stageId(STAGES.scheduled)) return null;
  const kept = await store.get('odoouid:' + lead.id).catch(() => null);
  const rec = kept && kept.uid ? await store.get('booking:' + kept.uid).catch(() => null) : null;
  return rec && !rec.movedTo && new Date(rec.startISO).getTime() > Date.now() ? new Date(rec.startISO) : null;
}

// "Odoo 13": the same person fills the form again while their Warm-Chain lead is open. No note now (A: booking gives
// the "Call booked" note; B: "didn't book" gives its own). C: a call is already booked: a note and a to-do now.
async function onFilledAgainV2(lead, d, cls) {
  lead.stageOf = cls.stageOf;
  const callAt = await upcomingCall(d.email, lead);
  if (!callAt) return { kind: 'again' };
  await odoo.note(lead.id, htmlLines([`Filled the form again (call already booked: ${shortWhen(callAt)})`].concat(detailLines(Object.assign({}, d, { consentAt: '' }), await isMetaLead(lead)))));
  await reminderTodayOnce(lead, R4.checkAgain, '');
  return { kind: 'again-booked' };
}

// "Odoo 14" A: the note when a Lost Warm-Chain lead comes back, and its reminder (also when they book)
async function cameBackV2(lost, d, reason) {
  const lostOn = odooDate(lost.date_closed || lost.write_date);
  const head = `Came back (was Lost: ${reason}${lostOn ? `, on ${ist(lostOn).dayShort}` : ''})`;
  await odoo.note(lost.id, htmlLines([head].concat(detailLines(Object.assign({}, d, { consentAt: '' }), await isMetaLead(lost)))));
  await reminderTodayOnce(lost, R4.cameBack, '');
}

// "Odoo 14" B: a new lead for a past client: its first note opens with "Past client", and a to-do today
async function pastClientV2(leadId) {
  await store.set('odoopast:' + leadId, 1, { ttl: 30 * 86400 }).catch(() => {});
  await reminderTodayOnce({ id: leadId, user_id: null }, R4.pastClient, '');
}

// The person's open Warm-Chain lead (for the steps that come after the form)
async function warmLeadFor(d, leadId) {
  if (leadId) {
    const rows = await odoo.searchRead('crm.lead', [['id', '=', leadId]], LEAD_FIELDS_V2, { context: { active_test: false } });
    if (rows && rows[0] && rows[0].active) return rows[0];
  }
  const cls = await findLeadsV2(d.email, odooPhone(d.phone), d.test);
  const tag = await odoo.warmChainTagId();
  return cls.open && tag && odoo.tagIdsOf(cls.open).includes(tag) ? cls.open : null;
}

// "Odoo 7" (and "Odoo 13" B): they left without booking (or 2 hours passed with no booking).
// opts: { again, nudges } — again: a returning lead; nudges: the nudge pair started for them.
async function onDidntBookV2(formLead, leadEventId, opts) {
  if (!v2() || !odoo.configured()) return 'off';
  const o = opts || {};
  const d = formDetails(formLead, o.test);
  try {
    const visit = await visitOf(leadEventId, bookWaitMs);
    return await withLock('email:' + norm(d.email), async () => {
      const lead = await warmLeadFor(d, visit && visit.leadId);
      if (!lead) return 'no-lead';
      const metaLead = await isMetaLead(lead);
      if (o.again) {
        await odoo.note(lead.id, htmlLines(['Filled the form again, didn\'t book'].concat(detailLines(Object.assign({}, d, { consentAt: '' }), metaLead))));
        await upsertReminder(lead, { title: R.followUp, day: t.istDay(new Date()), note: 'Filled the form again but didn\'t book. WhatsApp them to get the call booked.' });
        return 'again';
      }
      const first = await pastClientPrefix(lead.id);
      await odoo.note(lead.id, htmlLines(first.concat(['Filled the form, didn\'t book']).concat(detailLines(d, metaLead))));
      // Booking later says "Booked a call: no WhatsApp follow-up needed" once
      await store.set('odoodb:' + lead.id, 1, { ttl: 14 * 86400 }).catch(() => {});
      if (!o.nudges) {
        await upsertReminder(lead, { title: R.followUp, day: t.istDay(new Date()), note: 'No nudge emails went to them. WhatsApp them to get the call booked.' });
        return 'reminder';
      }
      return 'nudges';
    });
  } catch (err) {
    console.error('❌ [Odoo didn\'t book]:', logsafe.safe(err.message));
    await failureAlert(d, err);
    return 'failed';
  }
}

// "Odoo 7", after the nudges: the day after nudge 2 (no booking, no reply), or a reply to a nudge
async function afterNudgesV2(formLead, what) {
  if (!v2() || !odoo.configured()) return 'off';
  const d = formDetails(formLead);
  return withLock('email:' + norm(d.email), async () => {
    const lead = await warmLeadFor(d);
    if (!lead) return 'no-lead';
    if (what === 'no-reply') {
      await upsertReminder(lead, { title: R.followUp, day: t.istDay(new Date()), note: 'Both nudge emails went, no booking and no reply. WhatsApp them to get the call booked.' });
      return 'reminder';
    }
    if (what === 'replied') {
      // The note says no follow-up is needed, so our open follow-up reminder goes too (removed, never Done; 25 Nov)
      await odoo.removeOurReminders(lead.id, [R.followUp]);
      await odoo.note(lead.id, esc('Replied to the nudge email: no WhatsApp follow-up needed'));
      await store.del('odoodb:' + lead.id).catch(() => {});
      return 'noted';
    }
    if (what === 'reply-due') {
      await reminderTodayOnce(lead, R4.replyEmail, '');
      return 'reminder';
    }
    return 'unknown';
  });
}

// "Odoo 15" B: the booking form couldn't show any open times. One note, one reminder today (no copy).
async function onNoTimesV2(formLead, test) {
  if (!v2() || !odoo.configured()) return 'off';
  const d = formDetails(formLead, test);
  try {
    let lead = await withLock('email:' + norm(d.email), () => warmLeadFor(d));
    if (!lead) { await sleep(bookWaitMs); lead = await withLock('email:' + norm(d.email), () => warmLeadFor(d)); }
    if (!lead) return 'no-lead';
    return await withLock('email:' + norm(d.email), async () => {
      await odoo.note(lead.id, htmlLines(['Couldn\'t see open times on the booking form'].concat(detailLines(Object.assign({}, d, { consentAt: '' }), await isMetaLead(lead)))));
      await reminderTodayOnce(lead, R4.openTimes, '');
      return 'noted';
    });
  } catch (err) {
    console.error('❌ [Odoo no-times]:', logsafe.safe(err.message));
    return 'failed';
  }
}

// "Odoo 15" A: Back with changed details: no note; the lead's Contact takes the latest details (never a blank)
async function updateContactAfterBack(leadId, d) {
  const rows = await odoo.searchRead('crm.lead', [['id', '=', leadId]], ['id', 'partner_id'], { context: { active_test: false } });
  const personId = rows && rows[0] && m2oId(rows[0].partner_id);
  if (!personId) return;
  const prefix = d.test ? TEST_PREFIX : '';
  const vals = {};
  if (tidy(d.name)) vals.name = prefix + tidy(d.name);
  if (norm(d.email)) vals.email = norm(d.email);
  if (odooPhone(d.phone)) vals.phone = odooPhone(d.phone);
  if (tidy(d.company)) {
    const company = tidy(d.company);
    vals.parent_id = await withLock('company:' + (d.test ? 't:' : '') + company.toLowerCase(), async () =>
      (await findCompany(company, d.test)) || odoo.create('res.partner', { name: prefix + company, is_company: true }, ['name', 'is_company']));
  }
  if (Object.keys(vals).length) await odoo.write('res.partner', [personId], vals);
}

// ---------- making and reopening leads ----------
async function campaignId(title) {
  return withLock('campaign:' + title, async () => {
    const id = await odoo.firstId('utm.campaign', [['title', '=', title]]);
    if (id) return id;
    return odoo.create('utm.campaign', { title, name: title, is_auto_campaign: true }, ['title']);
  });
}

async function createLead(d, opts) {
  const o = opts || {};
  const meta = isMetaVisit(d.attrib);
  const a = d.attrib || {};
  const vals = {
    type: 'opportunity',
    name: titleFor(d),
    contact_name: d.name,
    partner_name: d.company || false,
    email_from: norm(d.email),
    phone: odooPhone(d.phone),
    team_id: await odoo.teamId(),
    user_id: await odoo.userId(),
    stage_id: await odoo.stageId(STAGES.new),
    priority: stars(d.q1, d.q2),
    x_studio_lead_type: await inboundType()
  };
  // Shubhang (14 Nov): the details go only in the chatter, as the lead's first log note, not in the Notes field
  const details = (o.pastClient ? '<p>Past client</p>' : '') + descriptionHtml(d, cfg.newTracking());
  if (meta) {
    vals.x_studio_lead_channel = await metaChannel();
    const src = await odoo.sourceId('Facebook');
    if (src) vals.source_id = src;
    if (cfg.newTracking() && a.utm_campaign) {
      const cid = await campaignId(a.utm_campaign);
      if (cid) vals.campaign_id = cid;
    }
  }
  if (v2()) {
    vals.contact_name = tidy(d.name);
    vals.partner_name = tidy(d.company) || false;
    Object.assign(vals, await adoptVals({}, d)); // the tag and the Contact
  }
  Object.keys(vals).forEach(k => { if (vals[k] === null || vals[k] === undefined || vals[k] === '') delete vals[k]; });
  const id = await odoo.create('crm.lead', vals, ['name', 'email_from']);
  // ODOO_V2 ("Odoo 7"): no note when the form is sent; the details go in the "booked" or "didn't book" note.
  // "Odoo 14" B: a past client's new lead gets its to-do now, and its first note opens with "Past client".
  if (v2()) {
    if (o.pastClient) await pastClientV2(id);
    return id;
  }
  // Tried twice (a retry first checks the note isn't already there); a failed note never fails the lead
  await odoo.note(id, details).catch(err => console.warn('⚠️ [Odoo first note]:', logsafe.safe(err.message)));
  return id;
}

async function reasonOf(l) { return Array.isArray(l.lost_reason_id) ? l.lost_reason_id[1] : 'no reason'; }

async function markDone(leadId, summary, feedback) {
  const acts = await odoo.searchRead('mail.activity', [['res_model', '=', 'crm.lead'], ['res_id', '=', leadId], ['summary', '=', summary]], ['id']);
  if (acts.length) {
    const ids = acts.map(x => x.id);
    await odoo.call('mail.activity', 'action_feedback', { ids, feedback }, {
      // Done activities leave the list: none left means the first try worked
      check: async () => ((await odoo.searchRead('mail.activity', [['id', 'in', ids]], ['id'])) || []).length ? null : true
    });
  }
  return acts.length;
}

async function setDeadline(leadId, summary, day) {
  const acts = await odoo.searchRead('mail.activity', [['res_model', '=', 'crm.lead'], ['res_id', '=', leadId], ['summary', '=', summary]], ['id']);
  if (!acts.length) return false;
  await odoo.write('mail.activity', acts.map(x => x.id), { date_deadline: day });
  return true;
}

// fillEmail: the lead was found by phone and has no email: add the one they gave us
async function reopen(lost, d, now, fillEmail) {
  const vals = {
    active: true, lost_reason_id: false, stage_id: await odoo.stageId(STAGES.new), priority: stars(d.q1, d.q2)
  };
  if (fillEmail && d.email) vals.email_from = norm(d.email);
  if (!lost.x_studio_lead_channel && isMetaVisit(d.attrib)) vals.x_studio_lead_channel = await metaChannel();
  if (v2()) {
    vals.name = leadNameV2(d);
    Object.assign(vals, await adoptVals(lost, d));
  }
  const reason = await reasonOf(lost);
  await odoo.write('crm.lead', [lost.id], vals);
  if (vals.partner_id) lost.partner_id = vals.partner_id;
  // The callers go on with this row: give it the values just saved (a lead that just became Meta Ads gets its reminders)
  Object.assign(lost, { active: true, stage_id: vals.stage_id });
  if (vals.x_studio_lead_channel) lost.x_studio_lead_channel = vals.x_studio_lead_channel;
  if (vals.email_from) lost.email_from = vals.email_from;
  if (v2()) { // "Odoo 14" A
    await cameBackV2(lost, d, reason);
    return lost.id;
  }
  await odoo.note(lost.id, `Came back on ${esc(dayText(now))} (was lost: ${esc(reason)})<br>${answersHtml(d)}`);
  // Odoo adds "Came back: read the history first" and "WhatsApp follow-up": the second one is done, so one reminder stays.
  // ODOO_V2 ("Odoo 5"): nothing is ever marked Done by the code.
  if (!v2()) await markDone(lost.id, REMINDER.followUp, 'Came back');
  return lost.id;
}

const sigOf = (d) => [norm(d.email), odooPhone(d.phone), d.name, d.company, d.q1, d.q2].join('|');

// ---------- /api/lead ----------
// d: { leadEventId, name, company, email, phone, q1, q2, attrib, consentAt, test }
async function onLead(d) {
  if (!odoo.configured()) return 'not-configured';
  try {
    // Two locks (brief 5.3): one per lead_event_id, so Back with a changed email can't race the same visit,
    // then one per email. Always taken in this order, so two calls never wait on each other forever.
    const byEmail = () => withLock('email:' + norm(d.email), () => leadInner(d));
    return d.leadEventId ? await withLock('event:' + d.leadEventId, byEmail) : await byEmail();
  } catch (err) {
    console.error('❌ [Odoo lead]:', logsafe.safe(err.message));
    await failureAlert(d, err);
    return 'failed';
  }
}

async function leadInner(d) {
  const now = new Date();
  const mapKey = 'odoolead:' + d.leadEventId;
  const known = await store.get(mapKey);
  if (known) {
    if (known.sig === sigOf(d)) return 'retry-nothing-changed';
    const back = {
      email_from: norm(d.email), phone: odooPhone(d.phone), name: titleFor(d), contact_name: d.name,
      partner_name: d.company || false, priority: stars(d.q1, d.q2)
    };
    if (v2()) { // a blank from a later form never overwrites a saved detail
      back.contact_name = tidy(d.name); back.partner_name = tidy(d.company);
      if (!back.partner_name) delete back.name; // no company typed now: the saved title (with the company) stays
      Object.keys(back).forEach(k => { if (!back[k]) delete back[k]; });
    }
    await odoo.write('crm.lead', [known.leadId], back);
    if (v2()) {
      // "Odoo 15" A: no note; the lead's Contact takes the latest details. A Contact failure never fails the lead.
      await updateContactAfterBack(known.leadId, d).catch(err => console.warn('⚠️ [Odoo Contact after Back]:', logsafe.safe(err.message)));
    } else {
      await odoo.note(known.leadId, `Details changed after Back<br>${answersHtml(d)}`);
    }
    await store.set(mapKey, { leadId: known.leadId, sig: sigOf(d) }, { ttl: 86400 });
    return 'updated';
  }

  const cls = await find(d.email, odooPhone(d.phone), d.test);
  const meta = isMetaVisit(d.attrib);
  let leadId;
  let result;
  if (cls.open) {
    leadId = cls.open.id;
    const lines = [`Filled the form again on ${esc(dayText(now))}`, answersHtml(d)];
    if (!cls.open.x_studio_lead_channel && meta) {
      await odoo.write('crm.lead', [leadId], { x_studio_lead_channel: await metaChannel() });
    } else if (cls.open.x_studio_lead_channel && meta && cls.open.x_studio_lead_channel !== await metaChannel()) {
      lines.push(`Came through a Meta ad on ${esc(dayText(now))}`);
    }
    if (cls.fillEmail) await odoo.write('crm.lead', [leadId], { email_from: norm(d.email) });
    if (v2()) {
      // "Odoo 13": no "filled again" note now (it comes with "didn't book"), except when a call is already booked
      await adoptLead(cls.open, d);
      const v = await onFilledAgainV2(cls.open, d, cls);
      await saveVisit(d.leadEventId, { leadId, kind: v.kind });
    } else {
      await odoo.note(leadId, lines.join('<br>'));
    }
    result = 'noted';
  } else if (cls.lost.length) {
    leadId = await reopen(cls.lost[0], d, now, cls.fillEmail);
    if (v2()) await saveVisit(d.leadEventId, { leadId, kind: 'cameback' });
    result = 'reopened';
  } else {
    leadId = await createLead(d, { pastClient: cls.won.length > 0 });
    if (v2()) await saveVisit(d.leadEventId, { leadId, kind: cls.won.length > 0 ? 'pastclient' : 'new' });
    result = 'created';
  }
  await store.set(mapKey, { leadId, sig: sigOf(d) }, { ttl: 86400 });
  return result;
}

async function failureAlert(d, err) {
  const email = norm(d.email);
  await alerts.send('A lead could not go into Odoo',
    `Odoo could not take this lead, even after a retry (${err.message}).\n\nName: ${d.name || '-'}\nCompany: ${d.company || '-'}\nEmail: ${d.email || '-'}\nWhatsApp: ${d.phone || '-'}\n` +
    (d.q1 ? `Situation: ${d.q1}\nTimeline: ${d.q2}\n` : '') + (d.bookedAt ? `Booked: ${d.bookedAt}\n` : '') +
    '\nWhen you add them by hand, use this same email.',
    'odoo-fail:' + email, { backup: false }).catch(() => {});
}

// ---------- the booking webhook (5.4, 5.5) ----------
function parseNotes(text) {
  const out = {};
  String(text || '').split(/\r?\n/).forEach(line => {
    const m = line.match(/^(Company or project|WhatsApp|What.s happening right now|When they.d want it running):\s*(.*)$/i);
    if (!m) return;
    const k = m[1].toLowerCase();
    if (k.startsWith('company')) out.company = m[2].trim();
    else if (k.startsWith('whatsapp')) out.phone = m[2].trim();
    else if (k.startsWith('what')) out.q1 = m[2].trim();
    else out.q2 = m[2].trim();
  });
  return out;
}

function bookingDetails(p) {
  const attendee = (p.attendees || [])[0] || {};
  const notesRaw = (p.responses && p.responses.notes && (p.responses.notes.value || p.responses.notes)) || p.additionalNotes || p.description || '';
  const n = parseNotes(typeof notesRaw === 'string' ? notesRaw : '');
  const md = p.metadata || {};
  return {
    name: attendee.name || '', email: attendee.email || '', company: n.company || '', phone: n.phone || '',
    q1: n.q1 || '', q2: n.q2 || '', attrib: md, consentAt: md.consent_at || '',
    test: md.test === 'yes' || cfg.isTest(attendee.email), leadEventId: md.lead_event_id || ''
  };
}

// The day before the call (IST); the call's own day when this is at or after 8 pm the day before, or later
function reminderDay(startDate, now) {
  const callDay = t.istDay(startDate);
  const prev = dayAfter(startDate, -1);
  const today = t.istDay(now);
  const hour = t.zoneParts(now, 'Asia/Kolkata').hour;
  return (today > prev || (today === prev && hour >= 20)) ? callDay : prev;
}

async function ensureEvening(leadId, owner, day) {
  if (await setDeadline(leadId, REMINDER.evening, day)) return;
  await odoo.call('crm.lead', 'activity_schedule', {
    ids: [leadId], summary: REMINDER.evening, activity_type_id: await odoo.meetingTypeId(),
    user_id: Array.isArray(owner) ? owner[0] : owner || (await odoo.userId()), date_deadline: day
  }, {
    // A retry first checks the reminder isn't already there
    check: async () => {
      const rows = await odoo.searchRead('mail.activity', [['res_model', '=', 'crm.lead'], ['res_id', '=', leadId], ['summary', '=', REMINDER.evening], ['date_deadline', '=', day]], ['id']);
      return rows && rows.length ? true : null;
    }
  });
}

// A lead found by phone has no email yet (findLeads only matches those): add the one from the booking
async function fillEmailIfFoundByPhone(cls, leadId, d) {
  if (cls.fillEmail && d.email) await odoo.write('crm.lead', [leadId], { email_from: norm(d.email) });
}

async function resolveForBooking(d, test) {
  return find(d.email, odooPhone(d.phone), test);
}

async function keepUid(leadId, p, d) {
  if (!d.leadEventId) return;
  await store.set('odoouid:' + leadId, { uid: p.uid, leadEventId: d.leadEventId });
}

async function applyScheduled(lead, p, d, now) {
  const start = new Date(p.startTime);
  const stageId = lead.stageOf(lead);
  const newId = await odoo.stageId(STAGES.new);
  const repliedId = await odoo.stageId(STAGES.replied);
  const schedId = await odoo.stageId(STAGES.scheduled);
  const moved = stageId === newId || stageId === repliedId;
  const vals = moved ? { stage_id: schedId } : {};
  if (v2() && moved) Object.assign(vals, await revenueVals(lead)); // "Odoo 4": a booked call
  if (Object.keys(vals).length) await odoo.write('crm.lead', [lead.id], vals);
  return { moved };
}

async function onCreated(p, d, now) {
  const test = d.test;
  let cls = await withLock('email:' + norm(d.email), () => resolveForBooking(d, test));
  if (!cls.open) await sleep(bookWaitMs); // the lead's own call may still be on its way

  return withLock('email:' + norm(d.email), async () => {
    cls = await resolveForBooking(d, test);
    let lead = cls.open;
    if (lead) await fillEmailIfFoundByPhone(cls, lead.id, d);
    if (lead && v2()) await adoptLead(lead, d);
    if (!lead) {
      if (cls.lost.length) {
        const id = await reopen(cls.lost[0], d, now, cls.fillEmail);
        lead = Object.assign({}, cls.lost[0], { id, active: true, stage_id: await odoo.stageId(STAGES.new), x_studio_lead_channel: cls.lost[0].x_studio_lead_channel });
      } else {
        const id = await createLead(d, { pastClient: cls.won.length > 0 });
        const row = (await odoo.searchRead('crm.lead', [['id', '=', id]], v2() ? LEAD_FIELDS_V2 : LEAD_FIELDS, { context: { active_test: false } }))[0];
        lead = row;
      }
    }
    lead.stageOf = cls.stageOf;
    const meta = !!lead.x_studio_lead_channel && lead.x_studio_lead_channel === await metaChannel();
    const { moved } = await applyScheduled(lead, p, d, now);
    await odoo.note(lead.id, `Call booked for ${esc(timeText(new Date(p.startTime)))}`);
    await keepUid(lead.id, p, d);
    if (meta) {
      await markDone(lead.id, REMINDER.followUp, 'Booked');
      await markDone(lead.id, REMINDER.getBooked, 'Booked');
      await ensureEvening(lead.id, lead.user_id, reminderDay(new Date(p.startTime), now));
    }
    return moved ? 'scheduled' : 'scheduled-no-move';
  });
}

async function onRescheduled(p, d, now) {
  return withLock('email:' + norm(d.email), async () => {
    const cls = await resolveForBooking(d, d.test);
    let lead = cls.open;
    if (lead) await fillEmailIfFoundByPhone(cls, lead.id, d);
    if (lead && v2()) await adoptLead(lead, d);
    if (!lead && cls.lost.length) {
      const id = await reopen(cls.lost[0], d, now, cls.fillEmail);
      lead = Object.assign({}, cls.lost[0], { id, active: true, stage_id: await odoo.stageId(STAGES.new) });
    }
    if (!lead && cls.won.length) {
      await odoo.note(cls.won[0].id, `Call moved to ${esc(timeText(new Date(p.startTime)))}`);
      return 'won-note-only';
    }
    if (!lead) { console.log('ℹ️ [Odoo]: reschedule webhook with no lead found'); return 'no-lead'; }
    lead.stageOf = cls.stageOf;
    await odoo.note(lead.id, `Call moved to ${esc(timeText(new Date(p.startTime)))}`);
    await keepUid(lead.id, p, d);
    const meta = !!lead.x_studio_lead_channel && lead.x_studio_lead_channel === await metaChannel();
    const stageId = lead.stageOf(lead);
    const early = stageId === await odoo.stageId(STAGES.new) || stageId === await odoo.stageId(STAGES.replied);
    if (early) await applyScheduled(lead, p, d, now);
    if (meta) {
      if (early) {
        await markDone(lead.id, REMINDER.followUp, 'Booked');
        await markDone(lead.id, REMINDER.getBooked, 'Booked');
      }
      await ensureEvening(lead.id, lead.user_id, reminderDay(new Date(p.startTime), now));
    }
    return 'moved';
  });
}

async function onCancelled(p, d, now) {
  return withLock('email:' + norm(d.email), async () => {
    const cls = await resolveForBooking(d, d.test);
    const lead = cls.open || cls.lost[0] || cls.won[0];
    if (!lead) { console.log('ℹ️ [Odoo]: cancel webhook with no lead found'); return 'no-lead'; }
    await odoo.note(lead.id, 'Call cancelled');
    // The call is off: its "evening before" reminder is done whatever stage the lead is in (and whatever its channel)
    await markDone(lead.id, REMINDER.evening, 'Cancelled');
    if (!cls.open) return 'note-only';
    const schedId = await odoo.stageId(STAGES.scheduled);
    if (cls.stageOf(lead) !== schedId) return 'noted';
    await odoo.write('crm.lead', [lead.id], { stage_id: await odoo.stageId(STAGES.replied) });
    const meta = !!lead.x_studio_lead_channel && lead.x_studio_lead_channel === await metaChannel();
    if (meta) {
      const hour = t.zoneParts(now, 'Asia/Kolkata').hour;
      await setDeadline(lead.id, REMINDER.getBooked, hour >= 19 ? dayAfter(now, 1) : t.istDay(now));
    }
    return 'back-to-replied';
  });
}

// body: Cal.com's webhook body. Runs after the reply (waitUntil); an error here never touches the booking or its email.
async function onWebhook(body) {
  if (!odoo.configured()) return 'not-configured';
  const trigger = body && body.triggerEvent;
  if (!['BOOKING_CREATED', 'BOOKING_RESCHEDULED', 'BOOKING_CANCELLED'].includes(trigger)) return 'ignored';
  const p = body.payload || {};
  if (!p.uid || !p.startTime) return 'ignored:incomplete';
  if (p.eventTypeId && Number(p.eventTypeId) !== cfg.eventTypeId()) return 'ignored:other-event';
  const d = bookingDetails(p);
  if (!d.email) return 'ignored:incomplete';

  // Cal.com can send a webhook twice: one mark per booking and trigger, so nothing happens twice
  const mark = `odoohook:${p.uid}:${trigger}`;
  if (!(await store.set(mark, 1, { nx: true, ttl: 90 * 86400 }))) return 'duplicate';
  try {
    const now = new Date();
    if (v2()) {
      if (trigger === 'BOOKING_CREATED') return await onCreatedV2(p, d, now);
      if (trigger === 'BOOKING_RESCHEDULED') return await onRescheduledV2(p, d, now);
      return await onCancelledV2(p, d, now);
    }
    if (trigger === 'BOOKING_CREATED') return await onCreated(p, d, now);
    if (trigger === 'BOOKING_RESCHEDULED') return await onRescheduled(p, d, now);
    return await onCancelled(p, d, now);
  } catch (err) {
    console.error('❌ [Odoo webhook]:', logsafe.safe(err.message));
    await store.del(mark).catch(() => {});
    d.bookedAt = p.startTime ? timeText(new Date(p.startTime)) : '';
    await failureAlert(d, err);
    return 'failed';
  }
}

// ---------- no times showed (5.7) ----------
async function onNoTimes(lead) {
  if (!odoo.configured()) return 'not-configured';
  const test = cfg.isTest(lead.email);
  const d = { email: lead.email, phone: lead.whatsapp_number };
  try {
    let cls = await withLock('email:' + norm(d.email), () => find(d.email, odooPhone(d.phone), test));
    if (!cls.open) {
      await sleep(bookWaitMs);
      cls = await withLock('email:' + norm(d.email), () => find(d.email, odooPhone(d.phone), test));
    }
    if (!cls.open) return 'no-lead';
    await setDeadline(cls.open.id, REMINDER.followUp, t.istDay(new Date()));
    return 'due-today';
  } catch (err) {
    console.error('❌ [Odoo no-times]:', logsafe.safe(err.message));
    return 'failed';
  }
}

module.exports = {
  onLead, onWebhook, onNoTimes, odooPhone, isMetaVisit, stars, leadName, leadNameV2, parseNotes, reminderDay, norm,
  findLeads, findLeadsV2, ensureContacts, logEmail, onBounceV2, onDidntBookV2, afterNudgesV2, onNoTimesV2, visitOf, formDetails, R4, sourceLine, R, CALL_REMINDERS, _ensureCallReminders: ensureCallReminders, withLock, metaChannel, markDone, TEST_PREFIX, STAGES, LEAD_FIELDS, REVENUE,
  _setWaits: (o) => { if (o.lock != null) lockPollMs = o.lock; if (o.book != null) bookWaitMs = o.book; }
};
