// Leads into Odoo (Odoo Brief v1, part 5): the lead from /api/lead, the booking webhook (created, moved, cancelled)
// and the no-times reminder. Never makes a contact, never deletes, never marks won or lost, never adds tags.
const cfg = require('./config');
const t = require('./time');
const store = require('./store');
const alerts = require('./alerts');
const qualify = require('./qualify');
const odoo = require('./odoo');

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

// ---------- the store lock: one per email ----------
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

// ---------- making and reopening leads ----------
async function campaignId(title) {
  return withLock('campaign:' + title, async () => {
    const id = await odoo.firstId('utm.campaign', [['title', '=', title]]);
    if (id) return id;
    return odoo.create('utm.campaign', { title, name: title, is_auto_campaign: true });
  });
}

async function createLead(d, opts) {
  const o = opts || {};
  const meta = isMetaVisit(d.attrib);
  const a = d.attrib || {};
  const vals = {
    type: 'opportunity',
    name: leadName(d),
    contact_name: d.name,
    partner_name: d.company || false,
    email_from: norm(d.email),
    phone: odooPhone(d.phone),
    team_id: await odoo.teamId(),
    user_id: await odoo.userId(),
    stage_id: await odoo.stageId(STAGES.new),
    priority: stars(d.q1, d.q2),
    x_studio_lead_type: await inboundType(),
    description: (o.pastClient ? '<p>Past client</p>' : '') + descriptionHtml(d, cfg.newTracking())
  };
  if (meta) {
    vals.x_studio_lead_channel = await metaChannel();
    const src = await odoo.sourceId('Facebook');
    if (src) vals.source_id = src;
    if (cfg.newTracking() && a.utm_campaign) {
      const cid = await campaignId(a.utm_campaign);
      if (cid) vals.campaign_id = cid;
    }
  }
  Object.keys(vals).forEach(k => { if (vals[k] === null || vals[k] === undefined || vals[k] === '') delete vals[k]; });
  return odoo.create('crm.lead', vals);
}

async function reasonOf(l) { return Array.isArray(l.lost_reason_id) ? l.lost_reason_id[1] : 'no reason'; }

async function markDone(leadId, summary, feedback) {
  const acts = await odoo.searchRead('mail.activity', [['res_model', '=', 'crm.lead'], ['res_id', '=', leadId], ['summary', '=', summary]], ['id']);
  if (acts.length) await odoo.call('mail.activity', 'action_feedback', { ids: acts.map(x => x.id), feedback });
  return acts.length;
}

async function setDeadline(leadId, summary, day) {
  const acts = await odoo.searchRead('mail.activity', [['res_model', '=', 'crm.lead'], ['res_id', '=', leadId], ['summary', '=', summary]], ['id']);
  if (!acts.length) return false;
  await odoo.write('mail.activity', acts.map(x => x.id), { date_deadline: day });
  return true;
}

async function reopen(lost, d, now) {
  const vals = {
    active: true, lost_reason_id: false, stage_id: await odoo.stageId(STAGES.new), priority: stars(d.q1, d.q2)
  };
  if (!lost.x_studio_lead_channel && isMetaVisit(d.attrib)) vals.x_studio_lead_channel = await metaChannel();
  const reason = await reasonOf(lost);
  await odoo.write('crm.lead', [lost.id], vals);
  await odoo.note(lost.id, `Came back on ${esc(dayText(now))} (was lost: ${esc(reason)})<br>${answersHtml(d)}`);
  // Odoo adds "Came back: read the history first" and "WhatsApp follow-up": the second one is done, so one reminder stays
  await markDone(lost.id, REMINDER.followUp, 'Came back');
  return lost.id;
}

const sigOf = (d) => [norm(d.email), odooPhone(d.phone), d.name, d.company, d.q1, d.q2].join('|');

// ---------- /api/lead ----------
// d: { leadEventId, name, company, email, phone, q1, q2, attrib, consentAt, test }
async function onLead(d) {
  if (!odoo.configured()) return 'not-configured';
  try {
    return await withLock('email:' + norm(d.email), () => leadInner(d));
  } catch (err) {
    console.error('❌ [Odoo lead]:', err.message);
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
    await odoo.write('crm.lead', [known.leadId], {
      email_from: norm(d.email), phone: odooPhone(d.phone), name: leadName(d), contact_name: d.name,
      partner_name: d.company || false, priority: stars(d.q1, d.q2)
    });
    await odoo.note(known.leadId, `Details changed after Back<br>${answersHtml(d)}`);
    await store.set(mapKey, { leadId: known.leadId, sig: sigOf(d) }, { ttl: 86400 });
    return 'updated';
  }

  const cls = await findLeads(d.email, odooPhone(d.phone), d.test);
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
    await odoo.note(leadId, lines.join('<br>'));
    result = 'noted';
  } else if (cls.lost.length) {
    leadId = await reopen(cls.lost[0], d, now);
    result = 'reopened';
  } else {
    leadId = await createLead(d, { pastClient: cls.won.length > 0 });
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
  });
}

async function resolveForBooking(d, test) {
  return findLeads(d.email, odooPhone(d.phone), test);
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
  if (moved) await odoo.write('crm.lead', [lead.id], { stage_id: schedId });
  return { moved };
}

async function onCreated(p, d, now) {
  const test = d.test;
  let cls = await withLock('email:' + norm(d.email), () => resolveForBooking(d, test));
  if (!cls.open) await sleep(bookWaitMs); // the lead's own call may still be on its way

  return withLock('email:' + norm(d.email), async () => {
    cls = await resolveForBooking(d, test);
    let lead = cls.open;
    if (!lead) {
      if (cls.lost.length) {
        const id = await reopen(cls.lost[0], d, now);
        lead = Object.assign({}, cls.lost[0], { id, active: true, stage_id: await odoo.stageId(STAGES.new), x_studio_lead_channel: cls.lost[0].x_studio_lead_channel });
      } else {
        const id = await createLead(d, { pastClient: cls.won.length > 0 });
        const row = (await odoo.searchRead('crm.lead', [['id', '=', id]], LEAD_FIELDS, { context: { active_test: false } }))[0];
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
    if (!lead && cls.lost.length) {
      const id = await reopen(cls.lost[0], d, now);
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
    if (!cls.open) return 'note-only';
    const schedId = await odoo.stageId(STAGES.scheduled);
    if (cls.stageOf(lead) !== schedId) return 'noted';
    await odoo.write('crm.lead', [lead.id], { stage_id: await odoo.stageId(STAGES.replied) });
    const meta = !!lead.x_studio_lead_channel && lead.x_studio_lead_channel === await metaChannel();
    if (meta) {
      const hour = t.zoneParts(now, 'Asia/Kolkata').hour;
      await setDeadline(lead.id, REMINDER.getBooked, hour >= 19 ? dayAfter(now, 1) : t.istDay(now));
      await markDone(lead.id, REMINDER.evening, 'Cancelled');
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
    if (trigger === 'BOOKING_CREATED') return await onCreated(p, d, now);
    if (trigger === 'BOOKING_RESCHEDULED') return await onRescheduled(p, d, now);
    return await onCancelled(p, d, now);
  } catch (err) {
    console.error('❌ [Odoo webhook]:', err.message);
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
    let cls = await withLock('email:' + norm(d.email), () => findLeads(d.email, odooPhone(d.phone), test));
    if (!cls.open) {
      await sleep(bookWaitMs);
      cls = await withLock('email:' + norm(d.email), () => findLeads(d.email, odooPhone(d.phone), test));
    }
    if (!cls.open) return 'no-lead';
    await setDeadline(cls.open.id, REMINDER.followUp, t.istDay(new Date()));
    return 'due-today';
  } catch (err) {
    console.error('❌ [Odoo no-times]:', err.message);
    return 'failed';
  }
}

module.exports = {
  onLead, onWebhook, onNoTimes, odooPhone, isMetaVisit, stars, leadName, parseNotes, reminderDay, norm,
  findLeads, withLock, metaChannel, markDone, TEST_PREFIX, STAGES, LEAD_FIELDS,
  _setWaits: (o) => { if (o.lock != null) lockPollMs = o.lock; if (o.book != null) bookWaitMs = o.book; }
};
