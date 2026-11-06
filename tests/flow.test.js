// The whole email flow with Gmail, Cal.com, QStash and Resend mocked. Run with: npm test
// The project is copied to a temp folder first, so the real .env (with real keys) is never loaded.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sahajta-flow-'));
fs.cpSync(path.join(root, 'lib'), path.join(tmp, 'lib'), { recursive: true });
fs.copyFileSync(path.join(root, 'server.js'), path.join(tmp, 'server.js'));
fs.symlinkSync(path.join(root, 'node_modules'), path.join(tmp, 'node_modules'));
fs.mkdirSync(path.join(tmp, 'public'));
fs.copyFileSync(path.join(root, 'public', 'tracking-test.html'), path.join(tmp, 'public', 'tracking-test.html'));

Object.assign(process.env, {
  NODE_ENV: 'test', SITE_URL: 'https://preview.example.test', CAL_EVENT_TYPE_ID: '7785231',
  CAL_API_KEY: 'cal_test', CAL_WEBHOOK_SECRET: 'whsec', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec', GOOGLE_REFRESH_TOKEN: 'ref',
  GMAIL_SENDER: 'shubhang@sahajta.com', QSTASH_TOKEN: 'qt', QSTASH_CURRENT_SIGNING_KEY: 'cur', QSTASH_NEXT_SIGNING_KEY: 'next',
  RESEND_API_KEY: 're_test', ALERT_EMAIL_TO: 'backup@example.test', NUDGES_ENABLED: '1', NUDGE_DAILY_LIMIT: '2',
  META_SANDBOX_PIXEL_ID: '555000111', META_SANDBOX_CAPI_TOKEN: 'sandbox_tok', META_SANDBOX_TEST_EVENT_CODE: 'TEST999', META_GRAPH_VERSION: 'v26.0',
  ALERT_EMAIL: 'alerts@example.test', TEST_PAGE_PASSWORD: 'tp-secret', TEST_EMAILS: 'tester@example.com'
});
delete process.env.UPSTASH_REDIS_REST_URL;

const realFetch = global.fetch;
const sent = [];           // emails Gmail "sent"
const alertsSent = [];     // Resend backup alerts
const published = [];      // QStash publishes
const calBookingPosts = [];
const metaCalls = [];      // events sent to Meta
let calMode = 'ok';        // 'ok' | 'refuse' | 'timeout'
let slotsMode = 'ok';      // 'ok' | 'fail'
const threads = {};        // threadId -> message ids
const calStatus = {};      // uid -> status
const calByEmail = {};     // email -> [{createdAt,start,status}]
let gmailFailures = 0;
let n = 0;
const json = (o, status) => new Response(JSON.stringify(o), { status: status || 200, headers: { 'content-type': 'application/json' } });

global.fetch = async (url, opts) => {
  url = String(url); opts = opts || {};
  if (url.startsWith('http://127.0.0.1')) return realFetch(url, opts);
  if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'tok', expires_in: 3600 });
  if (url.endsWith('/messages/send')) {
    if (gmailFailures > 0) { gmailFailures--; return json({ error: { message: 'boom' } }, 500); }
    const body = JSON.parse(opts.body);
    const mime = Buffer.from(body.raw, 'base64url').toString('utf8');
    const header = (name) => {
      const v = (mime.match(new RegExp('^' + name + ': (.*)$', 'mi')) || [])[1];
      const enc = v && v.match(/^=\?UTF-8\?B\?(.+)\?=$/);
      return enc ? Buffer.from(enc[1], 'base64').toString('utf8') : v;
    };
    const parts = mime.split(/--sahajta_[a-z0-9]+/i);
    const dec = (p) => Buffer.from(p.split(/\r?\n\r?\n/)[1].replace(/\s+/g, ''), 'base64').toString('utf8');
    const id = 'm' + (++n);
    const threadId = body.threadId || 't' + n;
    (threads[threadId] = threads[threadId] || []).push(id);
    sent.push({ id, threadId, to: header('To'), subject: header('Subject'), inReplyTo: header('In-Reply-To'), from: header('From'), text: dec(parts[1]), html: dec(parts[2]) });
    return json({ id, threadId });
  }
  if (/\/messages\/m\d+\?format=metadata/.test(url)) {
    const id = url.match(/messages\/(m\d+)/)[1];
    return json({ payload: { headers: [{ name: 'Message-ID', value: `<${id}@mail.gmail.com>` }] } });
  }
  if (/\/threads\/t\d+/.test(url)) {
    const tid = url.match(/threads\/(t\d+)/)[1];
    return json({ messages: (threads[tid] || []).map(id => ({ id })) });
  }
  if (/api\.cal\.com\/v2\/bookings\/[^?]+$/.test(url) && (opts.method || 'GET') === 'GET') {
    const uid = decodeURIComponent(url.split('/').pop());
    return json({ data: { status: calStatus[uid] || 'accepted', meetingUrl: 'https://meet.google.com/live-link' } });
  }
  if (url.startsWith('https://api.cal.com/v2/bookings?')) {
    const email = decodeURIComponent(url.match(/attendeeEmail=([^&]+)/)[1]);
    assert.ok(url.includes('eventTypeId=7785231'), 'the hidden test copy is checked, not the real event');
    return json({ data: calByEmail[email] || [] });
  }
  if (url.startsWith('https://graph.facebook.com/')) {
    const body = JSON.parse(opts.body);
    metaCalls.push({ url, body, event: body.data[0] });
    return json({ events_received: 1, messages: [], fbtrace_id: 'trace1' });
  }
  if (url.startsWith('https://api.cal.com/v2/slots/available')) {
    if (slotsMode === 'fail') return json({ error: 'down' }, 500);
    return json({ data: { slots: {} } });
  }
  if (url === 'https://api.cal.com/v2/bookings' && opts.method === 'POST') {
    if (calMode === 'refuse') return json({ error: 'slot taken' }, 400);
    const b = JSON.parse(opts.body);
    calBookingPosts.push(b);
    return json({ data: { uid: 'bk-resume-' + calBookingPosts.length, id: 9, videoCallUrl: 'https://meet.google.com/x' } });
  }
  if (url.includes('/v2/publish/')) {
    published.push({ url, jobId: JSON.parse(opts.body).jobId, notBefore: Number(opts.headers['Upstash-Not-Before']), ran: false });
    return json({ messageId: 'q' + published.length });
  }
  if (url === 'https://api.resend.com/emails') {
    const b = JSON.parse(opts.body);
    if (!/^\[New Real Estate Lead\]/.test(b.subject)) alertsSent.push(b); // the team's own lead notice is not an alert
    return json({ id: 'r1' });
  }
  throw new Error('Unmocked fetch: ' + url);
};

const app = require(path.join(tmp, 'server.js'));
const store = require(path.join(tmp, 'lib', 'store.js'));
require(path.join(tmp, 'lib', 'leads.js'))._setRecordWaitMs(5);
let server, base;
test.before(async () => {
  await new Promise(r => { server = app.listen(0, r); });
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => { server.close(); global.fetch = realFetch; fs.rmSync(tmp, { recursive: true, force: true }); });

const post = (p, body, headers) => realFetch(base + p, {
  method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: typeof body === 'string' ? body : JSON.stringify(body)
});

function webhookBody(over) {
  return JSON.stringify({
    triggerEvent: 'BOOKING_CREATED',
    payload: Object.assign({
      uid: 'bk-1', eventTypeId: 7785231, startTime: '2026-11-11T10:35:00.000Z',
      attendees: [{ name: 'Asha Rao', email: 'asha@example.com', timeZone: 'Asia/Kolkata' }],
      videoCallData: { url: 'https://meet.google.com/abc-defg-hij' }
    }, over || {})
  });
}
const sign = (raw, secret) => crypto.createHmac('sha256', secret || 'whsec').update(raw).digest('hex');
const sendWebhook = (raw, secret) => post('/api/cal-webhook', raw, { 'x-cal-signature-256': sign(raw, secret) });

function qstashSig(raw) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const data = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({
    iss: 'Upstash', sub: 'https://preview.example.test/api/jobs/run', exp: now + 300, nbf: now - 1, iat: now, jti: 'j',
    body: crypto.createHash('sha256').update(raw).digest('base64url')
  });
  return data + '.' + crypto.createHmac('sha256', 'cur').update(data).digest('base64url');
}
// Runs every published job that has not run yet, like the queue would (in time order, ignoring the wait)
async function runQueue(until) {
  const results = [];
  for (;;) {
    if (until && until()) return results;
    const next = published.filter(p => !p.ran).sort((a, b) => a.notBefore - b.notBefore)[0];
    if (!next) return results;
    next.ran = true;
    const raw = JSON.stringify({ jobId: next.jobId });
    const r = await post('/api/jobs/run', raw, { 'upstash-signature': qstashSig(raw) });
    results.push((await r.json()).result);
  }
}
const reset = () => { store._resetMemory(); sent.length = alertsSent.length = published.length = calBookingPosts.length = 0; for (const k of Object.keys(threads)) delete threads[k]; for (const k of Object.keys(calStatus)) delete calStatus[k]; for (const k of Object.keys(calByEmail)) delete calByEmail[k]; gmailFailures = 0; metaCalls.length = 0; calMode = 'ok'; slotsMode = 'ok'; };

test('8.1: a booking sends the first email at once; the same webhook twice sends one; a wrong secret sends none', async () => {
  reset();
  const raw = webhookBody();
  assert.strictEqual((await sendWebhook(raw, 'wrong')).status, 401);
  assert.strictEqual(sent.length, 0);

  assert.strictEqual((await sendWebhook(raw)).status, 200);
  assert.strictEqual((await sendWebhook(raw)).status, 200);
  const firsts = sent.filter(e => e.to === 'asha@example.com');
  assert.strictEqual(firsts.length, 1);
  const e = firsts[0];
  assert.strictEqual(e.from, 'Shubhang Sethi <shubhang@sahajta.com>');
  assert.strictEqual(e.subject, 'Your Lead Conversion Clarity Call is scheduled for Wed 11 Nov, 4:05 pm IST');
  assert.match(e.text, /Hi Asha, it’s Shubhang/);
  assert.match(e.text, /https:\/\/meet\.google\.com\/abc-defg-hij/);
  assert.match(e.text, /https:\/\/preview\.example\.test\/thank-you/);
  assert.match(e.text, /https:\/\/cal\.com\/reschedule\/bk-1/);
  assert.match(e.text, /https:\/\/wa\.me\/919731173205\?text=YES%2C%20confirming%20my%20Lead%20Conversion%20Clarity%20Call%20on%20Wed%2011%20Nov%20at%204%3A05%20pm\.%20Asha/);
  assert.strictEqual((e.html.match(/<b>/g) || []).length, 3);
  // the second email and the 10-minute check were scheduled
  assert.strictEqual(published.length, 2);
});

test('8.1: a moved booking, a cancelled one and another event send nothing', async () => {
  reset();
  for (const raw of [
    JSON.stringify({ triggerEvent: 'BOOKING_RESCHEDULED', payload: JSON.parse(webhookBody()).payload }),
    JSON.stringify({ triggerEvent: 'BOOKING_CANCELLED', payload: JSON.parse(webhookBody()).payload }),
    webhookBody({ eventTypeId: 111 })
  ]) assert.strictEqual((await sendWebhook(raw)).status, 200);
  assert.strictEqual(sent.length, 0);
});

test('8.2: the second email goes under the first, in the same thread, with Re:', async () => {
  reset();
  await sendWebhook(webhookBody());
  const results = await runQueue();
  assert.deepStrictEqual(results.sort(), ['ok', 'ok', 'sent']); // 10-minute checks (nothing to alert) and the second email
  assert.strictEqual(sent.length, 2);
  const [first, second] = sent;
  assert.strictEqual(second.subject, 'Re: ' + first.subject);
  assert.strictEqual(second.threadId, first.threadId);
  assert.strictEqual(second.inReplyTo, `<${first.id}@mail.gmail.com>`);
  assert.match(second.text, /Shubhang here\. I’ll be on the call with you myself, on Wednesday, 11 November, at 4:05 pm IST/);
  assert.match(second.text, /https:\/\/meet\.google\.com\/live-link/);
});

test('8.2: no second email when the booking was cancelled or moved, or someone replied in the thread', async () => {
  for (const scenario of ['cancelled', 'replied']) {
    reset();
    await sendWebhook(webhookBody({ uid: 'bk-' + scenario }));
    if (scenario === 'cancelled') calStatus['bk-cancelled'] = 'cancelled';
    else threads[sent[0].threadId].push('lead-reply');
    await runQueue();
    assert.strictEqual(sent.length, 1, scenario + ': only the first email went');
  }
});

test('8.2: a second email due at night is held until 8 am in the lead\'s zone', async () => {
  reset();
  const realNow = Date.now;
  // Booked at 4:00 pm IST: 5 hours later is 9:00 pm, so the second email waits until 8 am the next day
  Date.now = () => new Date('2026-11-11T10:30:00.000Z').getTime();
  try { await sendWebhook(webhookBody({ uid: 'bk-night' })); } finally { Date.now = realNow; }
  const secondJob = published.find(p => p.notBefore * 1000 === new Date('2026-11-12T02:30:00.000Z').getTime());
  assert.ok(secondJob, 'second email is due at 8:00 am IST the next day');
});

test('8.1: a failing Gmail is tried 3 times, then Shubhang is alerted both ways, and no second email goes', async () => {
  reset();
  gmailFailures = 99;
  await sendWebhook(webhookBody({ uid: 'bk-fail' }));
  await runQueue();
  gmailFailures = 0;
  assert.strictEqual(sent.filter(e => e.to === 'asha@example.com').length, 0);
  assert.strictEqual(alertsSent.length, 1, 'backup alert through the transactional service');
  assert.strictEqual(alertsSent[0].to[0], 'backup@example.test');
  assert.match(alertsSent[0].text, /^Booking email not sent: Asha Rao, Wed 11 Nov at 4:05 pm\. Send both emails by hand: the first now, the second about 5 hours later, as a reply\.$/);
});

const Q1_FIT = 'We run paid ads but leads go cold because follow-up is slow';
const Q1_OTHER = 'We are still planning or exploring';
const Q2_FIT = 'As soon as possible';
const lead = (over) => Object.assign({
  lead_event_id: crypto.randomUUID(), name: 'Rohan Mehta', company: 'Skyline Homes', email: 'rohan@example.com',
  whatsapp_number: '9876543210', q1_situation: Q1_FIT, q2_urgency: Q2_FIT, timezone: 'Asia/Kolkata',
  hp_note: '', form_ms: 9000, fbp: 'fb.1.111', fbc: 'fb.1.222.TEST123', page_url: 'https://preview.example.test/?utm_source=fb'
}, over || {});
// tomorrow (India time), so the booking time is always in the future and inside the 8 days
const day = (plus) => new Date(Date.now() + 5.5 * 3600 * 1000 + 86400000 * (plus || 1)).toISOString().slice(0, 10);

test('part 7: bots (trap filled, sent too fast, made-up id) send nothing', async () => {
  reset();
  const trapped = lead({ hp_note: 'http://spam' });
  const fast = lead({ form_ms: 300 });
  await post('/api/lead', trapped); await post('/api/lead', fast);
  for (const id of [trapped.lead_event_id, fast.lead_event_id, 'made_up_event_id_123']) {
    const r = await (await post('/api/lead-signal', { kind: 'didnt_book', lead_event_id: id })).json();
    assert.strictEqual(r.result, 'no-record');
  }
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(published.length, 0);
});

test('part 7: ad-source keys are not saved while NEW_TRACKING is off, and are saved when it is on', async () => {
  reset();
  process.env.NEW_TRACKING = 'off';
  const a = lead();
  await post('/api/lead', a);
  assert.strictEqual((await store.get('lead:' + a.lead_event_id)).lead.fbp, undefined);
  process.env.NEW_TRACKING = 'on';
  try {
    const b = lead();
    await post('/api/lead', b);
    const kept = (await store.get('lead:' + b.lead_event_id)).lead;
    assert.strictEqual(kept.fbp, 'fb.1.111');
    assert.strictEqual(kept.fbc, 'fb.1.222.TEST123');
  } finally { delete process.env.NEW_TRACKING; }
});

test('part 7: another website\'s Origin is refused', async () => {
  const r = await post('/api/lead', lead(), { Origin: 'https://evil.example' });
  assert.strictEqual(r.status, 403);
});

test('part 7 + 8.3: leaving at the time step emails Shubhang, starts the nudge pair; nudges only to that lead', async () => {
  reset();
  const body = lead();
  assert.strictEqual((await post('/api/lead', body)).status, 200);
  const r = await (await post('/api/lead-signal', { kind: 'didnt_book', lead_event_id: body.lead_event_id })).json();
  assert.strictEqual(r.result, 'sent+nudges');
  const toShubhang = sent[0];
  assert.strictEqual(toShubhang.to, 'shubhang@sahajta.com');
  assert.strictEqual(toShubhang.subject, 'Didn’t book: Rohan Mehta, Skyline Homes');
  assert.match(toShubhang.text, /Email: rohan@example\.com/);
  assert.ok(toShubhang.text.endsWith('They get our two nudge emails unless they book or reply.'));
  // the same signal again, and the same email from another browser: nothing more
  assert.strictEqual((await (await post('/api/lead-signal', { kind: 'didnt_book', lead_event_id: body.lead_event_id })).json()).result, 'duplicate');
  const other = lead({ email: 'Rohan@Example.com ' });
  await post('/api/lead', other);
  assert.strictEqual((await (await post('/api/lead-signal', { kind: 'didnt_book', lead_event_id: other.lead_event_id })).json()).result, 'duplicate-email');
  assert.strictEqual(sent.length, 1);

  // the first nudge goes out, with the preview's own address and a code in the link
  await runQueueUntil(() => sent.some(e => /One step left/.test(e.subject)));
  const nudge1 = sent.find(e => /One step left/.test(e.subject));
  assert.strictEqual(nudge1.to, 'rohan@example.com');
  assert.match(nudge1.text, /https:\/\/preview\.example\.test\/\?r=[A-Za-z0-9_-]{22}\n/);
  assert.ok(!/rohan|Skyline|9876543210/.test(nudge1.text.split('Pick yours here:')[1]), 'the link holds no details');
});

const runQueueUntil = (cond) => runQueue(cond);

test('8.3: the link opens the time step (resume), returns only the first name, and a booking through it is one booking with nudge: yes', async () => {
  reset();
  const body = lead({ email: 'priya@example.com', name: 'Priya Shah' });
  await post('/api/lead', body);
  await post('/api/lead-signal', { kind: 'didnt_book', lead_event_id: body.lead_event_id });
  await runQueueUntil(() => sent.some(e => /One step left/.test(e.subject)));
  const code = sent.find(e => /One step left/.test(e.subject)).text.match(/\?r=([A-Za-z0-9_-]{22})/)[1];

  const ok = await (await post('/api/resume', { code })).json();
  assert.deepStrictEqual(ok, { ok: true, firstName: 'Priya' });
  assert.deepStrictEqual(await (await post('/api/resume', { code: 'A'.repeat(22) })).json(), { ok: false });
  assert.deepStrictEqual(await (await post('/api/resume', { code: '<script>' })).json(), { ok: false });

  // book through it: only the code, the time and this visit's ad cookies are sent
  const slot = { resume_code: code, slotDate: day(), slotTime: '11:00 AM', bookedSlot: 'x', timezone: 'Asia/Kolkata', fbc: 'fb.1.999.NEW' };
  const book = await (await post('/api/submit-lead', slot)).json();
  assert.strictEqual(book.success, true);
  assert.strictEqual(calBookingPosts.length, 1);
  const cal = calBookingPosts[0];
  assert.strictEqual(cal.metadata.nudge, 'yes');
  assert.strictEqual(cal.metadata.qualified, 'yes');
  assert.strictEqual(cal.metadata.test, 'yes');
  assert.strictEqual(cal.eventTypeId, 7785231);
  assert.strictEqual(cal.responses.name, 'Priya Shah');
  assert.strictEqual(cal.responses.email, 'priya@example.com');
  assert.ok(cal.responses.notes.startsWith('TEST BOOKING\nCompany or project: Skyline Homes\nWhatsApp: +91 98765 43210\n'));
  assert.ok(cal.responses.notes.endsWith(`What’s happening right now: ${Q1_FIT}\nWhen they’d want it running: ${Q2_FIT}`));

  // the code is used: a retry for the same time returns that booking, another time does not book again
  assert.strictEqual((await (await post('/api/submit-lead', slot)).json()).success, true);
  assert.strictEqual(calBookingPosts.length, 1);
  assert.strictEqual((await post('/api/submit-lead', Object.assign({}, slot, { slotTime: '12:00 PM' }))).status, 400);
  assert.deepStrictEqual(await (await post('/api/resume', { code })).json(), { ok: false });

  // no second nudge after they booked
  await runQueue();
  assert.strictEqual(sent.filter(e => /Re: One step left/.test(e.subject)).length, 0);
});

test('8.3: someone who books through the form (same visit) gets no nudge and no alert', async () => {
  reset();
  const body = lead({ email: 'neha@example.com', name: 'Neha Iyer' });
  await post('/api/lead', body);
  await post('/api/lead-signal', { kind: 'didnt_book', lead_event_id: body.lead_event_id });
  // they come back and book through the form, carrying this visit's lead_event_id
  const booked = await (await post('/api/submit-lead', {
    name: 'Neha Iyer', company: 'Skyline Homes', email: 'neha@example.com', whatsapp_number: '9876543210',
    q1_situation: Q1_FIT, q2_urgency: Q2_FIT, hp_note: '', form_ms: 9000, slotDate: day(), slotTime: '11:00 AM', bookedSlot: 'x', timezone: 'Asia/Kolkata', lead_event_id: body.lead_event_id
  })).json();
  assert.strictEqual(booked.success, true);
  await runQueue();
  assert.strictEqual(sent.filter(e => e.to === 'neha@example.com').length, 0);
  assert.strictEqual(alertsSent.length, 0);
});

test('8.3: the second nudge goes under the first; a reply to the first stops it', async () => {
  for (const reply of [false, true]) {
    reset();
    const body = lead({ email: `n${reply}@example.com`, name: 'Kabir Singh' });
    await post('/api/lead', body);
    await post('/api/lead-signal', { kind: 'didnt_book', lead_event_id: body.lead_event_id });
    await runQueueUntil(() => sent.some(e => /^One step left/.test(e.subject)));
    const n1 = sent.find(e => /^One step left/.test(e.subject));
    if (reply) threads[n1.threadId].push('their-reply');
    await runQueue();
    const n2 = sent.find(e => /^Re: One step left/.test(e.subject));
    if (reply) assert.ok(!n2, 'replied: no second nudge');
    else {
      assert.ok(n2);
      assert.strictEqual(n2.threadId, n1.threadId);
      assert.strictEqual(n2.inReplyTo, `<${n1.id}@mail.gmail.com>`);
    }
  }
});

test('8.3: no times shown emails Shubhang with the WhatsApp line and starts no nudges', async () => {
  reset();
  const body = lead({ email: 'zed@example.com', name: 'Zed Khan' });
  await post('/api/lead', body);
  const r = await (await post('/api/lead-signal', { kind: 'no_times', lead_event_id: body.lead_event_id })).json();
  assert.strictEqual(r.result, 'sent');
  assert.strictEqual(sent[0].subject, 'No times shown: Zed Khan, Skyline Homes');
  assert.ok(sent[0].text.endsWith('No nudge emails for them: WhatsApp them yourself.'));
  assert.strictEqual(published.length, 0);
});

test('8.3: the daily limit stops new pairs and alerts once', async () => {
  reset();
  for (let i = 0; i < 4; i++) {
    const b = lead({ email: `bulk${i}@example.com`, name: 'Bulk ' + i });
    await post('/api/lead', b);
    await post('/api/lead-signal', { kind: 'didnt_book', lead_event_id: b.lead_event_id });
  }
  const pairs = published.length; // each pair publishes its first nudge (and a 10-minute check when it runs)
  assert.strictEqual(published.filter(p => true).length, 2, 'limit is 2 pairs: only two first nudges scheduled');
  assert.strictEqual(alertsSent.length, 1, 'one alert, not one per extra person');
  assert.ok(pairs >= 2);
  const leaveEmails = sent.filter(e => /^Didn’t book/.test(e.subject));
  assert.strictEqual(leaveEmails.length, 4);
  assert.ok(leaveEmails.slice(0, 2).every(e => e.text.endsWith('They get our two nudge emails unless they book or reply.')));
  assert.ok(leaveEmails.slice(2).every(e => e.text.endsWith('No nudge emails for them: WhatsApp them yourself.')));
});

test('8.3: a failing nudge is tried 3 times, then Shubhang is alerted with the brief\'s words', async () => {
  reset();
  const b = lead({ email: 'fail@example.com', name: 'Fay Roy' });
  await post('/api/lead', b);
  await post('/api/lead-signal', { kind: 'didnt_book', lead_event_id: b.lead_event_id });
  gmailFailures = 99;
  await runQueue();
  gmailFailures = 0;
  assert.strictEqual(sent.filter(e => e.to === 'fail@example.com').length, 0);
  assert.strictEqual(alertsSent.length, 1);
  assert.strictEqual(alertsSent[0].text, 'Nudge email not sent: Fay Roy, Skyline Homes. WhatsApp them two times instead.');
});

test('jobs: a call that is not from the queue is refused', async () => {
  const r = await post('/api/jobs/run', { jobId: 'x' });
  assert.strictEqual(r.status, 401);
});

// ======================================================================================
// Backend and Tracking Brief
// ======================================================================================
const waitFor = async (cond, ms) => { const end = Date.now() + (ms || 3000); while (Date.now() < end) { if (cond()) return true; await new Promise(r => setTimeout(r, 25)); } return cond(); };
const bookingBody = (over) => Object.assign({
  name: 'Rohan Mehta', company: 'Skyline Homes', email: 'rohan@example.com', whatsapp_number: '9876543210',
  q1_situation: Q1_FIT, q2_urgency: Q2_FIT, slotDate: day(), slotTime: '11:00 AM', bookedSlot: 'x', timezone: 'Asia/Kolkata',
  lead_event_id: crypto.randomUUID(), schedule_event_id: crypto.randomUUID(), hp_note: '', form_ms: 9000,
  fbp: 'fb.1.111', page_url: 'https://preview.example.test/',
  sv_attrib: { utm_source: 'fb', utm_medium: 'paid_social', utm_campaign: 'test', utm_content: 'ad1', utm_term: 'set1', fbclid: 'TEST123', angle: 'speed',
    landing_url: 'https://preview.example.test/?utm_source=fb', referrer: 'https://l.facebook.com/', first_seen: '2026-11-05T10:00:00.000Z' },
  consent_at: '2026-11-05T10:01:00.000Z'
}, over || {});

test('5.3 Lead: the server sends it to Meta with the shared ID, hashed identity, no value, token in the body, test code on top', async () => {
  reset();
  const b = lead({ lead_event_id: crypto.randomUUID(), name: 'Rohan  Mehta-Rao', email: ' Rohan@Example.com ' });
  const r = await (await post('/api/lead', b)).json();
  assert.deepStrictEqual(r, { ok: true, test: true });
  assert.ok(await waitFor(() => metaCalls.length === 1));
  const { url, body, event } = metaCalls[0];
  assert.strictEqual(url, 'https://graph.facebook.com/v26.0/555000111/events');
  assert.ok(!url.includes('access_token') && !url.includes('sandbox_tok'), 'the token is never in the address');
  assert.strictEqual(body.access_token, 'sandbox_tok');
  assert.strictEqual(body.test_event_code, 'TEST999');          // top level, next to data
  assert.strictEqual(event.event_name, 'Lead');
  assert.strictEqual(event.event_id, b.lead_event_id);
  assert.strictEqual(event.action_source, 'website');
  assert.ok(Math.abs(event.event_time - Math.floor(Date.now() / 1000)) < 5, 'the server clock, in seconds');
  assert.strictEqual(event.custom_data.content_name, 'Lead Conversion Clarity Call form');
  assert.ok(!('value' in event.custom_data) && !('currency' in event.custom_data));
  const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
  assert.deepStrictEqual(event.user_data.em, [sha('rohan@example.com')]);
  assert.deepStrictEqual(event.user_data.external_id, [sha('rohan@example.com')]);
  assert.deepStrictEqual(event.user_data.ph, [sha('919876543210')]);
  assert.deepStrictEqual(event.user_data.fn, [sha('rohan')]);
  assert.deepStrictEqual(event.user_data.ln, [sha('mehtarao')]);   // lowercased, no punctuation
  assert.deepStrictEqual(event.user_data.country, [sha('in')]);
  assert.strictEqual(event.user_data.fbp, 'fb.1.111');
  assert.strictEqual(event.user_data.fbc, 'fb.1.222.TEST123');
  assert.ok(event.user_data.client_ip_address && event.user_data.client_user_agent, 'IP and user agent are sent, not hashed');
  assert.ok(!JSON.stringify(body).includes(Q1_FIT), 'the answers are never sent');
  // the same ID again (after Back) is sent again with the same ID, so Meta counts it once
  await post('/api/lead', Object.assign({}, b, { company: 'Changed Co' }));
  assert.ok(await waitFor(() => metaCalls.length === 2));
  assert.strictEqual(metaCalls[1].event.event_id, b.lead_event_id);
});

test('5.3 fbc: built from fbclid when there is no cookie, exactly as received', async () => {
  reset();
  const b = lead({ fbc: '', sv_attrib: { fbclid: 'AbC_Case', first_seen: '2026-11-05T10:00:00.000Z' } });
  await post('/api/lead', b);
  assert.ok(await waitFor(() => metaCalls.length === 1));
  assert.strictEqual(metaCalls[0].event.user_data.fbc, `fb.1.${Date.parse('2026-11-05T10:00:00.000Z')}.AbC_Case`);
});

test('7.1 /api/lead: the server checks every input, not only the form', async () => {
  reset();
  const bad = [
    lead({ email: 'not-an-email' }), lead({ whatsapp_number: '987654321' }), lead({ whatsapp_number: '5876543210' }),
    lead({ whatsapp_number: '+12345' }), lead({ name: 'A' }), lead({ name: 'x'.repeat(81) }), lead({ company: '' }),
    lead({ company: 'c'.repeat(101) }), lead({ q1_situation: 'Something made up' }), lead({ q2_urgency: 'Whenever' }),
    lead({ lead_event_id: 'not-a-uuid' })
  ];
  for (const b of bad) {
    const r = await post('/api/lead', b);
    assert.strictEqual(r.status, 400);
    assert.deepStrictEqual(await r.json(), { ok: false, code: 'invalid' });
  }
  // an international number is fine
  assert.strictEqual((await post('/api/lead', lead({ whatsapp_number: '+971501234567' }))).status, 200);
  assert.strictEqual(metaCalls.length <= 1, true);
});

test('7.2 spam: a trap or a form sent in under 3 seconds gets an "all fine" reply and nothing happens', async () => {
  reset();
  for (const over of [{ hp_note: 'x' }, { form_ms: 2999 }, { form_ms: 0 }]) {
    const b = lead(over);
    assert.deepStrictEqual(await (await post('/api/lead', b)).json(), { ok: true, test: false });
    assert.strictEqual(await store.get('lead:' + b.lead_event_id), null, 'nothing kept');
  }
  await new Promise(r => setTimeout(r, 100));
  assert.strictEqual(metaCalls.length, 0, 'nothing sent to Meta');
});

test('5.3 store refuses the write: an error reply so the browser retries, and Shubhang gets the person\'s details', async () => {
  reset();
  const realSet = store.set;
  store.set = async (k, ...rest) => { if (String(k).startsWith('lead:')) throw new Error('store down'); return realSet(k, ...rest); };
  try {
    const b = lead({ name: 'Store Test', email: 'storetest@example.com' });
    const r = await post('/api/lead', b);
    assert.strictEqual(r.status, 503);
    assert.deepStrictEqual(await r.json(), { ok: false, code: 'store' });
    assert.ok(await waitFor(() => sent.some(e => e.subject === 'A lead could not be saved')));
    const mail = sent.find(e => e.subject === 'A lead could not be saved');
    assert.strictEqual(mail.to, 'alerts@example.test');
    assert.match(mail.text, /Name: Store Test[\s\S]*Email: storetest@example\.com/);
  } finally { store.set = realSet; }
});

test('5.3 + 5.5 Schedule and QualifiedBooking: from the server, shared IDs, QualifiedBooking only when both answers fit, once', async () => {
  reset();
  const b = bookingBody({ email: 'q1@example.com' });
  const r = await (await post('/api/submit-lead', b)).json();
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.test, true);
  assert.ok(await waitFor(() => metaCalls.length === 2));
  const [schedule, qualified] = metaCalls.map(c => c.event);
  assert.strictEqual(schedule.event_name, 'Schedule');
  assert.strictEqual(schedule.event_id, b.schedule_event_id);
  assert.strictEqual(schedule.custom_data.content_name, 'Lead Conversion Clarity Call');
  assert.ok(!('value' in schedule.custom_data));
  assert.strictEqual(qualified.event_name, 'QualifiedBooking');
  assert.strictEqual(qualified.event_id, b.schedule_event_id + '-q');
  // booking metadata: qualified yes, test yes
  assert.strictEqual(calBookingPosts[0].metadata.qualified, 'yes');
  assert.strictEqual(calBookingPosts[0].metadata.test, 'yes');

  // answers that don't fit: Schedule only, qualified: no
  reset();
  const other = bookingBody({ email: 'q2@example.com', q1_situation: Q1_OTHER });
  assert.strictEqual((await (await post('/api/submit-lead', other)).json()).success, true);
  assert.ok(await waitFor(() => metaCalls.length === 1));
  await new Promise(r => setTimeout(r, 100));
  assert.strictEqual(metaCalls.length, 1);
  assert.strictEqual(metaCalls[0].event.event_name, 'Schedule');
  assert.strictEqual(calBookingPosts[0].metadata.qualified, 'no');
});

test('6.2 booking metadata: the source keys are saved (never in the notes) while NEW_TRACKING is on', async () => {
  reset();
  const b = bookingBody({ email: 'src@example.com', fbc: '' });
  await post('/api/submit-lead', b);
  const md = calBookingPosts[0].metadata;
  assert.strictEqual(md.utm_source, 'fb');
  assert.strictEqual(md.utm_campaign, 'test');
  assert.strictEqual(md.angle, 'speed');
  assert.strictEqual(md.fbclid, 'TEST123');
  assert.strictEqual(md.fbc, `fb.1.${Date.parse('2026-11-05T10:00:00.000Z')}.TEST123`);
  assert.strictEqual(md.fbp, 'fb.1.111');
  assert.strictEqual(md.landing_url, 'https://preview.example.test/?utm_source=fb');
  assert.strictEqual(md.referrer, 'https://l.facebook.com/');
  assert.strictEqual(md.first_seen, '2026-11-05T10:00:00.000Z');
  assert.strictEqual(md.lead_event_id, b.lead_event_id);
  assert.strictEqual(md.schedule_event_id, b.schedule_event_id);
  assert.strictEqual(md.consent_at, '2026-11-05T10:01:00.000Z');
  assert.ok(md.client_user_agent && md.client_ip);
  const notes = calBookingPosts[0].responses.notes;
  assert.ok(!/TEST123|utm_|fbp|fbc|schedule_event_id/.test(notes), 'none of it in the notes the lead sees');
  Object.entries(md).forEach(([k, v]) => { assert.ok(k.length <= 40 && String(v).length <= 500); });
});

test('6.2 + 12 NEW_TRACKING off: the booking holds only test and qualified, and nothing real goes to the live Pixel', async () => {
  reset();
  process.env.NEW_TRACKING = 'off';
  try {
    await post('/api/submit-lead', bookingBody({ email: 'off@example.com' }));
    assert.deepStrictEqual(Object.keys(calBookingPosts[0].metadata).sort(), ['qualified', 'test']);
  } finally { delete process.env.NEW_TRACKING; }
});

test('7.1 /api/submit-lead: bad details, a past time, and a time more than 8 days ahead are refused by the server', async () => {
  reset();
  for (const over of [{ email: 'bad' }, { whatsapp_number: '123' }, { q2_urgency: 'nope' }, { slotDate: day(-2) }, { slotDate: day(9) }, { slotTime: 'soon' }]) {
    const r = await post('/api/submit-lead', bookingBody(over));
    assert.strictEqual(r.status, 400, JSON.stringify(over));
    assert.strictEqual((await r.json()).code, 'invalid');
  }
  assert.strictEqual(calBookingPosts.length, 0);
});

test('7.2 /api/submit-lead: a trap or a too-fast form gets the normal booking error, and one alert per 30 minutes', async () => {
  reset();
  for (const over of [{ hp_note: 'spam' }, { form_ms: 1000 }]) {
    const r = await post('/api/submit-lead', bookingBody(over));
    assert.strictEqual(r.status, 502);
    assert.strictEqual((await r.json()).error, 'The booking could not be made. Please pick a time again.');
  }
  assert.strictEqual(calBookingPosts.length, 0);
  assert.ok(await waitFor(() => sent.some(e => e.subject === 'A booking was refused as a bot')));
  await new Promise(r => setTimeout(r, 100));
  assert.strictEqual(sent.filter(e => e.subject === 'A booking was refused as a bot').length, 1, 'at most one every 30 minutes');
  assert.match(sent.find(e => e.subject === 'A booking was refused as a bot').text, /Email: rohan@example\.com/);
});

test('7.4 Cal.com refuses a booking: the normal error, one alert per person with their details', async () => {
  reset();
  calMode = 'refuse';
  const b = bookingBody({ email: 'refused@example.com', name: 'Refused Person' });
  const r = await post('/api/submit-lead', b);
  assert.strictEqual(r.status, 502);
  assert.ok(await waitFor(() => sent.some(e => e.subject === 'A booking could not be made')));
  await post('/api/submit-lead', b); // the same person and time again: still one email
  await new Promise(r => setTimeout(r, 150));
  assert.strictEqual(sent.filter(e => e.subject === 'A booking could not be made').length, 1);
  const mail = sent.find(e => e.subject === 'A booking could not be made');
  assert.match(mail.text, /Name: Refused Person[\s\S]*Email: refused@example\.com[\s\S]*Time they picked:/);
  assert.strictEqual(metaCalls.length, 0, 'no Schedule for a failed booking');
});

test('7.2 a retry with the same email and time does not book twice: reply with the booking that exists, Schedule again with the same ID', async () => {
  reset();
  const b = bookingBody({ email: 'retry@example.com' });
  const startMs = new Date(`${b.slotDate}T05:30:00.000Z`).getTime(); // 11:00 AM IST
  calByEmail['retry@example.com'] = [{ uid: 'existing-uid', createdAt: new Date().toISOString(), start: new Date(startMs).toISOString(), status: 'accepted' }];
  const r = await (await post('/api/submit-lead', b)).json();
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.rescheduleUrl, 'https://cal.com/reschedule/existing-uid');
  assert.strictEqual(calBookingPosts.length, 0, 'no second booking');
  assert.ok(await waitFor(() => metaCalls.some(c => c.event.event_name === 'Schedule')));
  assert.strictEqual(metaCalls.find(c => c.event.event_name === 'Schedule').event.event_id, b.schedule_event_id);
  // QualifiedBooking went once; a second retry sends no second one
  assert.ok(await waitFor(() => metaCalls.some(c => c.event.event_name === 'QualifiedBooking')));
  await post('/api/submit-lead', b);
  await new Promise(r => setTimeout(r, 150));
  assert.strictEqual(metaCalls.filter(c => c.event.event_name === 'QualifiedBooking').length, 1);
});

test('4 /api/config: the Sandbox Pixel on a preview, never the booking link, never a fallback to the live Pixel', async () => {
  const cfgRes = await (await realFetch(base + '/api/config')).json();
  assert.strictEqual(cfgRes.metaPixelId, '555000111');
  assert.strictEqual(cfgRes.pixelKind, 'sandbox');
  assert.ok(!('calendarEmbedUrl' in cfgRes));
  assert.strictEqual(typeof cfgRes.newTracking, 'boolean');
  assert.ok(!JSON.stringify(cfgRes).includes('909588332098654'));
  // no Sandbox values: no Pixel at all
  const saved = process.env.META_SANDBOX_PIXEL_ID;
  delete process.env.META_SANDBOX_PIXEL_ID;
  try { assert.strictEqual((await (await realFetch(base + '/api/config')).json()).metaPixelId, ''); } finally { process.env.META_SANDBOX_PIXEL_ID = saved; }
});

test('7.4 open times failing to load: one alert per 30 minutes, also by the backup path', async () => {
  reset();
  slotsMode = 'fail';
  await realFetch(base + '/api/available-slots?month=2026-11&timeZone=Asia/Kolkata');
  await realFetch(base + '/api/available-slots?month=2026-11&timeZone=Asia/Kolkata');
  assert.ok(await waitFor(() => sent.some(e => e.subject === 'Open times are not loading')));
  await new Promise(r => setTimeout(r, 150));
  assert.strictEqual(sent.filter(e => e.subject === 'Open times are not loading').length, 1);
  assert.ok(alertsSent.some(a => a.subject === 'Open times are not loading'), 'the backup alert path too');
});

test('4 Origin: the live address, the boss\'s address and preview addresses are allowed; other sites are not', async () => {
  for (const origin of ['https://warmchain.sahajta.com', 'https://site-visit-engine-landing-page.vercel.app', 'https://preview.example.test']) {
    assert.strictEqual((await post('/api/lead', lead({ form_ms: 0 }), { Origin: origin })).status, 200, origin);
  }
  for (const origin of ['https://evil.example', 'https://warmchain.sahajta.com.evil.example']) {
    assert.strictEqual((await post('/api/lead', lead(), { Origin: origin })).status, 403, origin);
    assert.strictEqual((await post('/api/submit-lead', bookingBody(), { Origin: origin })).status, 403, origin);
  }
});

test('11 test page: noindex, no link anywhere, and not listed in robots.txt', async () => {
  const r = await realFetch(base + '/tracking-test');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('x-robots-tag'), 'noindex');
  const html = await r.text();
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.ok(!/clarity\.ms|tracking\.js/.test(html), 'never Clarity (or the shared tracking script that loads it) on the test page');
  const robots = fs.readFileSync(path.join(root, 'public', 'robots.txt'), 'utf8');
  assert.ok(!/tracking-test/.test(robots));
  for (const f of ['index.html', 'thank-you.html']) {
    assert.ok(!/tracking-test/.test(fs.readFileSync(path.join(root, 'public', f), 'utf8')), f + ' does not link to it');
  }
});

const tt = (body, pw) => post('/api/tracking-test', body, pw === undefined ? { 'x-test-password': 'tp-secret' } : { 'x-test-password': pw });

test('11 test page endpoint: a wrong or missing password is refused every time; the right one works', async () => {
  reset();
  assert.strictEqual((await tt({ action: 'info' }, 'wrong')).status, 401);
  assert.strictEqual((await tt({ action: 'info' }, '')).status, 401);
  assert.strictEqual((await post('/api/tracking-test', { action: 'info' })).status, 401);
  assert.strictEqual((await tt({ action: 'info' })).status, 200);
  // without a password set on the server, nothing works
  const saved = process.env.TEST_PAGE_PASSWORD;
  delete process.env.TEST_PAGE_PASSWORD;
  try { assert.strictEqual((await tt({ action: 'info' }, 'anything')).status, 503); } finally { process.env.TEST_PAGE_PASSWORD = saved; }
});

test('11 test page: the top shows yes or no for the token and test code, never the values', async () => {
  const d = await (await tt({ action: 'info' })).json();
  assert.strictEqual(d.sandbox.pixelId, '555000111');
  assert.strictEqual(d.sandbox.tokenSet, true);
  assert.strictEqual(d.sandbox.testCodeSet, true);
  assert.strictEqual(d.graphVersion, 'v26.0');
  const text = JSON.stringify(d);
  assert.ok(!text.includes('sandbox_tok') && !text.includes('TEST999'));
});

test('11 test page: Lead, Schedule and QualifiedBooking go to the Sandbox from the server with the page\'s event ID; the dummy lead is Test Lead', async () => {
  reset();
  const id = crypto.randomUUID();
  const d = await (await tt({ action: 'send', event: 'Lead', eventId: id, target: 'sandbox' })).json();
  assert.strictEqual(d.ok, true);
  assert.strictEqual(d.eventsReceived, 1);
  assert.strictEqual(d.fbtraceId, 'trace1');
  assert.deepStrictEqual(Object.keys(d.matchKeys).sort(), ['country', 'email', 'external_id', 'fbc', 'fbp', 'ip', 'name', 'phone', 'user_agent']);
  assert.strictEqual(metaCalls.length, 1);
  assert.strictEqual(metaCalls[0].event.event_id, id);
  assert.strictEqual(metaCalls[0].body.test_event_code, 'TEST999');
  const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
  assert.deepStrictEqual(metaCalls[0].event.user_data.em, [sha('tester@example.com')], 'the first email in TEST_EMAILS');
  assert.deepStrictEqual(metaCalls[0].event.user_data.fn, [sha('test')]);
  await tt({ action: 'send', event: 'QualifiedBooking', eventId: id + '-q', target: 'sandbox' });
  assert.strictEqual(metaCalls[1].event.event_id, id + '-q');
});

test('11 test page: nothing real reaches the live Pixel: no Lead or Schedule, and the live check works on production only', async () => {
  reset();
  for (const body of [
    { action: 'send', event: 'Lead', target: 'live' },
    { action: 'send', event: 'Schedule', target: 'live' },
    { action: 'send', event: 'TrackingCheck', target: 'live' },     // not production here
    { action: 'send', event: 'TrackingCheck', target: 'sandbox' },
    { action: 'send', event: 'NotAnEvent', target: 'sandbox' }
  ]) {
    const d = await (await tt(body)).json();
    assert.strictEqual(d.ok, false, JSON.stringify(body));
  }
  assert.strictEqual(metaCalls.length, 0);
});

test('4/5 production with NEW_TRACKING off: the server sends nothing real to the live Pixel', async () => {
  reset();
  const meta = require(path.join(tmp, 'lib', 'meta.js'));
  process.env.META_PIXEL_ID = '999111222'; process.env.META_CAPI_TOKEN = 'live_tok'; process.env.NEW_TRACKING = 'off';
  try {
    const out = await meta.send({ eventName: 'Lead', eventId: crypto.randomUUID(), req: { headers: {}, socket: {} }, person: { name: 'A B', email: 'a@b.co', phone: '9876543210' }, target: 'live' });
    assert.strictEqual(out.skipped, 'new-tracking-off');
    assert.strictEqual(metaCalls.length, 0);
    process.env.NEW_TRACKING = 'on';
    const on = await meta.send({ eventName: 'Lead', eventId: crypto.randomUUID(), req: { headers: {}, socket: {} }, person: { name: 'A B', email: 'a@b.co', phone: '9876543210' }, target: 'live' });
    assert.strictEqual(on.ok, true);
    assert.strictEqual(metaCalls[0].url, 'https://graph.facebook.com/v26.0/999111222/events');
    assert.strictEqual(metaCalls[0].body.test_event_code, undefined, 'no test code on a real live send');
  } finally { delete process.env.META_PIXEL_ID; delete process.env.META_CAPI_TOKEN; delete process.env.NEW_TRACKING; }
});

test('7.4 Meta refuses an event: one alert per kind every 30 minutes, with Meta\'s message', async () => {
  reset();
  const prev = global.fetch;
  const base0 = prev;
  global.fetch = async (url, opts) => {
    if (String(url).startsWith('https://graph.facebook.com/')) return json({ error: { message: 'Invalid parameter', fbtrace_id: 'ABC' } }, 400);
    return base0(url, opts);
  };
  try {
    const meta = require(path.join(tmp, 'lib', 'meta.js'));
    const args = { eventName: 'Lead', eventId: crypto.randomUUID(), req: { headers: {}, socket: {} }, person: { name: 'A B', email: 'a@b.co', phone: '9876543210' }, target: 'sandbox' };
    assert.strictEqual((await meta.send(args)).ok, false);
    await meta.send(Object.assign({}, args, { eventId: crypto.randomUUID() }));
    assert.ok(await waitFor(() => sent.some(e => e.subject === 'Meta refused an event: Lead')));
    await new Promise(r => setTimeout(r, 100));
    const mails = sent.filter(e => e.subject === 'Meta refused an event: Lead');
    assert.strictEqual(mails.length, 1);
    assert.match(mails[0].text, /Invalid parameter/);
    assert.match(mails[0].text, /fbtrace_id: ABC/);
  } finally { global.fetch = prev; }
});
