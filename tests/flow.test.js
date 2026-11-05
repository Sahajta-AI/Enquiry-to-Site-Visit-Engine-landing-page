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

Object.assign(process.env, {
  NODE_ENV: 'test', SITE_URL: 'https://preview.example.test', CAL_EVENT_TYPE_ID: '7785231',
  CAL_API_KEY: 'cal_test', CAL_WEBHOOK_SECRET: 'whsec', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec', GOOGLE_REFRESH_TOKEN: 'ref',
  GMAIL_SENDER: 'shubhang@sahajta.com', QSTASH_TOKEN: 'qt', QSTASH_CURRENT_SIGNING_KEY: 'cur', QSTASH_NEXT_SIGNING_KEY: 'next',
  RESEND_API_KEY: 're_test', ALERT_EMAIL_TO: 'backup@example.test', NUDGES_ENABLED: '1', NUDGE_DAILY_LIMIT: '2'
});
delete process.env.UPSTASH_REDIS_REST_URL;

const realFetch = global.fetch;
const sent = [];           // emails Gmail "sent"
const alertsSent = [];     // Resend backup alerts
const published = [];      // QStash publishes
const calBookingPosts = [];
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
  if (url === 'https://api.cal.com/v2/bookings' && opts.method === 'POST') {
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
const reset = () => { store._resetMemory(); sent.length = alertsSent.length = published.length = calBookingPosts.length = 0; for (const k of Object.keys(threads)) delete threads[k]; for (const k of Object.keys(calStatus)) delete calStatus[k]; for (const k of Object.keys(calByEmail)) delete calByEmail[k]; gmailFailures = 0; };

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

const lead = (over) => Object.assign({
  lead_event_id: 'evt_' + Math.random().toString(36).slice(2, 12), name: 'Rohan Mehta', company: 'Skyline Homes', email: 'rohan@example.com',
  whatsapp_number: '9876543210', q1_situation: 'Leads come in but few visit', q2_urgency: 'As soon as possible', timezone: 'Asia/Kolkata',
  trap: '', form_ms: 9000, fbp: 'fb.1.111', fbc: 'fb.1.222.TEST123'
}, over || {});

test('part 7: bots (trap filled, sent too fast, made-up id) send nothing', async () => {
  reset();
  const trapped = lead({ trap: 'http://spam' });
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
  const a = lead();
  await post('/api/lead', a);
  assert.strictEqual((await store.get('lead:' + a.lead_event_id)).lead.fbp, undefined);
  process.env.NEW_TRACKING = '1';
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
  const slot = { resume_code: code, slotDate: '2026-11-12', slotTime: '11:00 AM', bookedSlot: 'x', timezone: 'Asia/Kolkata', fbc: 'fb.1.999.NEW' };
  const book = await (await post('/api/submit-lead', slot)).json();
  assert.strictEqual(book.success, true);
  assert.strictEqual(calBookingPosts.length, 1);
  const cal = calBookingPosts[0];
  assert.deepStrictEqual(cal.metadata, { nudge: 'yes' });
  assert.strictEqual(cal.eventTypeId, 7785231);
  assert.strictEqual(cal.responses.name, 'Priya Shah');
  assert.strictEqual(cal.responses.email, 'priya@example.com');
  assert.match(cal.responses.notes, /^Company or project: Skyline Homes\nWhatsApp: \+91 98765 43210\nWhat’s happening right now: Leads come in but few visit\nWhen they’d want it running: As soon as possible$/);

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
    q1_situation: 'a', q2_urgency: 'b', slotDate: '2026-11-12', slotTime: '11:00 AM', bookedSlot: 'x', timezone: 'Asia/Kolkata', lead_event_id: body.lead_event_id
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
