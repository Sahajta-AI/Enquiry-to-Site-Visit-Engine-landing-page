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
let odooFail = null;
let leads, acts, notes, odooCalls, odooDown, seq, utmCampaigns, slowOnce, partners, tagExists;
function resetOdoo() { leads = []; acts = []; notes = []; odooCalls = []; odooDown = false; seq = 100; utmCampaigns = []; slowOnce = []; partners = []; tagExists = true; }
const SVC = 'x_studio_service_interested_in_1'; // Service Interested In (many2many to crm.tag); the Warm-Chain tag is 10
const WC = 10;
// many2many commands: [[4, id]] links one tag
function applyM2m(l, vals) {
  if (!Array.isArray(vals[SVC])) return;
  const cur = new Set(l[SVC] || []);
  vals[SVC].forEach(c => { if (Array.isArray(c) && c[0] === 4) cur.add(c[1]); else if (typeof c === 'number') cur.add(c); });
  l[SVC] = [...cur];
}
const likeRe = (v, flags) => new RegExp('^' + String(v).replace(/\\([\\%_])|([%_])|([.*+?^${}()|[\]\\])/g, (m, esc, wild, meta) => esc ? '\\' + esc : wild === '%' ? '.*' : wild === '_' ? '.' : '\\' + meta) + '$', flags);
resetOdoo();
const isoDay = (offset) => new Date(Date.now() + 5.5 * 3600000 + offset * 86400000).toISOString().slice(0, 10);
function addActs(lead, why) {
  if (lead.x_studio_lead_channel !== 'meta_ads') return;
  const [title, days] = why === 'restore' ? ['Came back: read the history first', 1] : ON_STAGE[lead.stage_id];
  acts.push({ id: ++seq, res_model: 'crm.lead', res_id: lead.id, summary: title, date_deadline: isoDay(days), done: false });
}
const val = (l, f) => f === 'email_normalized' ? ((l.email_from || l.email) ? (l.email_from || l.email).toLowerCase() : false) : f === 'phone_sanitized' ? (l.phone || false) : f === SVC ? (l[SVC] || []) : l[f];
function match(l, [f, op, v]) {
  const x = val(l, f);
  if (op === '=') return (v === false ? !x : x === v);
  if (op === 'in') return Array.isArray(x) ? v.some(id => x.includes(id)) : v.includes(x);
  if (op === '=ilike') return likeRe(v, 'i').test(String(x || ''));
  if (op === '>=') return String(x) >= String(v);
  if (op === '<=') return String(x) <= String(v);
  if (op === '!=') return x !== v;
  if (op === '=like') return new RegExp('^' + String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$').test(String(x));
  if (op === 'not like') return !String(x || '').includes(v);
  throw new Error('fake Odoo: operator ' + op);
}
function shape(l) {
  return Object.assign({}, l, {
    stage_id: [l.stage_id, stageName(l.stage_id)], lost_reason_id: l.lost_reason_id ? [l.lost_reason_id, 'Too expensive'] : false,
    user_id: [7, 'Shubhang Sethi'], email_normalized: l.email_from ? l.email_from.toLowerCase() : false,
    phone_sanitized: l.phone || false, partner_id: l.partner_id ? [l.partner_id, 'Contact'] : false, [SVC]: l[SVC] || [],
    expected_revenue: l.expected_revenue || 0, recurring_revenue: l.recurring_revenue || 0,
    won_status: l.active === false ? (Number(l.probability) > 0 ? 'pending' : 'lost') : l.stage_id === 6 ? 'won' : 'pending'
  });
}
function fakeOdoo(model, method, a) {
  odooCalls.push({ model, method, a });
  if (model === 'crm.stage' && method === 'search_read') { const n = a.domain[0][2]; return STAGES[n] ? [{ id: STAGES[n] }] : []; }
  if (model === 'crm.team') return [{ id: 1 }];
  if (model === 'res.users') return [{ id: 7 }];
  if (model === 'utm.source') return [{ id: 3 }];
  if (model === 'mail.activity.type') return [{ id: a.domain[0][2] === 'To-Do' ? 4 : 2 }];
  if (model === 'crm.tag') return tagExists && a.domain[0][2] === 'Warm-Chain System' ? [{ id: WC }] : [];
  if (model === 'crm.recurring.plan') return a.domain[0][2] === 'Monthly' ? [{ id: 1 }] : [];
  if (model === 'res.partner') {
    if (method === 'search_read') {
      let rows = partners.filter(x => x.active !== false && a.domain.every(d => match(x, d)));
      rows = rows.slice().sort((x, y) => x.id - y.id);
      return rows.slice(0, a.limit || 80).map(x => Object.assign({}, x, { parent_id: x.parent_id ? [x.parent_id, 'Company'] : false }));
    }
    if (method === 'create') { const c = Object.assign({ id: ++seq, active: true, create_date: new Date().toISOString().slice(0, 19).replace('T', ' ') }, a.vals_list[0]); partners.push(c); return [c.id]; }
    if (method === 'write') { a.ids.forEach(id => Object.assign(partners.find(x => x.id === id), a.vals)); return true; }
  }
  if (model === 'utm.campaign') {
    if (method === 'create') { const c = Object.assign({ id: ++seq }, a.vals_list[0]); utmCampaigns.push(c); return [c.id]; }
    const t = a.domain.find(d => d[0] === 'title');
    const c = utmCampaigns.find(x => x.title === t[2]); return c ? [{ id: c.id }] : [];
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
      const l = Object.assign({ id: ++seq, active: true, priority: '0', create_date: new Date().toISOString().slice(0, 19).replace('T', ' '), write_date: new Date().toISOString(), date_last_stage_update: new Date().toISOString().slice(0, 19).replace('T', ' ') }, v);
      delete l[SVC]; applyM2m(l, v);
      leads.push(l); addActs(l, 'stage'); return [l.id];
    }
    if (method === 'write') {
      a.ids.forEach(id => {
        const l = leads.find(x => x.id === id);
        const wasActive = l.active, oldStage = l.stage_id;
        const vals = Object.assign({}, a.vals); delete vals[SVC];
        Object.assign(l, vals); applyM2m(l, a.vals);
        if (a.vals.stage_id && a.vals.stage_id !== oldStage) {
          l.date_last_stage_update = new Date().toISOString().slice(0, 19).replace('T', ' ');
          if (a.vals.stage_id === 6) l.date_closed = l.date_last_stage_update;
          if (!(a.vals.active && !wasActive)) addActs(l, 'stage');
        }
        if (a.vals.active && !wasActive) { addActs(l, 'restore'); if (a.vals.stage_id && a.vals.stage_id !== oldStage) addActs(l, 'stage'); }
      });
      return true;
    }
    if (method === 'message_post') { notes.push({ mid: ++seq, id: a.ids[0], body: a.body, html: a.body_is_html, type: a.message_type, subtype: a.subtype_xmlid }); return 1; }
    if (method === 'activity_schedule') {
      acts.push({ id: ++seq, res_model: 'crm.lead', res_id: a.ids[0], summary: a.summary, date_deadline: a.date_deadline, done: false, typeId: a.activity_type_id, user: a.user_id, note: a.note });
      return true;
    }
  }
  if (model === 'mail.message' && method === 'search_read') {
    const want = Object.fromEntries(a.domain.map(d => [d[0], d[2]]));
    return notes.filter(n => want.model === 'crm.lead' && n.id === want.res_id).map(n => ({ id: n.mid, body: '<p>' + n.body + '</p>' }));
  }
  if (model === 'mail.activity') {
    if (method === 'search_read') {
      const ids = a.domain.find(d => d[0] === 'id');
      if (ids) return acts.filter(x => !x.done && ids[2].includes(x.id)).map(x => ({ id: x.id }));
      return acts.filter(x => !x.done && a.domain.every(d => match(x, d))).map(x => ({ id: x.id, summary: x.summary, date_deadline: x.date_deadline, res_id: x.res_id }));
    }
    if (method === 'unlink') { acts = acts.filter(x => !a.ids.includes(x.id)); return true; }
    if (method === 'write') { a.ids.forEach(id => Object.assign(acts.find(x => x.id === id), a.vals)); return true; }
    if (method === 'action_feedback') { a.ids.forEach(id => { const x = acts.find(y => y.id === id); x.done = true; x.feedback = a.feedback; }); return true; }
  }
  throw new Error(`fake Odoo: ${model}/${method}`);
}

// ---------------- the rest of the world ----------------
const sent = [], metaCalls = [], queued = [];
const threadsFake = {}; // threadId -> [{ id, from }]
const calCancels = [];
let gmailDown = false;
const calBookings = {}, calByEmail = {};
global.fetch = async (url, opts) => {
  url = String(url); opts = opts || {};
  if (url.startsWith('http://127.0.0.1')) return realFetch(url, opts);
  if (url.startsWith('https://odoo.example.test/json/2/')) {
    assert.strictEqual(opts.headers.Authorization, 'Bearer odoo_key');
    assert.strictEqual(opts.headers['X-Odoo-Database'], 'db1');
    if (odooDown) return json({ message: 'down' }, 500);
    const [model, method] = url.replace('https://odoo.example.test/json/2/', '').split('/');
    if (odooFail && odooFail(model, method)) return json({ message: 'refused' }, 400);
    let out;
    try { out = fakeOdoo(model, method, JSON.parse(opts.body)); } catch (e) { return json({ message: e.message }, 400); }
    // Saved in Odoo, but the reply comes too late: the website's call times out
    const slow = slowOnce.findIndex(x => x === model + '/' + method);
    if (slow >= 0) {
      slowOnce.splice(slow, 1);
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 300);
        if (opts.signal) opts.signal.addEventListener('abort', () => { clearTimeout(t); reject(opts.signal.reason); });
      });
    }
    return json(out);
  }
  if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'tok', expires_in: 3600 });
  if (url.endsWith('/messages/send')) {
    if (gmailDown) return json({ error: 'gmail down' }, 500);
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
  if (/api\.cal\.com\/v2\/bookings\/[^/?]+\/cancel$/.test(url) && opts.method === 'POST') {
    calCancels.push({ uid: decodeURIComponent(url.split('/').slice(-2)[0]), body: JSON.parse(opts.body) });
    return json({ status: 'success' });
  }
  if (/api\.cal\.com\/v2\/bookings\/[^?]+$/.test(url)) {
    const uid = decodeURIComponent(url.split('/').pop());
    return calBookings[uid] ? json({ data: calBookings[uid] }) : json({}, 404);
  }
  if (url.startsWith('https://api.cal.com/v2/bookings?') && !url.includes('sortCreated')) { // the plain search (has the person booked?)
    const email = decodeURIComponent(url.match(/attendeeEmail=([^&]+)/)[1]);
    return json({ data: calByEmail[email] || [] });
  }
  if (url.startsWith('https://api.cal.com/v2/bookings?')) {
    assert.ok(url.includes('sortCreated=desc'), 'newest first');
    const email = decodeURIComponent(url.match(/attendeeEmail=([^&]+)/)[1]);
    return json({ data: calByEmail[email] || [] });
  }
  if (url.includes('/v2/publish/')) { queued.push(JSON.parse(opts.body).jobId); return json({ messageId: 'q1' }); }
  if (/\/messages\/m\d+\?format=metadata/.test(url)) return json({ payload: { headers: [{ name: 'Message-ID', value: '<x@mail.gmail.com>' }] } });
  if (/\/threads\/t\d+/.test(url)) {
    const tid = url.match(/threads\/(t\d+)/)[1];
    const list = threadsFake[tid] || [{ id: 'm1' }];
    return json({ messages: list.map(m => ({ id: m.id, payload: { headers: [{ name: 'From', value: m.from || 'Shubhang Sethi <shubhang@sahajta.com>' }] } })) });
  }
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

function reset() { delete process.env.ODOO_V2; delete process.env.NUDGES_ENABLED; queued.length = 0; calCancels.length = 0; for (const k of Object.keys(threadsFake)) delete threadsFake[k]; resetOdoo(); sent.length = 0; metaCalls.length = 0; store._resetMemory(); odoo._reset(); for (const k of Object.keys(calBookings)) delete calBookings[k]; for (const k of Object.keys(calByEmail)) delete calByEmail[k]; delete process.env.NEW_TRACKING; delete process.env.VERCEL_ENV; }

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
const isFirstNote = (x) => /Agreed to be contacted:|No form answers/.test(x.body) && !/^(Filled the form again|Details changed|Came back)/.test(x.body);
const laterNotes = () => notes.filter(x => !isFirstNote(x));
// A new lead's details live only in its first log note (Shubhang, 14 Nov), never in the Notes field
const detailsOf = (l) => { assert.ok(!l.description, 'nothing in the Notes field'); const n = notes.find(x => x.id === l.id); return n ? n.body : ''; };
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
  assert.ok(detailsOf(l).includes(Q1_FIT) && detailsOf(l).includes(Q2_FIT) && detailsOf(l).includes('Good fit: yes'));
  assert.ok(detailsOf(l).includes('Test set') && detailsOf(l).includes('angle speed'));
  assert.ok(detailsOf(l).includes('Agreed to be contacted'));
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
  assert.ok(!detailsOf(l).includes('Test set'));
});

test('5.2 no ad keys: Lead Channel empty, "Website: no ad click found", no reminder, stars by answers', async () => {
  reset();
  const b = leadBody({ sv_attrib: {}, q1_situation: 'We are still planning or exploring', q2_urgency: 'I am only exploring right now' });
  await sendLead(b);
  const [l] = leadOf(b.email);
  assert.ok(!l.x_studio_lead_channel && !l.source_id);
  assert.ok(detailsOf(l).includes('Website: no ad click found'));
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
  assert.ok(detailsOf(leads[1]).startsWith('<p>Past client</p>'));
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
  return post('/api/cal-webhook', raw, { 'x-cal-signature-256': crypto.createHmac('sha256', 'whsec').update(raw).digest('hex') })
    .then(async r => { await require(path.join(tmp, 'lib', 'after.js'))._idle(); return r; });
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

test('webhook: replies first, then the email, then Odoo; a failing booking email never skips Odoo', async () => {
  reset();
  const b = leadBody();
  await sendLead(b);
  const l = leads[0];
  gmailDown = true;
  try {
    const r = await hook('BOOKING_CREATED', 'bk-mailfail', b.email, inDays(3, 10).toISOString());
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(await r.json(), { ok: true, result: 'accepted' }, 'the reply comes before the email');
    await settle();
  } finally { gmailDown = false; }
  assert.strictEqual(l.stage_id, STAGES['Call Scheduled'], 'Odoo was updated although the email failed');
  assert.strictEqual(notesOf(l.id).filter(x => x.startsWith('Call booked for')).length, 1);
});

test('5.3 a lead found by phone with no email gets the email: when reopening a lost lead, and from the booking webhook', async () => {
  reset();
  // a lost lead, phone only
  leads.push({ id: ++seq, name: '[TEST] Old Co (Old)', phone: '+919876543210', email_from: false, active: false, stage_id: STAGES.New, lost_reason_id: 9, x_studio_lead_channel: 'meta_ads', priority: '1' });
  const lost = leads[leads.length - 1];
  const b = leadBody({ email: 'phone-lost@example.com' });
  await sendLead(b);
  assert.strictEqual(lost.active, true, 'reopened');
  assert.strictEqual(lost.email_from, 'phone-lost@example.com', 'the email is added on reopen');

  // an open lead, phone only, then a booking made straight in Cal.com (no form)
  reset();
  leads.push({ id: ++seq, name: '[TEST] Open Co (Open)', phone: '+919876543210', email_from: false, active: true, stage_id: STAGES.New, x_studio_lead_channel: 'meta_ads', priority: '1' });
  const open = leads[leads.length - 1];
  await hook('BOOKING_CREATED', 'bk-phone', 'phone-open@example.com', inDays(3, 10).toISOString());
  await settle();
  assert.strictEqual(open.email_from, 'phone-open@example.com', 'the email is added from the booking');
  assert.strictEqual(open.stage_id, STAGES['Call Scheduled']);
});

test('5.4 a lost lead brought back by a booking from a Meta ad: Lead Channel becomes Meta Ads and its reminders are set', async () => {
  reset();
  leads.push({ id: ++seq, name: '[TEST] Lost Co (Lost)', email_from: 'lost-meta@example.com', phone: '+919876543210', active: false, stage_id: STAGES.New,
    lost_reason_id: 9, x_studio_lead_channel: false, priority: '1' });
  const l = leads[leads.length - 1];
  const callAt = inDays(3, 10);
  await hook('BOOKING_CREATED', 'bk-lost-meta', 'lost-meta@example.com', callAt.toISOString(),
    { metadata: { lead_event_id: 'lead-bk-lost-meta', utm_source: 'facebook', fbclid: 'abc', test: 'yes' } });
  await settle();
  assert.strictEqual(l.active, true, 'reopened');
  assert.strictEqual(l.x_studio_lead_channel, 'meta_ads');
  assert.strictEqual(l.stage_id, STAGES['Call Scheduled']);
  const evening = actsOf(l.id, 'Personal message the evening before the call').filter(a => !a.done);
  assert.strictEqual(evening.length, 1, 'one evening reminder');
  // the day before the call, in India time
  const dayBefore = new Date(callAt.getTime() + 5.5 * 3600000 - 86400000).toISOString().slice(0, 10);
  assert.strictEqual(evening[0].date_deadline, dayBefore, 'dated the evening before the call (the Meta Ads reminder step ran)');
});

test('5.4 a booking made in Cal.com with no lead: a new lead from the booking, stars 0 and "No form answers" without notes', async () => {
  reset();
  await hook('BOOKING_CREATED', 'bk-b', 'tester@example.com', inDays(2, 10).toISOString(), { responses: {}, metadata: { test: 'yes' } });
  await settle();
  assert.strictEqual(leads.length, 1);
  assert.strictEqual(leads[0].priority, '0');
  assert.ok(detailsOf(leads[0]).includes('No form answers (booked in Cal.com)'));
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

test('5.5 a cancel when the lead is no longer in Call Scheduled still marks the "evening before" reminder done', async () => {
  reset();
  const b = leadBody();
  await sendLead(b);
  const l = leads[0];
  await hook('BOOKING_CREATED', 'bk-q', b.email, inDays(3, 10).toISOString());
  await settle();
  assert.strictEqual(actsOf(l.id, 'Personal message the evening before the call').filter(a => !a.done).length, 1);
  l.stage_id = STAGES.Qualified; // Shubhang moved it on
  await hook('BOOKING_CANCELLED', 'bk-q', b.email, inDays(3, 10).toISOString());
  await settle();
  assert.strictEqual(l.stage_id, STAGES.Qualified, 'the stage is left alone');
  assert.ok(notesOf(l.id).includes('Call cancelled'));
  assert.strictEqual(actsOf(l.id, 'Personal message the evening before the call').filter(a => !a.done).length, 0, 'no open evening reminder');
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

test('6 a Meta lead with no email: Cal.com is never searched with a blank email, and nobody else\'s booking goes to Meta', async () => {
  reset();
  process.env.NEW_TRACKING = 'on';
  // a qualified Meta lead with a phone but no email, and no kept booking
  leads.push({ id: ++seq, name: '[TEST] Phone Only (Phone)', phone: '+919876543210', email_from: false, active: true, stage_id: STAGES.Qualified,
    x_studio_lead_channel: 'meta_ads', date_last_stage_update: new Date().toISOString().slice(0, 19).replace('T', ' ') });
  // what a blank search would wrongly return: someone else's booking
  calByEmail[''] = [{ uid: 'other', status: 'accepted', metadata: { lead_event_id: 'someone-else', test: 'yes' }, attendees: [{ name: 'Other Person', email: 'other@example.com' }] }];
  const calls = [];
  const orig = global.fetch;
  global.fetch = (url, opts) => { if (String(url).startsWith('https://api.cal.com/v2/bookings?')) calls.push(String(url)); return orig(url, opts); };
  try { await run(true); } finally { global.fetch = orig; }
  assert.strictEqual(calls.filter(u => /attendeeEmail=(&|$)/.test(u)).length, 0, 'no blank search');
  assert.strictEqual(metaCalls.length, 0, 'nothing sent to Meta');
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

test('6.2 the "not run for 2 days" alert: a test run never counts as a good run, and the check works with NEW_TRACKING off', async () => {
  reset();
  const signals = require(path.join(tmp, 'lib', 'odoosignals.js'));
  // a test run ("Check Odoo now") leaves no "good run" behind
  await signals.run({ tests: true });
  assert.strictEqual(await store.get('odoo:lastrun'), null, 'a test run is not a real run');
  // production, NEW_TRACKING off, the last real run 3 days ago: one alert
  process.env.VERCEL_ENV = 'production'; process.env.NEW_TRACKING = 'off';
  await store.set('odoo:lastrun', { at: Date.now() - 3 * 86400000 });
  await signals.checkHealth();
  assert.strictEqual(sent.filter(e => e.subject === 'The Odoo signal job has not run for 2 days').length, 1);
  // a real cron run (NEW_TRACKING off) counts again
  await signals.run({ tests: false });
  assert.ok(Date.now() - (await store.get('odoo:lastrun')).at < 5000);
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

test('4 a timeout after Odoo saved: the retry checks first, so one lead, one note, one reminder (no copies)', async () => {
  reset();
  odoo._setTimeoutMs(100);
  try {
    slowOnce = ['crm.lead/create', 'crm.lead/message_post'];
    const b = leadBody();
    assert.strictEqual((await sendLead(b)).status, 200);
    await settle();
    assert.strictEqual(leadOf(b.email).length, 1, 'one lead');
    const id = leadOf(b.email)[0].id;
    assert.strictEqual(notes.filter(n => n.id === id).length, 1, 'one details note');
    assert.strictEqual(odooCalls.filter(c => c.model === 'crm.lead' && c.method === 'create').length, 1, 'create sent once');

    slowOnce = ['crm.lead/message_post', 'crm.lead/activity_schedule'];
    await hook('BOOKING_CREATED', 'bk-slow', b.email, inDays(2, 10).toISOString());
    await settle(); await sleep(400);
    assert.strictEqual(notes.filter(n => n.id === id && /Call booked/.test(n.body)).length, 1, 'one "Call booked" note');
    assert.strictEqual(acts.filter(x => x.res_id === id && x.summary === 'Personal message the evening before the call' && !x.done).length, 1, 'one evening reminder');
  } finally {
    odoo._setTimeoutMs(8000);
  }
});

test('4 a timeout where Odoo did NOT save: the retry sends it again (one lead)', async () => {
  reset();
  odoo._setTimeoutMs(100);
  const realCreate = fakeOdoo;
  let dropped = false;
  try {
    // The first create is lost on the way (nothing saved, no reply)
    const orig = global.fetch;
    global.fetch = async (url, opts) => {
      if (!dropped && String(url).endsWith('/json/2/crm.lead/create')) {
        dropped = true;
        odooCalls.push({ model: 'crm.lead', method: 'create', a: JSON.parse(opts.body) });
        return new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason)));
      }
      return orig(url, opts);
    };
    try {
      const b = leadBody();
      assert.strictEqual((await sendLead(b)).status, 200);
      await settle(); await sleep(300);
      assert.strictEqual(leadOf(b.email).length, 1, 'the retry made the lead');
    } finally { global.fetch = orig; }
  } finally {
    odoo._setTimeoutMs(8000);
  }
  assert.ok(realCreate);
});

test('4 note check compares words, not HTML', () => {
  assert.strictEqual(odoo.plainText('<p>Call booked for <b>Mon</b>&nbsp;10 am<br>x &amp; y</p>'), odoo.plainText('Call booked for Mon 10 am<br>x &amp; y'));
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

// ---------------- ODOO_V2 (Notion "Odoo 0" to "Odoo 4"): only with the switch on ----------------
const v2on = () => { reset(); process.env.ODOO_V2 = '1'; };
const companies = () => partners.filter(x => x.is_company);
const people = () => partners.filter(x => !x.is_company);

test('V2 Odoo 1-3: a new lead gets the company and person Contacts (linked), the new title and the Warm-Chain tag', async () => {
  v2on();
  const b = leadBody();
  await sendLead(b);
  const [l] = leadOf(b.email);
  assert.strictEqual(l.name, '[TEST] Rao Estates – Warm-Chain System');
  assert.deepStrictEqual(l[SVC], [WC], 'the tag, found by name');
  assert.strictEqual(companies().length, 1);
  assert.strictEqual(people().length, 1);
  const [co] = companies(); const [pe] = people();
  assert.strictEqual(co.name, '[TEST] Rao Estates', 'test Contacts carry [TEST] too');
  assert.strictEqual(pe.name, '[TEST] Asha Rao');
  assert.strictEqual(pe.email, b.email.toLowerCase());
  assert.strictEqual(pe.phone, '+919876543210');
  assert.strictEqual(pe.parent_id, co.id, 'the person is the company\'s point of contact');
  assert.strictEqual(l.partner_id, pe.id, 'the lead\'s Contact is the person');
  assert.strictEqual(l.contact_name, 'Asha Rao');
  assert.strictEqual(l.partner_name, 'Rao Estates');
  assert.ok(!l.expected_revenue, 'no revenue before a booking');
  assert.ok(!odooCalls.some(c => ['crm.tag', 'res.partner'].includes(c.model) && c.method === 'create' && c.model === 'crm.tag'), 'the tag is never made');
});

test('V2 Odoo 4: a booking sets Expected Revenue and Recurring Revenues to 99,000, plan Monthly; same lead, no new Contact', async () => {
  v2on();
  const b = leadBody();
  await sendLead(b);
  await hook('BOOKING_CREATED', 'bk-v2a', b.email, inDays(2, 10).toISOString());
  await settle();
  assert.strictEqual(leads.length, 1);
  assert.strictEqual(partners.length, 2, 'no new Contact');
  const l = leads[0];
  assert.strictEqual(l.stage_id, STAGES['Call Scheduled']);
  assert.strictEqual(l.expected_revenue, 99000);
  assert.strictEqual(l.recurring_revenue, 99000);
  assert.strictEqual(l.recurring_plan, 1, 'Monthly, found by name');
});

test('V2 Odoo 4: an amount already in Expected Revenue or MRR is never overwritten by a booking; each is checked on its own', async () => {
  v2on();
  const email = 'paid' + (++n) + '@example.com';
  leads.push({ id: 80, name: '[TEST] Paid Co – Warm-Chain System', active: true, stage_id: 2, email_from: email, [SVC]: [WC], expected_revenue: 150000, partner_id: 999 });
  await hook('BOOKING_CREATED', 'bk-v2b', email, inDays(2, 10).toISOString());
  await settle();
  assert.strictEqual(leads[0].stage_id, STAGES['Call Scheduled']);
  assert.strictEqual(leads[0].expected_revenue, 150000, 'Expected Revenue kept');
  assert.strictEqual(leads[0].recurring_revenue, 99000, 'MRR was 0, so it is set');
  assert.strictEqual(leads[0].recurring_plan, 1);

  v2on();
  const email2 = 'mrr' + (++n) + '@example.com';
  leads.push({ id: 81, name: '[TEST] MRR Co – Warm-Chain System', active: true, stage_id: 2, email_from: email2, [SVC]: [WC], recurring_revenue: 45000, recurring_plan: 2, partner_id: 998 });
  await hook('BOOKING_CREATED', 'bk-v2c', email2, inDays(2, 10).toISOString());
  await settle();
  assert.strictEqual(leads[0].expected_revenue, 99000, 'Expected Revenue was 0, so it is set');
  assert.strictEqual(leads[0].recurring_revenue, 45000, 'MRR kept');
  assert.strictEqual(leads[0].recurring_plan, 2, 'its plan kept too');
});

test('V2 Odoo 1: the same email or phone again reuses the Contact and the lead; a saved email is never replaced', async () => {
  v2on();
  const b = leadBody({ whatsapp_number: '9811111111' });
  await sendLead(b);
  await sendLead(leadBody({ email: b.email, whatsapp_number: '9811111111' })); // a new visit, same email
  await sendLead(leadBody({ email: 'second' + (++n) + '@example.com', whatsapp_number: '9811111111' })); // same phone, other email
  assert.strictEqual(leads.length, 1, 'one lead');
  assert.strictEqual(partners.length, 2, 'one company and one person');
  assert.strictEqual(leads[0].email_from, b.email.toLowerCase(), 'the saved email stays');
});

test('V2 Odoo 1: a company is found ignoring capitals and extra spaces; a % or _ in a name is not a wildcard', async () => {
  v2on();
  partners.push({ id: 50, name: '[TEST] rao   ESTATES', is_company: true, active: true });
  partners.push({ id: 51, name: '[TEST] AxBy', is_company: true, active: true });
  await sendLead(leadBody({ company: '  Rao Estates ', whatsapp_number: '9822222222' }));
  assert.strictEqual(companies().length, 2, 'no new company');
  assert.strictEqual(people()[0].parent_id, 50);
  await sendLead(leadBody({ company: 'A_B%', name: 'Bina Shah', whatsapp_number: '9833333333' }));
  assert.strictEqual(companies().length, 3, '"A_B%" is a new company, not "AxBy"');
  assert.ok(companies().some(c => c.name === '[TEST] A_B%'), 'kept exactly as typed');
});

test('V2 Odoo 1: two people from the same company share the company Contact, each with their own lead', async () => {
  v2on();
  await sendLead(leadBody({ name: 'Asha Rao', whatsapp_number: '9844444444' }));
  await sendLead(leadBody({ name: 'Ravi Kumar', whatsapp_number: '9855555555' }));
  assert.strictEqual(companies().length, 1);
  assert.strictEqual(people().length, 2);
  assert.strictEqual(leads.length, 2);
  assert.notStrictEqual(leads[0].partner_id, leads[1].partner_id);
  assert.ok(people().every(p => p.parent_id === companies()[0].id));
});

test('V2 Odoo 1: a lead for another service is left untouched (a new Warm-Chain lead is made); one with no service is used and tagged', async () => {
  v2on();
  const email = 'svc' + (++n) + '@example.com';
  leads.push({ id: 60, name: '[TEST] Website job', active: true, stage_id: 1, email_from: email, [SVC]: [5], priority: '1' });
  await sendLead(leadBody({ email, whatsapp_number: '9866666666' }));
  const hand = leads.find(l => l.id === 60);
  assert.deepStrictEqual(hand[SVC], [5]);
  assert.ok(!hand.partner_id && hand.name === '[TEST] Website job', 'untouched');
  assert.ok(notes.every(x => x.id !== 60), 'no note on it');
  const wc = leads.find(l => l.id !== 60);
  assert.deepStrictEqual(wc[SVC], [WC]);
  assert.strictEqual(wc.partner_id, people()[0].id, 'the same Contact');

  v2on();
  const email2 = 'nosvc' + (++n) + '@example.com';
  leads.push({ id: 61, name: '[TEST] Hand made', active: true, stage_id: 1, email_from: email2, priority: '1' });
  await sendLead(leadBody({ email: email2, whatsapp_number: '9877777777' }));
  assert.strictEqual(leads.length, 1, 'used, not a new lead');
  assert.deepStrictEqual(leads[0][SVC], [WC], 'tagged');
  assert.ok(leads[0].partner_id, 'its empty Contact is filled');
  assert.strictEqual(leads[0].name, '[TEST] Hand made', 'a hand-made title is not changed');
});

test('V2 Odoo 1: several open leads: the Warm-Chain one wins; an open lead wins over a Lost one; a Lost one is reopened with the new title', async () => {
  v2on();
  const email = 'multi' + (++n) + '@example.com';
  leads.push({ id: 62, name: '[TEST] Old WC', active: true, stage_id: 1, email_from: email, [SVC]: [WC], partner_id: 900 });
  leads.push({ id: 63, name: '[TEST] Newer none', active: true, stage_id: 1, email_from: email });
  leads.push({ id: 64, name: '[TEST] Lost one', active: false, stage_id: 2, email_from: email, lost_reason_id: 1 });
  const visitBody = leadBody({ email, whatsapp_number: '9888888888' });
  await sendLead(visitBody);
  assert.deepStrictEqual(await store.get('odoovisit:' + visitBody.lead_event_id), { leadId: 62, kind: 'again' }, 'the Warm-Chain lead is used');
  assert.ok(!notes.some(x => x.id === 62), 'Odoo 13: no note when the form is sent again (it comes with "didn\'t book")');
  assert.ok(!leads.find(l => l.id === 63)[SVC], 'the other open lead is untouched');
  assert.strictEqual(leads.find(l => l.id === 64).active, false, 'the Lost one stays Lost');

  v2on();
  const email2 = 'lost' + (++n) + '@example.com';
  leads.push({ id: 65, name: '[TEST] Old title (x)', active: false, stage_id: 2, email_from: email2, lost_reason_id: 1 });
  leads.push({ id: 66, name: '[TEST] Other service lost', active: false, stage_id: 2, email_from: email2, [SVC]: [3], lost_reason_id: 1, date_closed: '2099-01-01 00:00:00' });
  await sendLead(leadBody({ email: email2, whatsapp_number: '9899999999' }));
  const back = leads.find(l => l.id === 65);
  assert.strictEqual(back.active, true, 'reopened');
  assert.strictEqual(back.name, '[TEST] Rao Estates – Warm-Chain System');
  assert.deepStrictEqual(back[SVC], [WC]);
  assert.ok(back.partner_id);
  assert.strictEqual(leads.find(l => l.id === 66).active, false, 'a Lost lead for another service is never reopened');
});

test('V2 Odoo 1-2: Back with a changed company updates the title; a blank company is refused by the server and changes nothing', async () => {
  v2on();
  const b = leadBody({ whatsapp_number: '9810101010' });
  await sendLead(b);
  const r = await post('/api/lead', Object.assign({}, b, { company: '' }));
  await settle();
  assert.strictEqual(r.status, 400, 'a blank company never reaches Odoo');
  assert.strictEqual(leads[0].partner_name, 'Rao Estates');
  await sendLead(Object.assign({}, b, { company: 'Rao  Homes', q2_urgency: 'I am only exploring right now' }));
  assert.strictEqual(leads.length, 1);
  assert.strictEqual(leads[0].name, '[TEST] Rao Homes – Warm-Chain System');
  assert.strictEqual(leads[0].partner_name, 'Rao Homes', 'extra spaces trimmed');
  assert.strictEqual(leads[0].priority, '2', 'the new answer counts');
});

test('V2: a Contact that fails never fails the lead; a missing tag still makes the lead and alerts once', async () => {
  v2on();
  const b = leadBody({ whatsapp_number: '9820202020' });
  odooFail = (model) => model === 'res.partner'; // Odoo refuses every Contact call
  try { await sendLead(b); } finally { odooFail = null; }
  assert.strictEqual(leadOf(b.email).length, 1, 'the lead is still made');
  assert.ok(!leadOf(b.email)[0].partner_id);
  assert.deepStrictEqual(leadOf(b.email)[0][SVC], [WC], 'and still tagged');

  v2on();
  tagExists = false;
  const b2 = leadBody({ whatsapp_number: '9830303030' });
  await sendLead(b2);
  assert.strictEqual(leadOf(b2.email).length, 1);
  assert.ok(!(leadOf(b2.email)[0][SVC] || []).length);
  assert.strictEqual(sent.filter(s => s.subject === 'The Warm-Chain System tag is missing in Odoo').length, 1);
});

test('V2 Odoo 0: only our own reminders, by exact title, and only on a Warm-Chain lead, can ever be removed', async () => {
  v2on();
  leads.push({ id: 70, name: '[TEST] W', active: true, stage_id: 3, [SVC]: [WC] });
  leads.push({ id: 71, name: '[TEST] Hand', active: true, stage_id: 3 });
  for (const id of [70, 71]) {
    acts.push({ id: ++seq, res_model: 'crm.lead', res_id: id, summary: 'WhatsApp: call-day reminder', date_deadline: isoDay(0), done: false });
    acts.push({ id: ++seq, res_model: 'crm.lead', res_id: id, summary: 'Send the proposal', date_deadline: isoDay(0), done: false });
  }
  await assert.rejects(odoo.removeOurReminders(70, ['Send the proposal']), /Not one of our reminders/);
  assert.strictEqual(await odoo.removeOurReminders(71, ['WhatsApp: call-day reminder']), 0, 'a lead without the tag is never touched');
  assert.strictEqual(await odoo.removeOurReminders(70, ['WhatsApp: call-day reminder']), 1);
  assert.deepStrictEqual(acts.filter(x => x.res_id === 70).map(x => x.summary), ['Send the proposal']);
  assert.strictEqual(acts.filter(x => x.res_id === 71).length, 2);
});

test('V2 Odoo 4: Proposal Sent makes one to-do due today (To-Do type); not again after it is done; not on a lead without the tag; nothing with V2 off', async () => {
  v2on();
  const b = leadBody({ whatsapp_number: '9840404040' });
  await sendLead(b);
  const l = leads[0];
  leads.push({ id: 72, name: '[TEST] Hand', active: true, stage_id: 1 });
  await odoo.call('crm.lead', 'write', { ids: [l.id, 72], vals: { stage_id: STAGES['Proposal Sent'] } });
  const todos = () => acts.filter(x => x.summary === 'Update Expected Revenue and MRR to the proposal amount');
  await run();
  assert.strictEqual(todos().length, 1);
  assert.strictEqual(todos()[0].res_id, l.id);
  assert.strictEqual(todos()[0].date_deadline, isoDay(0));
  assert.strictEqual(todos()[0].typeId, 4, 'To-Do');
  await run();
  assert.strictEqual(todos().length, 1, 'no copy while it is open');
  todos()[0].done = true;
  await run();
  assert.strictEqual(todos().length, 1, 'done stays done');

  reset(); // V2 off
  await sendLead(leadBody({ whatsapp_number: '9850505050' }));
  await odoo.call('crm.lead', 'write', { ids: [leads[0].id], vals: { stage_id: STAGES['Proposal Sent'], [SVC]: [[4, WC]] } });
  await run();
  assert.strictEqual(todos().length, 0);
  assert.ok(!odooCalls.some(c => c.model === 'crm.tag'), 'with V2 off the tag is never even looked up');
});

// ---------------- ODOO_V2 step 3 (Notion "Odoo 5", "Odoo 6", "Odoo 8" to "Odoo 11") ----------------
const BOOK_NOTES = 'Company or project: Rao Estates\nWhatsApp: +91 98765 43210\nWhat\'s happening right now: We run paid ads but leads go cold because follow-up is slow\nWhen they\'d want it running: As soon as possible';
const adMeta = (uid, over) => Object.assign({ lead_event_id: 'lead-' + uid, consent_at: '2026-11-21T04:02:00.000Z', utm_source: 'fb', utm_content: 'TC1.4.01 | IMG9 | TG1-CP2-A4 | 21Nov26 [L:5cnx8-01]', utm_campaign: 'TC1.0' }, over || {});
const bookV2 = (uid, email, startIso, over) => hook('BOOKING_CREATED', uid, email, startIso, Object.assign({ metadata: adMeta(uid), responses: { notes: { value: BOOK_NOTES } } }, over || {}));
const openActs = (id) => acts.filter(x => x.res_id === id && !x.done);
const titlesOf = (id) => openActs(id).map(x => x.summary).sort();
const dayOf = (d) => new Date(d.getTime() + 5.5 * 3600000).toISOString().slice(0, 10);

test('V2 Odoo 8: a booked call: one "Call booked" note with the details, the 3 reminders, old follow-ups removed (never Done) with one note', async () => {
  v2on();
  process.env.NEW_TRACKING = 'on';
  const b = leadBody({ whatsapp_number: '9860606060' });
  await sendLead(b);
  const l = leads[0];
  assert.strictEqual(notes.filter(x => x.id === l.id).length, 0, 'no note when the form is sent');
  assert.deepStrictEqual(titlesOf(l.id), ['WhatsApp follow-up'], 'Odoo\'s own rule (still on until go-live) added its old follow-up');
  const start = inDays(3, 10);
  await bookV2('bk-v3a', b.email, start.toISOString());
  await settle();
  const booked = notes.filter(x => x.id === l.id && x.body.startsWith('Call booked: '));
  assert.strictEqual(booked.length, 1);
  const lines = booked[0].body.split('<br>');
  assert.match(lines[0], /^Call booked: \w{3} \d{1,2} \w{3}, \d{1,2}:\d{2} (am|pm)$/);
  assert.deepStrictEqual(lines.slice(1), [
    'Situation: We run ads, but leads go cold because follow-up is slow', 'Timeline: As soon as possible', 'Fit: Good',
    'Source: Meta ad IMG9 (TG1-CP2-A4), ad set TC1.4, campaign TC1.0', 'Consent: Sat 21 Nov, 9:32 am'
  ]);
  assert.ok(notes.some(x => x.id === l.id && x.body === 'Booked a call: no WhatsApp follow-up needed'));
  assert.deepStrictEqual(titlesOf(l.id), ['After the call: update the stage', 'WhatsApp: call-day reminder', 'WhatsApp: personal message (evening before the call)']);
  const by = (t) => openActs(l.id).find(x => x.summary === t);
  assert.strictEqual(by('WhatsApp: personal message (evening before the call)').date_deadline, dayOf(new Date(start.getTime() - 86400000)));
  assert.strictEqual(by('WhatsApp: call-day reminder').date_deadline, dayOf(start));
  assert.strictEqual(by('After the call: update the stage').date_deadline, dayOf(start));
  assert.match(by('WhatsApp: personal message (evening before the call)').note, /Send around 7–8 pm\. Confirm the time and share the Meet link\./);
  assert.match(by('WhatsApp: call-day reminder').note, /Send in the morning\./);
  assert.match(by('After the call: update the stage').note, /Held: Qualified, or Lost \(Junk\)\. Missed: back to Replied\. Never rebooks: Lost \(No-show\)\./);
  assert.strictEqual(by('After the call: update the stage').typeId, 4, 'To-Do');
  assert.ok(!acts.some(x => x.done), 'nothing ever marked Done');
  assert.ok(!odooCalls.some(c => c.method === 'action_feedback'));
  assert.strictEqual(leads[0].expected_revenue, 99000);
  await bookV2('bk-v3a', b.email, start.toISOString()); // the same webhook again
  await settle();
  assert.strictEqual(notes.filter(x => x.id === l.id && x.body.startsWith('Call booked: ')).length, 1);
  assert.strictEqual(openActs(l.id).length, 3, 'no second set');
});

test('V2 Odoo 8: an organic lead (no ad) gets the same reminders; the Source line says Website', async () => {
  v2on();
  const b = leadBody({ whatsapp_number: '9870707070', sv_attrib: {} });
  await sendLead(b);
  await hook('BOOKING_CREATED', 'bk-v3b', b.email, inDays(3, 10).toISOString(), { responses: { notes: { value: BOOK_NOTES } } });
  await settle();
  const l = leads[0];
  assert.strictEqual(openActs(l.id).length, 3);
  assert.ok(notes.some(x => x.id === l.id && x.body.includes('Source: Website (no ad click)')));
});

test('V2 Odoo 8: reminder timing: booked the evening before (after 8 pm) or on the call day skips reminder 1; on the call day, "as soon as you see this"', async () => {
  v2on();
  leads.push({ id: 90, name: '[TEST] T', active: true, stage_id: 3, [SVC]: [WC] });
  const lead = { id: 90, user_id: [7, 'Shubhang Sethi'] };
  const start = new Date('2026-11-27T10:05:00.000Z'); // Fri 27 Nov, 3:35 pm IST
  await ol._ensureCallReminders(lead, start, new Date('2026-11-26T15:00:00.000Z')); // Thu 8:30 pm IST
  assert.deepStrictEqual(titlesOf(90), ['After the call: update the stage', 'WhatsApp: call-day reminder']);
  assert.match(openActs(90).find(x => x.summary === 'WhatsApp: call-day reminder').note, /Send in the morning/);
  acts = [];
  await ol._ensureCallReminders(lead, start, new Date('2026-11-27T03:00:00.000Z')); // Fri 8:30 am IST: the call day
  assert.deepStrictEqual(titlesOf(90), ['After the call: update the stage', 'WhatsApp: call-day reminder']);
  assert.match(openActs(90).find(x => x.summary === 'WhatsApp: call-day reminder').note, /Send as soon as you see this\. Remind them of today&#39;s call time\./);
  acts = [];
  await ol._ensureCallReminders(lead, start, new Date('2026-11-26T13:00:00.000Z')); // Thu 6:30 pm IST
  assert.strictEqual(openActs(90).length, 3, 'before 8 pm the evening before: all three');
});

test('V2 Odoo 9: a moved call: one "Call moved: old → new" note; the reminders follow the new time; one Shubhang marked Done is made again', async () => {
  v2on();
  const b = leadBody({ whatsapp_number: '9880808080' });
  await sendLead(b);
  const first = inDays(3, 10); const later = inDays(5, 6);
  await bookV2('bk-v3c', b.email, first.toISOString());
  await settle();
  const l = leads[0];
  openActs(l.id).find(x => x.summary === 'WhatsApp: call-day reminder').done = true; // Shubhang marked it Done
  await hook('BOOKING_RESCHEDULED', 'bk-v3c2', b.email, later.toISOString(), { rescheduleUid: 'bk-v3c', rescheduleStartTime: first.toISOString(), metadata: adMeta('bk-v3c2'), responses: { notes: { value: BOOK_NOTES } } });
  await settle();
  const moved = notes.filter(x => x.id === l.id && x.body.startsWith('Call moved'));
  assert.strictEqual(moved.length, 1);
  assert.match(moved[0].body, /^Call moved: \w{3} \d{1,2} \w{3}, \d{1,2}:\d{2} (am|pm) → \w{3} \d{1,2} \w{3}, \d{1,2}:\d{2} (am|pm)$/);
  assert.strictEqual(openActs(l.id).length, 3);
  assert.ok(openActs(l.id).every(x => x.date_deadline === dayOf(later) || (x.summary.includes('evening') && x.date_deadline === dayOf(new Date(later.getTime() - 86400000)))), 'all at the new dates');
  assert.ok(openActs(l.id).some(x => x.summary === 'WhatsApp: call-day reminder'), 'the Done one is made again for the new time');
  assert.strictEqual(leads[0].stage_id, STAGES['Call Scheduled']);
  assert.strictEqual(leads[0].expected_revenue, 99000);
});

test('V2 Odoo 11: a cancelled call: one note (by them / by you, reason when given), call reminders removed, back to Replied, revenue kept, one rebook reminder', async () => {
  v2on();
  const b = leadBody({ whatsapp_number: '9890909090' });
  await sendLead(b);
  await bookV2('bk-v3d', b.email, inDays(3, 10).toISOString());
  await settle();
  const l = leads[0];
  await hook('BOOKING_CANCELLED', 'bk-v3d', b.email, inDays(3, 10).toISOString(), { cancellationReason: 'Something came up', cancelledBy: b.email, organizer: { email: 'shubhang@sahajta.com' } });
  await settle();
  const c = notes.filter(x => x.id === l.id && x.body.startsWith('Call cancelled'));
  assert.strictEqual(c.length, 1);
  assert.deepStrictEqual(c[0].body.split('<br>').slice(1), ['Cancelled by: them', 'Reason: Something came up']);
  assert.deepStrictEqual(titlesOf(l.id), ['WhatsApp: get the call rebooked'], 'the call reminders are gone, one rebook reminder');
  assert.ok(!acts.some(x => x.done), 'none marked Done');
  assert.strictEqual(leads[0].stage_id, STAGES.Replied);
  assert.strictEqual(leads[0].expected_revenue, 99000, 'revenue stays');
  assert.match(openActs(l.id)[0].note, /They cancelled the call\. WhatsApp them to book a new time\./);

  v2on();
  const b2 = leadBody({ whatsapp_number: '9801010101' });
  await sendLead(b2);
  await bookV2('bk-v3e', b2.email, inDays(3, 10).toISOString());
  await hook('BOOKING_CANCELLED', 'bk-v3e', b2.email, inDays(3, 10).toISOString(), { cancelledBy: 'shubhang@sahajta.com', organizer: { email: 'Shubhang@sahajta.com' } });
  await settle();
  const c2 = notes.filter(x => x.body.startsWith('Call cancelled'));
  assert.deepStrictEqual(c2[0].body.split('<br>').slice(1), ['Cancelled by: you'], 'no Reason line when none was given');
  assert.deepStrictEqual(titlesOf(leads[0].id), ['WhatsApp: get the call rebooked'], 'also when Shubhang cancelled');
});

test('V2 Odoo 6: emails Gmail accepted go into the lead\'s log once ("Email sent: …", a blank line, the full text); not for a lead without the tag; nothing with V2 off', async () => {
  v2on();
  const b = leadBody({ whatsapp_number: '9812121212' });
  await sendLead(b);
  await bookV2('bk-v3f', b.email, inDays(3, 10).toISOString());
  await settle();
  const l = leads[0];
  const logged = notes.filter(x => x.id === l.id && x.body.startsWith('Email sent: '));
  assert.strictEqual(logged.length, 1, 'the booking email, once');
  assert.match(logged[0].body, /^Email sent: Your Lead Conversion Clarity Call is scheduled for .*<br><br>Hi Asha, it’s Shubhang/);
  assert.ok(logged[0].body.includes('<br>'), 'line breaks kept');

  assert.strictEqual(await ol.logEmail({ key: 'nudge1:x1', email: b.email, test: true, subject: 'One step left', text: 'Line 1\nLine 2 <b>' }), 'logged');
  assert.ok(notes.some(x => x.id === l.id && x.body === 'Email sent: One step left<br><br>Line 1<br>Line 2 &lt;b&gt;'));
  assert.strictEqual(await ol.logEmail({ key: 'nudge1:x1', email: b.email, test: true, subject: 'One step left', text: 'again' }), 'duplicate');
  leads.push({ id: 95, name: '[TEST] Hand', active: true, stage_id: 1, email_from: 'hand@example.com' });
  assert.strictEqual(await ol.logEmail({ key: 'nudge1:x2', email: 'hand@example.com', test: true, subject: 's', text: 't' }), 'no-lead', 'a lead without the tag gets nothing');

  reset();
  const before = odooCalls.length;
  assert.strictEqual(await ol.logEmail({ key: 'nudge1:x3', email: b.email, test: true, subject: 's', text: 't' }), 'off');
  assert.strictEqual(odooCalls.length, before);
});

test('V2 Odoo 6: a booking made straight in Cal.com (no lead yet): the booking email is logged once the lead is made', async () => {
  v2on();
  const email = 'direct' + (++n) + '@example.com';
  await hook('BOOKING_CREATED', 'bk-v3g', email, inDays(3, 10).toISOString());
  await settle();
  const [l] = leadOf(email);
  assert.ok(l, 'a lead was made from the booking');
  assert.strictEqual(notes.filter(x => x.id === l.id && x.body.startsWith('Email sent: ')).length, 1);
  assert.strictEqual(l.name, '[TEST] Rao Estates – Warm-Chain System');
});

test('V2 Odoo 10: a Warm-Chain lead marked Lost loses our open reminders (no note, none Done); others are untouched', async () => {
  v2on();
  leads.push({ id: 96, name: '[TEST] Lost WC', active: false, stage_id: 2, [SVC]: [WC], write_date: new Date().toISOString().slice(0, 19).replace('T', ' ') });
  leads.push({ id: 97, name: '[TEST] Lost hand', active: false, stage_id: 2, write_date: new Date().toISOString().slice(0, 19).replace('T', ' ') });
  for (const id of [96, 97]) {
    acts.push({ id: ++seq, res_model: 'crm.lead', res_id: id, summary: 'WhatsApp: call-day reminder', date_deadline: isoDay(0), done: false });
    acts.push({ id: ++seq, res_model: 'crm.lead', res_id: id, summary: 'Send the proposal', date_deadline: isoDay(0), done: false });
  }
  await run();
  assert.deepStrictEqual(titlesOf(96), ['Send the proposal'], 'only ours removed');
  assert.strictEqual(openActs(97).length, 2, 'a lead without the tag is untouched');
  assert.ok(!notes.some(x => [96, 97].includes(x.id)), 'no note');
});

test('V2 Odoo 6: the Source line', () => {
  process.env.NEW_TRACKING = 'on';
  assert.strictEqual(ol.sourceLine({ utm_source: 'fb', utm_content: 'TC1.4.01 | IMG9 | TG1-CP2-A4 | 21Nov26 [L:5cnx8-01]', utm_campaign: 'TC1.0' }),
    'Source: Meta ad IMG9 (TG1-CP2-A4), ad set TC1.4, campaign TC1.0');
  assert.strictEqual(ol.sourceLine({ utm_source: 'fb', utm_content: 'TC1.4.01 | IMG9 | TG1-CP2-A4', utm_campaign: 'TC1.0', angle: 'speed' }),
    'Source: Meta ad IMG9 (TG1-CP2-A4), ad set TC1.4, campaign TC1.0, angle: speed');
  // Shubhang (22 Nov): the ad number can be "TC1.4.1" or "TC1.4.01"; ad set and campaign names are "TC1.4 | …", "TC1.0 | …"
  for (const num of ['TC1.4.1', 'TC1.4.01']) {
    assert.strictEqual(ol.sourceLine({ utm_source: 'fb', utm_content: `${num} | IMG9 | TG1-CP2-A4 | 21Nov26 [L:5cnx8-01]`, utm_campaign: 'TC1.0' }),
      'Source: Meta ad IMG9 (TG1-CP2-A4), ad set TC1.4, campaign TC1.0', num);
  }
  assert.strictEqual(ol.sourceLine({ utm_source: 'fb', utm_content: 'TC1.4.1 | IMG9 | TG1-CP2-A4', utm_term: 'TC1.4 | Builders | Mumbai', utm_campaign: 'TC1.0 | Warm-Chain | Nov' }),
    'Source: Meta ad IMG9 (TG1-CP2-A4), ad set TC1.4, campaign TC1.0', 'the part before the first " | "');
  assert.strictEqual(ol.sourceLine({}), 'Source: Website (no ad click)');
  assert.strictEqual(ol.sourceLine({}, true), 'Source: Meta ad', 'a Meta lead whose booking has no ad details');
  process.env.NEW_TRACKING = 'off';
  assert.strictEqual(ol.sourceLine({ utm_source: 'fb', utm_content: 'TC1.4.01 | IMG9 | TG1-CP2-A4' }), 'Source: Meta ad', 'no ad names while NEW_TRACKING is off');
  delete process.env.NEW_TRACKING;
});

// ---------------- ODOO_V2 step 4 (Notion "Odoo 7", "Odoo 13", "Odoo 14", "Odoo 15") ----------------
const tasksMod = require(path.join(tmp, 'lib', 'tasks.js'));
const leadsMod = require(path.join(tmp, 'lib', 'leads.js'));
const signal = async (kind, id) => { const r = await (await post('/api/lead-signal', { kind, lead_event_id: id })).json(); await settle(); return r.result; };
const notesStarting = (id, head) => notes.filter(x => x.id === id && x.body.startsWith(head));
const leaveEmailsToShubhang = () => sent.filter(x => /^(Didn.t book|No times shown)/.test(x.subject));

test('V2 Odoo 7: left without booking, nudges off: one "Filled the form, didn\'t book" note with the details and a follow-up reminder today; no email to Shubhang; booking later notes it once', async () => {
  v2on();
  process.env.NEW_TRACKING = 'on';
  const b = leadBody({ whatsapp_number: '9823232323' });
  await sendLead(b);
  const l = leads[0];
  assert.strictEqual(await signal('didnt_book', b.lead_event_id), 'noted');
  const n = notesStarting(l.id, 'Filled the form, didn&#39;t book');
  assert.strictEqual(n.length, 1);
  const lines = n[0].body.split('<br>');
  assert.deepStrictEqual(lines.slice(1, 4), ['Situation: We run ads, but leads go cold because follow-up is slow', 'Timeline: As soon as possible', 'Fit: Good']);
  assert.match(lines[4], /^Source: Meta ad/);
  assert.match(lines[5], /^Consent: \w{3} \d{1,2} \w{3}, \d{1,2}:\d{2} (am|pm)$/);
  const f = openActs(l.id).filter(x => x.summary === 'WhatsApp: follow up (didn\'t book)');
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].date_deadline, isoDay(0));
  assert.match(f[0].note, /No nudge emails went to them\. WhatsApp them to get the call booked\./);
  assert.strictEqual(leaveEmailsToShubhang().length, 0, 'no "Didn\'t book" email: it is all in Odoo');

  await bookV2('bk-v4a', b.email, inDays(3, 10).toISOString());
  await settle();
  assert.strictEqual(notes.filter(x => x.id === l.id && x.body === 'Booked a call: no WhatsApp follow-up needed').length, 1);
  assert.ok(!openActs(l.id).some(x => x.summary === 'WhatsApp: follow up (didn\'t book)'), 'the follow-up reminder is removed');
  assert.ok(!acts.some(x => x.done));
});

test('V2 (25 Nov, lead 142): a reply to the nudge removes our open "follow up (didn\'t book)" reminder (never Done); a hand-made reminder stays', async () => {
  v2on();
  process.env.NUDGES_ENABLED = '1';
  const email = 'replyfu' + (++n) + '@example.com';
  const b1 = leadBody({ email, whatsapp_number: '9822223333' });
  await sendLead(b1);
  assert.strictEqual(await signal('didnt_book', b1.lead_event_id), 'noted+nudges');
  await settle();
  const id = leads.find(l => l.email_from === email).id;
  const b2 = leadBody({ email, whatsapp_number: '9822223333' });
  await sendLead(b2);
  assert.strictEqual(await signal('didnt_book', b2.lead_event_id), 'noted-again');
  await settle();
  const follow = () => openActs(id).filter(x => x.summary === 'WhatsApp: follow up (didn\'t book)');
  assert.strictEqual(follow().length, 1, 'the same-day second visit left a follow-up');
  acts.push({ id: ++seq, res_model: 'crm.lead', res_id: id, summary: 'WhatsApp: second follow-up (no reply)', date_deadline: isoDay(1), done: false });

  const code = (await store.get('nudgelead:' + b1.lead_event_id)).code;
  await store.update('nudge:' + code, { nudge1: { sentAt: Date.now(), gmailId: 'm80', threadId: 't80' }, nudge2: { sentAt: Date.now(), gmailId: 'm81' } });
  threadsFake.t80 = [{ id: 'm80' }, { id: 'm81' }, { id: 'm82', from: 'Asha Rao <' + email + '>' }];
  assert.strictEqual(await tasksMod.runNudgeCheck(code), 'replied');
  await settle();
  assert.strictEqual(follow().length, 0, 'our follow-up is removed');
  assert.ok(!acts.some(x => x.done), 'never marked Done');
  assert.ok(openActs(id).some(x => x.summary === 'WhatsApp: second follow-up (no reply)'), 'a hand-made reminder is never touched');
  assert.strictEqual(notes.filter(x => x.id === id && x.body === 'Replied to the nudge email: no WhatsApp follow-up needed').length, 1);
});

test('V2 Odoo 7: with nudges: no reminder now; the day after nudge 2: no booking and no reply -> follow-up reminder; a reply -> a note, then "Reply to their email" if Shubhang hasn\'t answered', async () => {
  for (const scenario of ['no-reply', 'replied-unanswered', 'replied-answered', 'booked']) {
    v2on();
    process.env.NUDGES_ENABLED = '1';
    const b = leadBody({ whatsapp_number: '9834343434' });
    await sendLead(b);
    const l = leads[0];
    assert.strictEqual(await signal('didnt_book', b.lead_event_id), 'noted+nudges', scenario);
    assert.strictEqual(notesStarting(l.id, 'Filled the form, didn&#39;t book').length, 1);
    assert.ok(!openActs(l.id).some(x => x.summary === 'WhatsApp: follow up (didn\'t book)'), 'no reminder while the nudges run');
    const code = (await store.get('nudgelead:' + b.lead_event_id)).code;
    await store.update('nudge:' + code, { nudge1: { sentAt: Date.now(), gmailId: 'm70', threadId: 't70' }, nudge2: { sentAt: Date.now(), gmailId: 'm71' }, booked: scenario === 'booked' });
    threadsFake.t70 = [{ id: 'm70' }, { id: 'm71' }];
    if (scenario !== 'no-reply') threadsFake.t70.push({ id: 'm72', from: 'Asha Rao <' + b.email + '>' });
    if (scenario === 'replied-answered') threadsFake.t70.push({ id: 'm73', from: 'Shubhang Sethi <shubhang@sahajta.com>' });
    const r = await tasksMod.runNudgeCheck(code);
    const follow = () => openActs(l.id).filter(x => x.summary === 'WhatsApp: follow up (didn\'t book)');
    if (scenario === 'no-reply') {
      assert.strictEqual(r, 'reminder');
      assert.strictEqual(follow().length, 1);
      assert.match(follow()[0].note, /Both nudge emails went, no booking and no reply\. WhatsApp them to get the call booked\./);
      assert.strictEqual(await tasksMod.runNudgeCheck(code), 'duplicate');
    } else if (scenario === 'booked') {
      assert.strictEqual(r, 'booked');
      assert.strictEqual(follow().length, 0);
    } else {
      assert.strictEqual(r, 'replied');
      assert.strictEqual(follow().length, 0, 'no follow-up reminder after a reply');
      assert.ok(notes.some(x => x.id === l.id && x.body === 'Replied to the nudge email: no WhatsApp follow-up needed'));
      const rr = await tasksMod.runReplyCheck(code);
      const replyTodo = openActs(l.id).filter(x => x.summary === 'Reply to their email');
      if (scenario === 'replied-answered') { assert.strictEqual(rr, 'answered'); assert.strictEqual(replyTodo.length, 0); } else {
        assert.strictEqual(rr, 'reminder'); assert.strictEqual(replyTodo.length, 1); assert.ok(!replyTodo[0].note, 'no description');
      }
    }
  }
});

test('V2 Odoo 7: the 2-hour check: queued with the form; no booking -> the "didn\'t book" steps once; a booking in Cal.com -> nothing', async () => {
  v2on();
  const b = leadBody({ whatsapp_number: '9845454545' });
  await sendLead(b);
  const jobs = await Promise.all(queued.map(id => store.get('job:' + id)));
  const check = jobs.find(j => j && j.kind === 'didnt-book-check');
  assert.ok(check && check.payload.key === b.lead_event_id, 'queued when the form was sent');
  assert.ok(Math.abs(check.runAt - (Date.now() + 2 * 3600 * 1000)) < 60000, 'for 2 hours later');
  assert.strictEqual(await leadsMod.runDidntBookCheck(b.lead_event_id), 'noted');
  await settle();
  assert.strictEqual(notesStarting(leads[0].id, 'Filled the form, didn&#39;t book').length, 1);
  assert.strictEqual(await signal('didnt_book', b.lead_event_id), 'duplicate', 'the real signal later does nothing more');
  assert.strictEqual(await leadsMod.runDidntBookCheck(b.lead_event_id), 'duplicate');

  v2on();
  const b2 = leadBody({ whatsapp_number: '9856565656' });
  await sendLead(b2);
  calByEmail[b2.email] = [{ uid: 'x', createdAt: new Date().toISOString(), start: inDays(2, 10).toISOString(), status: 'accepted' }];
  assert.strictEqual(await leadsMod.runDidntBookCheck(b2.lead_event_id), 'skipped:booked');
  await settle();
  assert.strictEqual(notes.length, 0);

  reset(); // V2 off: never queued
  await sendLead(leadBody({ whatsapp_number: '9867676767' }));
  const offJobs = await Promise.all(queued.map(id => store.get('job:' + id)));
  assert.ok(!offJobs.some(j => j && j.kind === 'didnt-book-check'));
});

test('V2 Odoo 13 (Shubhang, 24 Nov): a second visit the same day without booking still gets its "filled again" note, once, and no new nudges', async () => {
  v2on();
  process.env.NUDGES_ENABLED = '1';
  const email = 'sameday' + (++n) + '@example.com';
  const b1 = leadBody({ email, whatsapp_number: '9811112222' });
  await sendLead(b1);
  assert.strictEqual(await signal('didnt_book', b1.lead_event_id), 'noted+nudges');
  await settle();
  const id = leads.find(l => l.email_from === email).id;
  assert.strictEqual(notesStarting(id, 'Filled the form, didn&#39;t book').length, 1);

  const b2 = leadBody({ email, whatsapp_number: '9811112222' });
  await sendLead(b2);
  assert.strictEqual(leads.filter(l => l.email_from === email).length, 1, 'same lead');
  assert.strictEqual(await signal('didnt_book', b2.lead_event_id), 'noted-again');
  await settle();
  assert.strictEqual(notesStarting(id, 'Filled the form again, didn&#39;t book').length, 1);
  assert.ok(!(await store.get('nudgelead:' + b2.lead_event_id)), 'no new nudges');
  assert.strictEqual(await signal('didnt_book', b2.lead_event_id), 'duplicate', 'the same visit again: nothing more');
  assert.strictEqual(await leadsMod.runDidntBookCheck(b2.lead_event_id), 'duplicate', 'its 2-hour check: nothing more');
  await settle();
  assert.strictEqual(notesStarting(id, 'Filled the form again, didn&#39;t book').length, 1);
});

test('V2 Odoo 13: fills the form again: no note now; didn\'t book -> "Filled the form again, didn\'t book" + follow-up today, no new nudges; call already booked -> a note and "Check why they filled the form again"', async () => {
  v2on();
  process.env.NUDGES_ENABLED = '1';
  const email = 'again' + (++n) + '@example.com';
  leads.push({ id: 110, name: '[TEST] Rao Estates – Warm-Chain System', active: true, stage_id: 2, email_from: email, [SVC]: [WC], partner_id: 990 });
  acts.push({ id: ++seq, res_model: 'crm.lead', res_id: 110, summary: 'WhatsApp: follow up (didn\'t book)', date_deadline: isoDay(-3), done: false, note: 'old' });
  const b = leadBody({ email, whatsapp_number: '9878787878' });
  await sendLead(b);
  assert.strictEqual(notes.length, 0, 'no note when the form is sent again');
  assert.strictEqual(await signal('didnt_book', b.lead_event_id), 'noted-again');
  const nn = notesStarting(110, 'Filled the form again, didn&#39;t book');
  assert.strictEqual(nn.length, 1);
  assert.ok(!nn[0].body.includes('Consent:'));
  const f = openActs(110).filter(x => x.summary === 'WhatsApp: follow up (didn\'t book)');
  assert.strictEqual(f.length, 1, 'the open one is moved, not copied');
  assert.strictEqual(f[0].date_deadline, isoDay(0));
  assert.match(f[0].note, /Filled the form again but didn&#39;t book\. WhatsApp them to get the call booked\./);
  assert.ok(!(await store.get('nudgelead:' + b.lead_event_id)), 'no new nudges');

  v2on();
  const email2 = 'againbooked' + (++n) + '@example.com';
  leads.push({ id: 111, name: '[TEST] Rao Estates – Warm-Chain System', active: true, stage_id: 3, email_from: email2, [SVC]: [WC], partner_id: 991 });
  const callAt = inDays(2, 10);
  calByEmail[email2] = [{ uid: 'y', createdAt: new Date().toISOString(), start: callAt.toISOString(), status: 'accepted' }];
  const b2 = leadBody({ email: email2, whatsapp_number: '9889898989' });
  await sendLead(b2);
  const c = notesStarting(111, 'Filled the form again (call already booked: ');
  assert.strictEqual(c.length, 1);
  assert.deepStrictEqual(titlesOf(111), ['Check why they filled the form again']);
  assert.strictEqual(await signal('didnt_book', b2.lead_event_id), 'skipped:call-booked');
  assert.strictEqual(notes.filter(x => x.id === 111).length, 1, 'nothing more');
});

test('V2 Odoo 14: a Lost lead comes back: reopened with one "Came back (was Lost: …, on …)" note and "Came back: read the history first" today; a past client gets a new lead, its to-do and "Past client" first', async () => {
  v2on();
  const email = 'back' + (++n) + '@example.com';
  leads.push({ id: 120, name: '[TEST] Old (x)', active: false, stage_id: 2, email_from: email, lost_reason_id: 1, date_closed: '2026-11-21 04:00:00' });
  const b = leadBody({ email, whatsapp_number: '9890101010' });
  await sendLead(b);
  const l = leads.find(x => x.id === 120);
  assert.strictEqual(l.active, true);
  assert.strictEqual(l.stage_id, STAGES.New);
  const cb = notesStarting(120, 'Came back (was Lost: Too expensive, on Sat 21 Nov)');
  assert.strictEqual(cb.length, 1);
  assert.ok(cb[0].body.includes('Situation: We run ads, but leads go cold because follow-up is slow'));
  const r = openActs(120).filter(x => x.summary === 'Came back: read the history first');
  assert.strictEqual(r.length, 1, 'one, even though Odoo\'s own rule (on until go-live) may add its copy too') ;
  assert.ok(!acts.some(x => x.done), 'nothing marked Done');

  v2on();
  const email2 = 'past' + (++n) + '@example.com';
  leads.push({ id: 121, name: '[TEST] Won deal', active: true, stage_id: 6, email_from: email2, [SVC]: [WC] });
  const b2 = leadBody({ email: email2, whatsapp_number: '9801212121' });
  await sendLead(b2);
  const nl = leads.find(x => x.id !== 121);
  assert.ok(nl && nl.name === '[TEST] Rao Estates – Warm-Chain System', 'a new Warm-Chain lead');
  assert.deepStrictEqual(titlesOf(nl.id).filter(x => x.startsWith('Past client')), ['Past client is back: check what they need']);
  await signal('didnt_book', b2.lead_event_id);
  const first = notes.filter(x => x.id === nl.id)[0];
  assert.match(first.body, /^Past client<br>Filled the form, didn&#39;t book<br>/);
});

test('V2 Odoo 15: Back with changed details: no note, the Contact takes the latest details; open times didn\'t load: one note, one reminder, no email, and no "didn\'t book" steps after it', async () => {
  v2on();
  const b = leadBody({ whatsapp_number: '9812343434' });
  await sendLead(b);
  await sendLead(Object.assign({}, b, { name: 'Asha R. Rao', company: 'Rao Homes' }));
  assert.ok(!notes.some(x => /Details changed/.test(x.body)), 'no "Details changed" note');
  const person = partners.find(x => x.id === leads[0].partner_id);
  assert.strictEqual(person.name, '[TEST] Asha R. Rao');
  assert.strictEqual(partners.find(x => x.id === person.parent_id).name, '[TEST] Rao Homes');
  assert.strictEqual(leads[0].name, '[TEST] Rao Homes – Warm-Chain System');

  v2on();
  process.env.NUDGES_ENABLED = '1';
  const b2 = leadBody({ whatsapp_number: '9823454545' });
  await sendLead(b2);
  const l = leads[0];
  assert.strictEqual(await signal('no_times', b2.lead_event_id), 'noted');
  await settle();
  assert.strictEqual(notesStarting(l.id, 'Couldn&#39;t see open times on the booking form').length, 1);
  assert.deepStrictEqual(titlesOf(l.id).filter(x => x.startsWith('WhatsApp: share')), ['WhatsApp: share open times (the booking form didn\'t load)']);
  assert.strictEqual(leaveEmailsToShubhang().length, 0, 'no "No times shown" email');
  assert.strictEqual(await leadsMod.runDidntBookCheck(b2.lead_event_id), 'skipped:no-times', 'the 2-hour check');
  assert.strictEqual(await signal('didnt_book', b2.lead_event_id), 'duplicate', 'and the real signal after it');
  assert.ok(!notes.some(x => x.body.startsWith('Filled the form')), 'no "didn\'t book" note');
  assert.ok(!(await store.get('nudgelead:' + b2.lead_event_id)), 'no nudges');
});

// ---------------- ODOO_V2 step 5 (Notion "Odoo 12" and "Test bookings") ----------------
const tb = require(path.join(tmp, 'lib', 'testbookings.js'));
const signalsMod = require(path.join(tmp, 'lib', 'odoosignals.js'));
const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 19).replace('T', ' ');
const jobsQueued = async () => (await Promise.all(queued.map(id => store.get('job:' + id)))).filter(Boolean);

test('V2 Test bookings: a TEST_EMAILS booking is cancelled 1 hour later ("Cancelled by: you", no rebook reminder); a real booking never is', async () => {
  v2on();
  const tester = 'tester@example.com';
  await hook('BOOKING_CREATED', 'bk-t1', tester, inDays(3, 10).toISOString());
  await settle();
  const job = (await jobsQueued()).find(j => j.kind === 'test-cancel');
  assert.ok(job && job.payload.key === 'bk-t1', 'queued');
  assert.ok(Math.abs(job.runAt - (Date.now() + 3600000)) < 60000, '1 hour after booking');
  calBookings['bk-t1'] = { uid: 'bk-t1', status: 'accepted', attendees: [{ name: 'Tester', email: tester }] };
  assert.strictEqual(await tb.runCancel('bk-t1'), 'cancelled');
  assert.deepStrictEqual(calCancels.map(c => c.uid), ['bk-t1']);
  assert.strictEqual(await tb.runCancel('bk-t1'), 'duplicate', 'once');
  await hook('BOOKING_CANCELLED', 'bk-t1', tester, inDays(3, 10).toISOString(), { cancellationReason: 'Test booking, cancelled automatically after 1 hour', organizer: { email: 'shubhang@sahajta.com' } });
  await settle();
  const c = notes.filter(x => x.body.startsWith('Call cancelled'));
  assert.strictEqual(c.length, 1);
  assert.ok(c[0].body.includes('Cancelled by: you'));
  assert.ok(!acts.some(x => x.summary === 'WhatsApp: get the call rebooked' && !x.done), 'no rebook reminder for a test booking');

  // a real person's booking: never queued, and never cancelled even if asked
  v2on();
  await hook('BOOKING_CREATED', 'bk-t2', 'real' + (++n) + '@example.com', inDays(3, 10).toISOString());
  await settle();
  assert.ok(!(await jobsQueued()).some(j => j.kind === 'test-cancel'));
  calBookings['bk-t2'] = { uid: 'bk-t2', status: 'accepted', attendees: [{ name: 'Real', email: 'someone@example.com' }] };
  assert.strictEqual(await tb.runCancel('bk-t2'), 'skipped:not-a-test-booking');
  calBookings['bk-t3'] = { uid: 'bk-t3', status: 'cancelled', attendees: [{ email: tester }] };
  assert.strictEqual(await tb.runCancel('bk-t3'), 'skipped:cancelled');
  assert.strictEqual(calCancels.length, 0);

  reset(); // V2 off: nothing
  await hook('BOOKING_CREATED', 'bk-t4', tester, inDays(3, 10).toISOString());
  await settle();
  assert.ok(!(await jobsQueued()).some(j => j.kind === 'test-cancel'));
  assert.strictEqual(await tb.runCancel('bk-t4'), 'off');
});

test('V2 Test bookings: [TEST] leads and test Contacts older than 24 hours are archived (never deleted), never shown as Lost; real ones and newer ones are untouched', async () => {
  v2on();
  leads.push({ id: 130, name: '[TEST] Old zero', active: true, stage_id: 1, probability: 0, create_date: daysAgo(2) });
  leads.push({ id: 131, name: '[TEST] Old twenty', active: true, stage_id: 3, probability: 20, create_date: daysAgo(2) });
  leads.push({ id: 132, name: '[TEST] Fresh', active: true, stage_id: 1, probability: 10, create_date: daysAgo(0.1), partner_id: 140 });
  leads.push({ id: 133, name: 'Real Co – Warm-Chain System', active: true, stage_id: 1, probability: 10, create_date: daysAgo(5) });
  partners.push({ id: 140, name: '[TEST] Kept person', is_company: false, active: true, parent_id: 142, create_date: daysAgo(3) });
  partners.push({ id: 141, name: '[TEST] Old person', is_company: false, active: true, create_date: daysAgo(3) });
  partners.push({ id: 142, name: '[TEST] Kept company', is_company: true, active: true, create_date: daysAgo(3) });
  partners.push({ id: 143, name: '[TEST] Old company', is_company: true, active: true, create_date: daysAgo(3) });
  partners.push({ id: 144, name: 'Real person', is_company: false, active: true, create_date: daysAgo(30) });
  await run();
  const L = (id) => leads.find(l => l.id === id);
  assert.strictEqual(L(130).active, false);
  assert.strictEqual(L(130).probability, 1, 'kept above 0, so it is not Lost');
  assert.strictEqual(shape(L(130)).won_status, 'pending');
  assert.strictEqual(L(131).active, false);
  assert.strictEqual(L(131).probability, 20);
  assert.strictEqual(L(132).active, true, 'less than 24 hours old');
  assert.strictEqual(L(133).active, true, 'a real lead is never touched');
  const P = (id) => partners.find(p => p.id === id);
  assert.strictEqual(P(141).active, false);
  assert.strictEqual(P(143).active, false);
  assert.strictEqual(P(140).active, true, 'still linked to an open test lead');
  assert.strictEqual(P(142).active, true, 'the company of a kept test person');
  assert.strictEqual(P(144).active, true, 'a real Contact is never touched');
  assert.ok(!odooCalls.some(c => c.method === 'unlink'), 'nothing deleted');
  assert.ok(!odooCalls.some(c => c.method === 'write' && c.a.vals && 'lost_reason_id' in c.a.vals), 'never marked Lost');
});

test('V2 Odoo 12: the 8 am safety net gives "Next step: plan what\'s next for this lead" only to open Warm-Chain leads with no open reminder that aren\'t waiting on a planned step', async () => {
  v2on();
  const old = daysAgo(1);
  const mk = (id, extra) => leads.push(Object.assign({ id, name: `[TEST] L${id}`, active: true, stage_id: 2, [SVC]: [WC], create_date: old, email_from: `l${id}@example.com` }, extra || {}));
  mk(150); // no reminder: gets one
  mk(151); acts.push({ id: ++seq, res_model: 'crm.lead', res_id: 151, summary: 'Any reminder', date_deadline: isoDay(2), done: false });
  mk(152); await store.set('odoowait:l152@example.com', 1); // in the nudge sequence
  mk(153, { create_date: new Date(Date.now() - 3600000).toISOString().slice(0, 19).replace('T', ' ') }); // made an hour ago
  mk(154, { stage_id: 6 }); // won
  mk(155, { [SVC]: [] }); // hand-made, no tag
  mk(156, { active: false }); // lost
  leads.push({ id: 157, name: 'Real – Warm-Chain System', active: true, stage_id: 2, [SVC]: [WC], create_date: old }); // a real lead, not in a test run
  const r = await (await post('/api/tracking-test', { action: 'odoo-daily' }, { 'x-test-password': 'tp-secret' })).json();
  assert.strictEqual(r.result, 'done');
  const made = acts.filter(x => x.summary === 'Next step: plan what\'s next for this lead');
  assert.deepStrictEqual(made.map(x => x.res_id), [150]);
  assert.strictEqual(made[0].date_deadline, isoDay(0));
  assert.strictEqual(made[0].typeId, 4);
  assert.ok(!made[0].note, 'no description');
  assert.strictEqual(notes.length, 0, 'no note');
  await post('/api/tracking-test', { action: 'odoo-daily' }, { 'x-test-password': 'tp-secret' });
  assert.strictEqual(acts.filter(x => x.summary === 'Next step: plan what\'s next for this lead').length, 1, 'no copy');

  assert.strictEqual((await signalsMod.dailySafetyNet({ tests: false })).result, 'production-only', 'the real run only on production');
  assert.strictEqual((await realFetch(base + '/api/cron/odoo-daily')).status, 401, 'the cron route needs CRON_SECRET');
  reset(); // V2 off
  const off = await (await realFetch(base + '/api/cron/odoo-daily', { headers: { Authorization: 'Bearer cron-secret-1234567' } })).json();
  assert.strictEqual(off.result, 'off');
  assert.strictEqual(odooCalls.length, 0, 'not one Odoo call with the switch off');
});

test('Go-live catch-up: the preview only reads; hand-set leads, other services, old and Won leads are never written; only the named leads get only what they miss, once', async () => {
  v2on();
  const catchup = require(path.join(tmp, 'lib', 'catchup.js'));
  const recent = daysAgo(1);
  const callAt = new Date(Date.now() + 3 * 86400000);
  const mk = (id, extra) => leads.push(Object.assign({ id, active: true, stage_id: 3, create_date: recent, email_from: `c${id}@example.com`, [SVC]: [] }, extra));
  mk(200, { name: '[TEST] Acme (Asha)', partner_name: 'Acme', contact_name: 'Asha', phone: '+919876543210' }); // website lead, nothing set up, a call booked
  calByEmail['c200@example.com'] = [{ uid: 'bk-c200', status: 'accepted', start: callAt.toISOString() }];
  mk(201, { name: '[TEST] Hand (Set)', partner_name: 'Hand', contact_name: 'Set' }); // on the hand-set list
  mk(202, { name: '[TEST] Web (Dev)', [SVC]: [3] }); // another service
  mk(203, { name: '[TEST] Old (Lead)', partner_name: 'Old', contact_name: 'Lead', create_date: '2026-10-01 10:00:00' }); // before the website
  mk(204, { name: '[TEST] Done – Warm-Chain System', [SVC]: [WC], partner_id: 9, expected_revenue: 99000, recurring_revenue: 99000 });
  acts.push({ id: ++seq, res_model: 'crm.lead', res_id: 204, summary: 'Call: confirm the time', date_deadline: isoDay(2), done: false });
  mk(205, { name: '[TEST] Won (Lead)', partner_name: 'Won', contact_name: 'Lead', stage_id: 6 });
  mk(206, { name: '[TEST] My own title', partner_name: 'Own', contact_name: 'Title', stage_id: 1 }); // not booked, title typed by hand
  const before = JSON.stringify(leads.filter(l => l.id !== 200 && l.id !== 206));
  const opts = { tests: true, handSet: [201] };

  const from = odooCalls.length;
  const p = await catchup.preview(opts);
  assert.deepStrictEqual([...new Set(odooCalls.slice(from).map(c => c.method))], ['search_read'], 'the preview only reads');
  assert.strictEqual(calCancels.length, 0);
  assert.deepStrictEqual(p.handSet.map(x => x.id), [201]);
  assert.deepStrictEqual(p.toDo.map(x => x.id), [200, 206]);
  assert.deepStrictEqual(p.nothingToDo.map(x => x.id), [204]);
  assert.ok(p.nothingToDo[0].warnings.some(w => w.includes('Call: confirm the time')), 'a hand-made reminder title is flagged');
  assert.strictEqual(p.otherService, 1);
  assert.strictEqual(p.beforeSite, 1);
  assert.deepStrictEqual(p.toDo[0].steps.map(s => s.kind), ['tag', 'title', 'contact', 'revenue', 'reminders']);
  assert.deepStrictEqual(p.toDo[1].steps.map(s => s.kind), ['tag', 'contact'], 'not booked: no revenue, no reminders; a hand-typed title stays');

  await assert.rejects(catchup.apply([201], opts), /never written/);
  const log = await catchup.apply([200, 202, 204, 205], opts);
  assert.ok(log[0].startsWith('200: done'));
  assert.ok(log.slice(1).every(x => x.includes('skipped')));
  const l = leads.find(x => x.id === 200);
  assert.deepStrictEqual(l[SVC], [WC]);
  assert.strictEqual(l.name, '[TEST] Acme – Warm-Chain System');
  assert.strictEqual(l.expected_revenue, 99000);
  assert.strictEqual(l.recurring_revenue, 99000);
  assert.strictEqual(l.recurring_plan, 1);
  const person = partners.find(x => x.id === l.partner_id);
  assert.strictEqual(person.email, 'c200@example.com');
  assert.ok(person.name.startsWith('[TEST] '));
  assert.deepStrictEqual(acts.filter(x => x.res_id === 200).map(x => x.summary).sort(), [ol.R.after, ol.R.callDay, ol.R.evening].sort());
  assert.strictEqual(JSON.stringify(leads.filter(x => x.id !== 200 && x.id !== 206)), before, 'nothing else written');
  assert.ok(!leads.find(x => x.id === 206)[SVC].length, 'a lead not named is not written');
  assert.ok(!odooCalls.some(c => c.method === 'unlink' || c.method === 'action_feedback'), 'nothing removed or marked Done');
  assert.strictEqual(notes.length, 0);

  const again = await catchup.preview(opts);
  assert.deepStrictEqual(again.toDo.map(x => x.id), [206], 'lead 200 has nothing left to do');
  const partnersBefore = partners.length;
  assert.ok((await catchup.apply([200], opts))[0].includes('nothing to do'));
  assert.strictEqual(acts.filter(x => x.res_id === 200).length, 3, 'no copy');
  assert.strictEqual(partners.length, partnersBefore, 'no second Contact');
});

test('V2 SMS/Call (Shubhang, 23 Nov): "SMS/Call: …" reminders count as our "WhatsApp: …" ones: moved, never doubled, removed on cancel and Lost; new ones keep "SMS/Call:"; any other title untouched', async () => {
  v2on();
  const b = leadBody({ whatsapp_number: '9870707070' });
  await sendLead(b);
  const first = inDays(3, 10); const later = inDays(5, 6);
  await bookV2('bk-sms1', b.email, first.toISOString());
  await settle();
  const l = leads[0];
  // Set up by hand for a lead not on WhatsApp
  for (const x of openActs(l.id)) x.summary = x.summary.replace(/^WhatsApp: /, 'SMS/Call: ');
  acts.push({ id: ++seq, res_model: 'crm.lead', res_id: l.id, summary: 'SMS/Call: check the address', date_deadline: isoDay(1), done: false });
  const mine = ['SMS/Call: call-day reminder', 'SMS/Call: personal message (evening before the call)'];

  await hook('BOOKING_RESCHEDULED', 'bk-sms2', b.email, later.toISOString(), { rescheduleUid: 'bk-sms1', rescheduleStartTime: first.toISOString(), metadata: adMeta('bk-sms2'), responses: { notes: { value: BOOK_NOTES } } });
  await settle();
  assert.deepStrictEqual(titlesOf(l.id), ['After the call: update the stage', ...mine, 'SMS/Call: check the address'].sort(), 'moved, no WhatsApp copy next to them');
  assert.strictEqual(openActs(l.id).find(x => x.summary === 'SMS/Call: call-day reminder').date_deadline, dayOf(later), 'at the new date');

  await hook('BOOKING_CANCELLED', 'bk-sms2', b.email, later.toISOString(), { cancelledBy: b.email, organizer: { email: 'shubhang@sahajta.com' } });
  await settle();
  assert.deepStrictEqual(titlesOf(l.id), ['SMS/Call: check the address', 'SMS/Call: get the call rebooked'], 'call reminders removed; the rebook reminder keeps "SMS/Call:"');
  assert.ok(!acts.some(x => x.done), 'none marked Done');

  l.active = false; l.write_date = new Date().toISOString().slice(0, 19).replace('T', ' ');
  await run();
  assert.deepStrictEqual(titlesOf(l.id), ['SMS/Call: check the address'], 'Lost: ours removed, any other title stays');
  await assert.rejects(odoo.removeOurReminders(l.id, ['SMS/Call: check the address']), /never removed/);
});
