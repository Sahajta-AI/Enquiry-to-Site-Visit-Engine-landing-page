// The Odoo Brief with a fake Odoo (JSON-2), Cal.com, Meta and Gmail. Run with: npm test
// The project is copied to a temp folder first, so the real .env (with the real Odoo key) is never loaded.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sahajta-odoo-'));
fs.cpSync(path.join(root, 'lib'), path.join(tmp, 'lib'), { recursive: true });
fs.copyFileSync(path.join(root, 'server.js'), path.join(tmp, 'server.js'));
fs.symlinkSync(path.join(root, 'node_modules'), path.join(tmp, 'node_modules'));
fs.mkdirSync(path.join(tmp, 'public'));
fs.copyFileSync(path.join(root, 'public', 'tracking-test.html'), path.join(tmp, 'public', 'tracking-test.html'));

Object.assign(process.env, {
  NODE_ENV: 'test', SITE_URL: 'https://preview.example.test', CAL_EVENT_TYPE_ID: '7785231', CAL_API_KEY: 'cal_test', CAL_WEBHOOK_SECRET: 'whsec',
  GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec', GOOGLE_REFRESH_TOKEN: 'ref', GMAIL_SENDER: 'shubhang@sahajta.com',
  QSTASH_TOKEN: 'qt', QSTASH_CURRENT_SIGNING_KEY: 'cur', QSTASH_NEXT_SIGNING_KEY: 'next', RESEND_API_KEY: 're_test',
  META_SANDBOX_PIXEL_ID: '555000111', META_SANDBOX_CAPI_TOKEN: 'sandbox_tok', META_SANDBOX_TEST_EVENT_CODE: 'TEST999', META_GRAPH_VERSION: 'v26.0',
  META_PIXEL_ID: '999111222', META_CAPI_TOKEN: 'live_tok',
  ALERT_EMAIL: 'alerts@example.test', TEST_PAGE_PASSWORD: 'tp-secret', TEST_EMAILS: 'tester@example.com', CRON_SECRET: 'cron-secret-1234567',
  ODOO_URL: 'https://odoo.example.test', ODOO_DB: 'db1', ODOO_API_KEY: 'odoo_key'
});
delete process.env.UPSTASH_REDIS_REST_URL;

const realFetch = global.fetch;
const json = (o, status) => new Response(JSON.stringify(o), { status: status || 200, headers: { 'content-type': 'application/json' } });

// ---------------- the fake Odoo ----------------
const STAGES = { New: 1, Replied: 2, 'Call Scheduled': 3, Qualified: 4, 'Proposal Sent': 5, 'Deal Closed': 6 };
const stageName = (id) => Object.keys(STAGES).find(k => STAGES[k] === id);
const ON_STAGE = { 1: ['WhatsApp follow-up', 1], 2: ['Get the call booked', 2], 3: ['Personal message the evening before the call', 0], 4: ['Send the proposal', 1], 5: ['Follow up on the proposal', 2], 6: ['Kickoff: WhatsApp group + kickoff call', 1] };
let leads, acts, notes, odooCalls, odooDown, seq, utmCampaigns;
function resetOdoo() { leads = []; acts = []; notes = []; odooCalls = []; odooDown = false; seq = 100; utmCampaigns = []; }
resetOdoo();
const isoDay = (offset) => new Date(Date.now() + 5.5 * 3600000 + offset * 86400000).toISOString().slice(0, 10);
function addActs(lead, why) {
  if (lead.x_studio_lead_channel !== 'meta_ads') return;
  const [title, days] = why === 'restore' ? ['Came back: read the history first', 1] : ON_STAGE[lead.stage_id];
  acts.push({ id: ++seq, res_model: 'crm.lead', res_id: lead.id, summary: title, date_deadline: isoDay(days), done: false });
}
const val = (l, f) => f === 'email_normalized' ? (l.email_from ? l.email_from.toLowerCase() : false) : f === 'phone_sanitized' ? (l.phone || false) : l[f];
function match(l, [f, op, v]) {
  const x = val(l, f);
  if (op === '=') return (v === false ? !x : x === v);
  if (op === 'in') return v.includes(x);
  if (op === '>=') return String(x) >= String(v);
  if (op === '=like') return new RegExp('^' + String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$').test(String(x));
  if (op === 'not like') return !String(x || '').includes(v);
  throw new Error('fake Odoo: operator ' + op);
}
function shape(l) {
  return Object.assign({}, l, {
    stage_id: [l.stage_id, stageName(l.stage_id)], lost_reason_id: l.lost_reason_id ? [l.lost_reason_id, 'Too expensive'] : false,
    user_id: [7, 'Shubhang Sethi'], email_normalized: l.email_from ? l.email_from.toLowerCase() : false,
    phone_sanitized: l.phone || false
  });
}
function fakeOdoo(model, method, a) {
  odooCalls.push({ model, method, a });
  if (model === 'crm.stage' && method === 'search_read') { const n = a.domain[0][2]; return STAGES[n] ? [{ id: STAGES[n] }] : []; }
  if (model === 'crm.team') return [{ id: 1 }];
  if (model === 'res.users') return [{ id: 7 }];
  if (model === 'utm.source') return [{ id: 3 }];
  if (model === 'mail.activity.type') return [{ id: 2 }];
  if (model === 'utm.campaign') {
    if (method === 'create') { const c = Object.assign({ id: ++seq }, a.vals_list[0]); utmCampaigns.push(c); return [c.id]; }
    const c = utmCampaigns.find(x => x.title === a.domain[0][2]); return c ? [{ id: c.id }] : [];
  }
  if (model === 'crm.lead') {
    if (method === 'fields_get') {
      return { [a.allfields[0]]: { selection: a.allfields[0] === 'x_studio_lead_channel' ? [['meta_ads', 'Meta Ads'], ['other', 'Other']] : [['inbound', 'Inbound']] } };
    }
    if (method === 'search_read') {
      let rows = leads.filter(l => a.domain.every(d => match(l, d)));
      if (!(a.context && a.context.active_test === false)) rows = rows.filter(l => l.active);
      if (a.order === 'id desc') rows = rows.slice().sort((x, y) => y.id - x.id);
      return rows.map(shape);
    }
    if (method === 'create') {
      const v = a.vals_list[0];
      const l = Object.assign({ id: ++seq, active: true, priority: '0', write_date: new Date().toISOString(), date_last_stage_update: new Date().toISOString().slice(0, 19).replace('T', ' ') }, v);
      leads.push(l); addActs(l, 'stage'); return [l.id];
    }
    if (method === 'write') {
      a.ids.forEach(id => {
        const l = leads.find(x => x.id === id);
        const wasActive = l.active, oldStage = l.stage_id;
        Object.assign(l, a.vals);
        if (a.vals.stage_id && a.vals.stage_id !== oldStage) {
          l.date_last_stage_update = new Date().toISOString().slice(0, 19).replace('T', ' ');
          if (a.vals.stage_id === 6) l.date_closed = l.date_last_stage_update;
          if (!(a.vals.active && !wasActive)) addActs(l, 'stage');
        }
        if (a.vals.active && !wasActive) { addActs(l, 'restore'); if (a.vals.stage_id && a.vals.stage_id !== oldStage) addActs(l, 'stage'); }
      });
      return true;
    }
    if (method === 'message_post') { notes.push({ id: a.ids[0], body: a.body, html: a.body_is_html, type: a.message_type, subtype: a.subtype_xmlid }); return 1; }
    if (method === 'activity_schedule') {
      acts.push({ id: ++seq, res_model: 'crm.lead', res_id: a.ids[0], summary: a.summary, date_deadline: a.date_deadline, done: false, typeId: a.activity_type_id, user: a.user_id });
      return true;
    }
  }
  if (model === 'mail.activity') {
    if (method === 'search_read') {
      const want = Object.fromEntries(a.domain.map(d => [d[0], d[2]]));
      return acts.filter(x => !x.done && x.res_model === want.res_model && x.res_id === want.res_id && x.summary === want.summary).map(x => ({ id: x.id }));
    }
    if (method === 'write') { a.ids.forEach(id => Object.assign(acts.find(x => x.id === id), a.vals)); return true; }
    if (method === 'action_feedback') { a.ids.forEach(id => { const x = acts.find(y => y.id === id); x.done = true; x.feedback = a.feedback; }); return true; }
  }
  throw new Error(`fake Odoo: ${model}/${method}`);
}

// ---------------- the rest of the world ----------------
const sent = [], metaCalls = [];
const calBookings = {}, calByEmail = {};
global.fetch = async (url, opts) => {
  url = String(url); opts = opts || {};
  if (url.startsWith('http://127.0.0.1')) return realFetch(url, opts);
  if (url.startsWith('https://odoo.example.test/json/2/')) {
    assert.strictEqual(opts.headers.Authorization, 'Bearer odoo_key');
    assert.strictEqual(opts.headers['X-Odoo-Database'], 'db1');
    if (odooDown) return json({ message: 'down' }, 500);
    const [model, method] = url.replace('https://odoo.example.test/json/2/', '').split('/');
    try { return json(fakeOdoo(model, method, JSON.parse(opts.body))); } catch (e) { return json({ message: e.message }, 400); }
  }
  if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'tok', expires_in: 3600 });
  if (url.endsWith('/messages/send')) {
    const mime = Buffer.from(JSON.parse(opts.body).raw, 'base64url').toString('utf8');
    const subj = (mime.match(/^Subject: (.*)$/mi) || [])[1] || '';
    const enc = subj.match(/^=\?UTF-8\?B\?(.+)\?=$/);
    sent.push({ subject: enc ? Buffer.from(enc[1], 'base64').toString('utf8') : subj, mime });
    return json({ id: 'm' + sent.length, threadId: 't' + sent.length });
  }
  if (url.startsWith('https://graph.facebook.com/')) {
    const body = JSON.parse(opts.body);
    metaCalls.push({ url, body, event: body.data[0] });
    return json({ events_received: 1, messages: [], fbtrace_id: 'trace1' });
  }
  if (/api\.cal\.com\/v2\/bookings\/[^?]+$/.test(url)) {
    const uid = decodeURIComponent(url.split('/').pop());
    return calBookings[uid] ? json({ data: calBookings[uid] }) : json({}, 404);
  }
  if (url.startsWith('https://api.cal.com/v2/bookings?')) {
    assert.ok(url.includes('sortCreated=desc'), 'newest first');
    const email = decodeURIComponent(url.match(/attendeeEmail=([^&]+)/)[1]);
    return json({ data: calByEmail[email] || [] });
  }
  if (url.includes('/v2/publish/')) return json({ messageId: 'q1' });
  if (/\/messages\/m\d+\?format=metadata/.test(url)) return json({ payload: { headers: [{ name: 'Message-ID', value: '<x@mail.gmail.com>' }] } });
  if (/\/threads\/t\d+/.test(url)) return json({ messages: [{ id: 'm1' }] });
  if (url === 'https://api.resend.com/emails') return json({ id: 'r1' });
  throw new Error('Unmocked fetch: ' + url);
};

const app = require(path.join(tmp, 'server.js'));
const store = require(path.join(tmp, 'lib', 'store.js'));
const ol = require(path.join(tmp, 'lib', 'odooleads.js'));
const odoo = require(path.join(tmp, 'lib', 'odoo.js'));
require(path.join(tmp, 'lib', 'leads.js'))._setRecordWaitMs(5);
ol._setWaits({ lock: 5, book: 5 });
odoo._setRetryWaitMs(5);
let server, base;
test.before(async () => { await new Promise(r => { server = app.listen(0, r); }); base = 'http://127.0.0.1:' + server.address().port; });
test.after(() => { server.close(); global.fetch = realFetch; fs.rmSync(tmp, { recursive: true, force: true }); });

const post = (p, body, headers) => realFetch(base + p, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: typeof body === 'string' ? body : JSON.stringify(body) });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const settle = () => sleep(150); // the work after the reply (waitUntil) finishes

function reset() { resetOdoo(); sent.length = 0; metaCalls.length = 0; store._resetMemory(); odoo._reset(); for (const k of Object.keys(calBookings)) delete calBookings[k]; for (const k of Object.keys(calByEmail)) delete calByEmail[k]; delete process.env.NEW_TRACKING; delete process.env.VERCEL_ENV; }

const Q1_FIT = 'We run paid ads but leads go cold because follow-up is slow';
const Q2_FIT = 'As soon as possible';
let n = 0;
const uuid = () => crypto.randomUUID();
const metaAttrib = { utm_source: 'fb', utm_term: 'Test set', utm_content: 'Test ad', utm_campaign: '[TEST] Odoo', fbclid: 'TEST123', angle: 'speed', first_seen: new Date().toISOString() };
function leadBody(over) {
  return Object.assign({
    lead_event_id: uuid(), name: 'Asha Rao', company: 'Rao Estates', email: 'asha+odoo' + (++n) + '@example.com', whatsapp_number: '9876543210',
    q1_situation: Q1_FIT, q2_urgency: Q2_FIT, form_ms: 9000, timezone: 'Asia/Kolkata', sv_attrib: metaAttrib
  }, over || {});
}
const sendLead = async (b) => { const r = await post('/api/lead', b); await settle(); return r; };
const leadOf = (email) => leads.filter(l => l.email_from === email.toLowerCase());
const notesOf = (id) => notes.filter(x => x.id === id).map(x => x.body);
// The first note on a new lead repeats its Notes in the chatter (Shubhang, 14 Nov); later notes are what these tests count
const isFirstNote = (x) => /Agreed to be contacted:/.test(x.body) && !/^(Filled the form again|Details changed|Came back)/.test(x.body);
const laterNotes = () => notes.filter(x => !isFirstNote(x));
const actsOf = (id, summary) => acts.filter(x => x.res_id === id && (!summary || x.summary === summary));

// ---------------- 5.1 to 5.3: the lead ----------------
test('5.2 a Meta visit: one "[TEST]" lead with every field, no contact, no tags, no fbclid anywhere in Odoo', async () => {
  reset();
  process.env.NEW_TRACKING = 'on';
  const b = leadBody();
  assert.strictEqual((await sendLead(b)).status, 200);
  const [l] = leadOf(b.email);
  assert.ok(l, 'a lead was made');
  assert.strictEqual(l.name, '[TEST] Rao Estates (Asha Rao)');
  assert.strictEqual(l.type, 'opportunity');
  assert.strictEqual(l.phone, '+919876543210');
  assert.strictEqual(l.priority, '3');
  assert.strictEqual(l.stage_id, STAGES.New);
  assert.strictEqual(l.x_studio_lead_type, 'inbound');
  assert.strictEqual(l.x_studio_lead_channel, 'meta_ads');
  assert.strictEqual(l.source_id, 3);
  assert.strictEqual(l.team_id, 1);
  assert.strictEqual(l.user_id, 7);
  assert.strictEqual(l.campaign_id, utmCampaigns[0].id);
  assert.strictEqual(utmCampaigns[0].title, '[TEST] Odoo');
  assert.strictEqual(utmCampaigns[0].is_auto_campaign, true);
  assert.ok(l.description.includes(Q1_FIT) && l.description.includes(Q2_FIT) && l.description.includes('Good fit: yes'));
  assert.ok(l.description.includes('Test set') && l.description.includes('angle speed'));
  assert.ok(l.description.includes('Agreed to be contacted'));
  assert.strictEqual(actsOf(l.id, 'WhatsApp follow-up').length, 1, 'Odoo adds the follow-up reminder');
  const all = JSON.stringify({ leads, notes });
  assert.ok(!all.includes('TEST123') && !all.includes('fbclid'), 'no fbclid in Odoo');
  assert.ok(!odooCalls.some(c => c.model === 'res.partner'), 'no contact is ever made');
  assert.ok(!('partner_id' in l) && !('tag_ids' in l) && !('medium_id' in l));
});

test('5.2 NEW_TRACKING off: leads still go in, but with no campaign and no ad names', async () => {
  reset();
  process.env.NEW_TRACKING = 'off';
  const b = leadBody();
  await sendLead(b);
  const [l] = leadOf(b.email);
  assert.ok(l && !l.campaign_id && !utmCampaigns.length);
  assert.strictEqual(l.x_studio_lead_channel, 'meta_ads');
  assert.ok(!l.description.includes('Test set'));
});

test('5.2 no ad keys: Lead Channel empty, "Website: no ad click found", no reminder, stars by answers', async () => {
  reset();
  const b = leadBody({ sv_attrib: {}, q1_situation: 'We are still planning or exploring', q2_urgency: 'I am only exploring right now' });
  await sendLead(b);
  const [l] = leadOf(b.email);
  assert.ok(!l.x_studio_lead_channel && !l.source_id);
  assert.ok(l.description.includes('Website: no ad click found'));
  assert.strictEqual(l.priority, '1');
  assert.strictEqual(acts.length, 0);
  assert.strictEqual(ol.stars(Q1_FIT, 'I am only exploring right now'), '2');
  assert.strictEqual(ol.stars('', ''), '0');
});

test('5.3 retries and Back: the same call twice or at once is one lead; Back with a new email updates it with one note; a new visit adds a note only', async () => {
  reset();
  const b = leadBody();
  await Promise.all([post('/api/lead', b), post('/api/lead', b)]);
  await settle();
  assert.strictEqual(leadOf(b.email).length, 1);
  assert.strictEqual(laterNotes().length, 0, 'no "filled again" note for a retry');
  assert.strictEqual(notes.filter(isFirstNote).length, 1, 'the new lead gets its details once in the chatter');

  const back = Object.assign({}, b, { email: 'changed' + n + '@example.com' });
  await sendLead(back);
  assert.strictEqual(leads.length, 1, 'still one lead');
  assert.strictEqual(leads[0].email_from, back.email.toLowerCase());
  assert.strictEqual(notes.filter(x => x.body.startsWith('Details changed after Back')).length, 1);

  await sendLead(leadBody({ email: back.email })); // a new lead_event_id
  assert.strictEqual(leads.length, 1);
  assert.ok(notes.some(x => x.body.startsWith('Filled the form again on')));
  assert.ok(notes.every(x => x.html === true && x.type === 'comment' && x.subtype === 'mail.mt_note'), 'internal notes only');
});

test('5.3 an open lead with another channel is kept and the note says it came through a Meta ad', async () => {
  reset();
  const b = leadBody({ sv_attrib: {} });
  await sendLead(b);
  leads[0].x_studio_lead_channel = 'other';
  await sendLead(leadBody({ email: b.email }));
  assert.strictEqual(leads[0].x_studio_lead_channel, 'other');
  assert.ok(notes.some(x => x.body.includes('Came through a Meta ad on')));
});

test('5.3 lost: reopened to New with one note and only "Came back" open; won: a new "Past client" lead', async () => {
  reset();
  const b = leadBody();
  await sendLead(b);
  const l = leads[0];
  l.active = false; l.lost_reason_id = 9; l.date_closed = '2026-11-01 10:00:00';
  acts.length = 0;
  await sendLead(leadBody({ email: b.email }));
  assert.strictEqual(leads.length, 1);
  assert.strictEqual(l.active, true);
  assert.strictEqual(l.stage_id, STAGES.New);
  assert.ok(!l.lost_reason_id);
  assert.ok(notes.some(x => x.body.includes('was lost: Too expensive')));
  const open = acts.filter(x => !x.done).map(x => x.summary);
  assert.deepStrictEqual(open, ['Came back: read the history first']);

  l.stage_id = STAGES['Deal Closed'];
  await sendLead(leadBody({ email: b.email }));
  assert.strictEqual(leads.length, 2);
  assert.ok(leads[1].description.startsWith('<p>Past client</p>'));
});

test('5.3 a test only touches "[TEST]" leads and a real person ignores them', async () => {
  reset();
  const b = leadBody();
  leads.push({ id: 5, name: 'Real Co (Real)', active: true, stage_id: 1, email_from: b.email.toLowerCase(), priority: '1' });
  await sendLead(b);
  assert.strictEqual(leads.length, 2, 'a [TEST] lead was added; the real one was left alone');
  assert.strictEqual(leads[0].stage_id, 1);
  assert.ok(notes.every(x => x.id !== 5), 'nothing written on the real lead');
});

// ---------------- 5.4 to 5.7: bookings ----------------
function hook(trigger, uid, email, startIso, extra) {
  const payload = Object.assign({
    uid, eventTypeId: 7785231, startTime: startIso, attendees: [{ name: 'Asha Rao', email, timeZone: 'Asia/Kolkata' }], videoCallData: { url: 'https://meet.google.com/abc-defg-hij' },
    metadata: { lead_event_id: 'lead-' + uid }, responses: { notes: { value: 'Company or project: Rao Estates\nWhatsApp: +91 98765 43210' } }
  }, extra || {});
  const raw = JSON.stringify({ triggerEvent: trigger, payload });
  return post('/api/cal-webhook', raw, { 'x-cal-signature-256': crypto.createHmac('sha256', 'whsec').update(raw).digest('hex') });
}
const inDays = (d, hour) => { const x = new Date(Date.now() + d * 86400000); x.setUTCHours(hour, 0, 0, 0); return x; };

test('5.4 a booking: Call Scheduled, a note, "WhatsApp follow-up" done, the evening reminder dated the day before; twice is one note', async () => {
  reset();
  const b = leadBody();
  await sendLead(b);
  const l = leads[0];
  const start = inDays(3, 10);
  assert.strictEqual((await hook('BOOKING_CREATED', 'bk-a', b.email, start.toISOString())).status, 200);
  await settle();
  assert.strictEqual(l.stage_id, STAGES['Call Scheduled']);
  assert.strictEqual(notesOf(l.id).filter(x => x.startsWith('Call booked for')).length, 1);
  assert.strictEqual(actsOf(l.id, 'WhatsApp follow-up')[0].done, true);
  assert.strictEqual(actsOf(l.id, 'WhatsApp follow-up')[0].feedback, 'Booked');
  const evening = actsOf(l.id, 'Personal message the evening before the call');
  assert.strictEqual(evening.length, 1);
  assert.strictEqual(evening[0].date_deadline, new Date(start.getTime() + 5.5 * 3600000 - 86400000).toISOString().slice(0, 10));
  assert.deepStrictEqual(await store.get('odoouid:' + l.id), { uid: 'bk-a', leadEventId: 'lead-bk-a' });

  await hook('BOOKING_CREATED', 'bk-a', b.email, start.toISOString()); // Cal.com sends it twice
  await settle();
  assert.strictEqual(notesOf(l.id).filter(x => x.startsWith('Call booked for')).length, 1);
});

test('5.4 the reminder day: the day before, or the call day itself at or after 8 pm the evening before', () => {
  const start = new Date('2026-11-12T10:00:00.000Z'); // 15:30 IST on 12 Nov
  assert.strictEqual(ol.reminderDay(start, new Date('2026-11-09T05:00:00.000Z')), '2026-11-11');
  assert.strictEqual(ol.reminderDay(start, new Date('2026-11-11T14:20:00.000Z')), '2026-11-11'); // 19:50 IST
  assert.strictEqual(ol.reminderDay(start, new Date('2026-11-11T14:40:00.000Z')), '2026-11-12'); // 20:10 IST
  assert.strictEqual(ol.reminderDay(start, new Date('2026-11-12T03:00:00.000Z')), '2026-11-12'); // the call day
});

test('5.4 a booking made in Cal.com with no lead: a new lead from the booking, stars 0 and "No form answers" without notes', async () => {
  reset();
  await hook('BOOKING_CREATED', 'bk-b', 'tester@example.com', inDays(2, 10).toISOString(), { responses: {}, metadata: { test: 'yes' } });
  await settle();
  assert.strictEqual(leads.length, 1);
  assert.strictEqual(leads[0].priority, '0');
  assert.ok(leads[0].description.includes('No form answers (booked in Cal.com)'));
  assert.strictEqual(leads[0].stage_id, STAGES['Call Scheduled']);
  assert.ok(leads[0].name.startsWith('[TEST] '));
});

test('5.5 moved: a note and the new date (a new reminder if it was done); cancelled: back to Replied, "Get the call booked" due today, evening reminder done', async () => {
  reset();
  const b = leadBody();
  await sendLead(b);
  const l = leads[0];
  await hook('BOOKING_CREATED', 'bk-c', b.email, inDays(4, 10).toISOString());
  await settle();

  const newStart = inDays(6, 10);
  await hook('BOOKING_RESCHEDULED', 'bk-c2', b.email, newStart.toISOString(), { rescheduleUid: 'bk-c' });
  await settle();
  assert.ok(notesOf(l.id).some(x => x.startsWith('Call moved to')));
  assert.strictEqual(actsOf(l.id, 'Personal message the evening before the call')[0].date_deadline, new Date(newStart.getTime() + 5.5 * 3600000 - 86400000).toISOString().slice(0, 10));
  assert.strictEqual((await store.get('odoouid:' + l.id)).uid, 'bk-c2');

  acts.forEach(x => { if (x.summary.startsWith('Personal message')) x.done = true; }); // done, then moved again
  await hook('BOOKING_RESCHEDULED', 'bk-c3', b.email, inDays(7, 10).toISOString());
  await settle();
  assert.strictEqual(acts.filter(x => x.summary.startsWith('Personal message') && !x.done).length, 1, 'a new reminder was added');

  await hook('BOOKING_CANCELLED', 'bk-c3', b.email, inDays(7, 10).toISOString());
  await settle();
  assert.ok(notesOf(l.id).includes('Call cancelled'));
  assert.strictEqual(l.stage_id, STAGES.Replied);
  const gb = actsOf(l.id, 'Get the call booked').filter(x => !x.done);
  assert.strictEqual(gb.length, 1);
  assert.ok([isoDay(0), isoDay(1)].includes(gb[0].date_deadline));
  assert.strictEqual(acts.filter(x => x.summary.startsWith('Personal message') && !x.done).length, 0);
  assert.ok(!sent.some(s => /moved|cancel/i.test(s.subject)), 'no email from us for a move or a cancel');
});

test('5.5 a cancel on a lost or won lead adds only a note; no lead found changes nothing', async () => {
  reset();
  const b = leadBody();
  await sendLead(b);
  leads[0].stage_id = STAGES['Deal Closed'];
  await hook('BOOKING_CANCELLED', 'bk-d', b.email, inDays(2, 10).toISOString());
  await settle();
  assert.strictEqual(leads[0].stage_id, STAGES['Deal Closed']);
  assert.ok(notesOf(leads[0].id).includes('Call cancelled'));
  const before = leads.length;
  await hook('BOOKING_CANCELLED', 'bk-e', 'nobody@example.com', inDays(2, 10).toISOString());
  await settle();
  assert.strictEqual(leads.length, before);
});

test('8.1 another event type is ignored by Odoo too', async () => {
  reset();
  await hook('BOOKING_CREATED', 'bk-f', 'tester@example.com', inDays(2, 10).toISOString(), { eventTypeId: 1234 });
  await settle();
  assert.strictEqual(leads.length, 0);
});

test('5.7 no times: that lead\'s "WhatsApp follow-up" becomes due today', async () => {
  reset();
  const b = leadBody();
  await sendLead(b);
  acts.find(x => x.summary === 'WhatsApp follow-up').date_deadline = '2020-01-01';
  const r = await post('/api/lead-signal', { kind: 'no_times', lead_event_id: b.lead_event_id });
  assert.strictEqual(r.status, 200);
  await settle();
  assert.strictEqual(acts.find(x => x.summary === 'WhatsApp follow-up').date_deadline, isoDay(0));
});

// ---------------- 5.8: Odoo problems ----------------
test('5.8 Odoo down: the booking and its email still work; one alert per person; a refused key alerts once a day', async () => {
  reset();
  odooDown = true;
  const b = leadBody();
  assert.strictEqual((await sendLead(b)).status, 200, 'the lead call still succeeds');
  await sleep(100);
  const alertsFor = () => sent.filter(s => s.subject === 'A lead could not go into Odoo');
  assert.strictEqual(alertsFor().length, 1);
  assert.ok(Buffer.from(alertsFor()[0].mime.split(/\r?\n\r?\n/).slice(1).join(' ').replace(/\s+/g, ''), 'base64').toString().length >= 0);
  await sendLead(Object.assign({}, b, { lead_event_id: uuid() }));
  await sleep(100);
  assert.strictEqual(alertsFor().length, 1, 'never a second email for the same person');

  const hookRes = await hook('BOOKING_CREATED', 'bk-g', b.email, inDays(2, 10).toISOString());
  assert.strictEqual(hookRes.status, 200, 'the webhook still replies fine');
  await settle();
  assert.strictEqual(alertsFor().length, 1, 'never a second email for the same person from the webhook');
});

// ---------------- 6: the signals ----------------
async function seedBooked(email) {
  const b = leadBody({ email });
  await sendLead(b);
  const l = leads[0];
  calBookings['bk-s'] = { uid: 'bk-s', status: 'accepted', metadata: { lead_event_id: 'lead-xyz', fbc: 'fb.1.1.abc', fbp: 'fb.1.1.def', client_ip: '1.2.3.4', client_user_agent: 'UA/1', test: 'yes' }, attendees: [{ name: 'Asha Rao', email }], bookingFieldsResponses: { notes: 'WhatsApp: +91 98765 43210' } };
  await store.set('odoouid:' + l.id, { uid: 'bk-s', leadEventId: 'lead-xyz' });
  metaCalls.length = 0; // the form's own Lead event is not what these tests count
  return l;
}
const run = async (tests) => (await post('/api/tracking-test', { action: 'odoo-check' }, { 'x-test-password': 'tp-secret' })).json();

test('6 Check Odoo now (tests): Qualified sends QualifiedAfterCall once to the Sandbox; Deal Closed sends Purchase; revenue 0 sends none and emails', async () => {
  reset();
  process.env.NEW_TRACKING = 'on';
  const l = await seedBooked('sig@example.com');
  await odoo.call('crm.lead', 'write', { ids: [l.id], vals: { stage_id: STAGES.Qualified } });
  const r1 = await run();
  assert.strictEqual(r1.result, 'done');
  assert.strictEqual(metaCalls.length, 1);
  const e = metaCalls[0].event;
  assert.ok(metaCalls[0].url.includes('/555000111/events'), 'the Sandbox Pixel');
  assert.strictEqual(metaCalls[0].body.test_event_code, 'TEST999');
  assert.strictEqual(e.event_name, 'QualifiedAfterCall');
  assert.strictEqual(e.event_id, 'lead-xyz-qualified');
  assert.strictEqual(e.action_source, 'system_generated');
  assert.ok(!e.event_source_url);
  assert.strictEqual(e.custom_data.content_name, 'Lead Conversion Clarity Call');
  const u = e.user_data;
  assert.deepStrictEqual(u.em, [crypto.createHash('sha256').update('sig@example.com').digest('hex')]);
  assert.deepStrictEqual(u.ph, [crypto.createHash('sha256').update('919876543210').digest('hex')]);
  assert.strictEqual(u.fbc, 'fb.1.1.abc'); assert.strictEqual(u.client_ip_address, '1.2.3.4'); assert.strictEqual(u.client_user_agent, 'UA/1');
  assert.ok(!JSON.stringify(e).includes('sig@example.com') && !JSON.stringify(e).includes('Asha'), 'nothing in clear');
  assert.ok(notesOf(l.id).includes('Sent to Meta: QualifiedAfterCall'));

  await run(); // moving back and forward sends nothing more
  assert.strictEqual(metaCalls.length, 1);

  await odoo.call('crm.lead', 'write', { ids: [l.id], vals: { stage_id: STAGES['Deal Closed'] } });
  await run();
  assert.strictEqual(metaCalls.length, 1, 'revenue 0: no Purchase');
  assert.ok(sent.some(s => s.subject === 'A won lead has no Expected Revenue'));

  l.expected_revenue = 1;
  const r3 = await run();
  assert.strictEqual(metaCalls.length, 2, JSON.stringify(r3));
  const p = metaCalls[1].event;
  assert.strictEqual(p.event_name, 'Purchase');
  assert.strictEqual(p.event_id, 'lead-xyz-won');
  assert.deepStrictEqual(p.custom_data, { value: 1, currency: 'INR', content_name: 'Enquiry-to-Site-Visit Engine' });
  assert.ok(notesOf(l.id).includes('Sent to Meta: Purchase ₹1'));
});

test('6 a lead without Lead Channel Meta Ads, or without a booking carrying lead_event_id, sends nothing', async () => {
  reset();
  const b = leadBody({ sv_attrib: {} });
  await sendLead(b);
  leads[0].stage_id = STAGES.Qualified; leads[0].name = '[TEST] No channel';
  metaCalls.length = 0;
  await run();
  assert.strictEqual(metaCalls.length, 0);

  const c = leadBody();
  await sendLead(c);
  const l = leads[1];
  l.stage_id = STAGES.Qualified;
  metaCalls.length = 0;
  calByEmail[c.email.toLowerCase()] = [{ uid: 'x', status: 'accepted', metadata: {}, attendees: [{ email: c.email, name: 'A' }] }];
  const r = await run();
  assert.strictEqual(metaCalls.length, 0);
  assert.ok(r.log.some(x => x.includes('no booking with lead_event_id')));
});

test('6 two runs at once send once; the lock is released after a run', async () => {
  reset();
  process.env.NEW_TRACKING = 'on';
  const l = await seedBooked('twice@example.com');
  await odoo.call('crm.lead', 'write', { ids: [l.id], vals: { stage_id: STAGES.Qualified } });
  await Promise.all([run(), run()]);
  assert.strictEqual(metaCalls.length, 1);
  assert.strictEqual(await store.get('odoo:signals-lock'), null);
});

test('6.2 the cron job: a wrong or missing CRON_SECRET is refused; on a preview it does nothing; production with NEW_TRACKING off sends nothing', async () => {
  reset();
  assert.strictEqual((await realFetch(base + '/api/cron/odoo-signals')).status, 401);
  assert.strictEqual((await realFetch(base + '/api/cron/odoo-signals', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const ok = await realFetch(base + '/api/cron/odoo-signals', { headers: { Authorization: 'Bearer cron-secret-1234567' } });
  assert.strictEqual((await ok.json()).result, 'production-only');

  process.env.VERCEL_ENV = 'production'; process.env.NEW_TRACKING = 'off';
  const l = await seedBooked('live@example.com');
  leads[0].name = 'Real Co (Real)';
  await odoo.call('crm.lead', 'write', { ids: [l.id], vals: { stage_id: STAGES.Qualified } });
  const off = await realFetch(base + '/api/cron/odoo-signals', { headers: { Authorization: 'Bearer cron-secret-1234567' } });
  assert.strictEqual((await off.json()).result, 'new-tracking-off');
  assert.strictEqual(metaCalls.length, 0);
  assert.ok((await store.get('odoo:lastrun')).at, 'a run that finds NEW_TRACKING off is a good run');
});

test('6.2 production never sends "[TEST]" leads or test bookings to the live Pixel', async () => {
  reset();
  process.env.VERCEL_ENV = 'production'; process.env.NEW_TRACKING = 'on';
  const l = await seedBooked('prodtest@example.com'); // name starts with [TEST] on a preview-made lead
  await odoo.call('crm.lead', 'write', { ids: [l.id], vals: { stage_id: STAGES.Qualified } });
  const live = await realFetch(base + '/api/cron/odoo-signals', { headers: { Authorization: 'Bearer cron-secret-1234567' } });
  assert.strictEqual((await live.json()).result, 'done');
  assert.strictEqual(metaCalls.length, 0);

  leads[0].name = 'Real Co (Real)'; // a real name, but the booking is marked test
  await realFetch(base + '/api/cron/odoo-signals', { headers: { Authorization: 'Bearer cron-secret-1234567' } });
  assert.strictEqual(metaCalls.length, 0, 'a test booking is skipped');

  delete calBookings['bk-s'].metadata.test; // a real booking: now it goes, to the live Pixel, with no test code
  await realFetch(base + '/api/cron/odoo-signals', { headers: { Authorization: 'Bearer cron-secret-1234567' } });
  assert.strictEqual(metaCalls.length, 1);
  assert.ok(metaCalls[0].url.includes('/999111222/events'));
  assert.ok(!('test_event_code' in metaCalls[0].body));
});

test('11 test page: QualifiedAfterCall and Purchase go to the Sandbox from the server, value 1, hashed', async () => {
  reset();
  for (const event of ['QualifiedAfterCall', 'Purchase']) {
    const r = await post('/api/tracking-test', { action: 'send', event, target: 'sandbox' }, { 'x-test-password': 'tp-secret' });
    const d = await r.json();
    assert.strictEqual(d.ok, true, JSON.stringify(d));
  }
  assert.strictEqual(metaCalls.length, 2);
  assert.strictEqual(metaCalls[1].event.custom_data.value, 1);
  assert.strictEqual(metaCalls[1].event.custom_data.currency, 'INR');
  assert.ok(metaCalls.every(c => c.url.includes('/555000111/events') && c.event.action_source === 'system_generated'));
  assert.ok(!JSON.stringify(metaCalls).includes('test-lead@example.com'.toUpperCase()));
});

test('4 the Odoo calls use JSON-2, named arguments, and nothing is ever deleted', async () => {
  reset();
  const b = leadBody();
  await sendLead(b);
  await hook('BOOKING_CREATED', 'bk-z', b.email, inDays(2, 10).toISOString());
  await settle();
  assert.ok(odooCalls.every(c => !['unlink', 'create'].includes(c.method) || ['crm.lead', 'utm.campaign'].includes(c.model)));
  assert.ok(!odooCalls.some(c => c.method === 'unlink'));
  assert.ok(!odooCalls.some(c => c.model === 'res.partner'));
  assert.ok(!odooCalls.some(c => c.model === 'crm.lead' && c.method === 'write' && ('partner_id' in c.a.vals || 'tag_ids' in c.a.vals)));
});
