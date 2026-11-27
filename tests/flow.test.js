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
fs.copyFileSync(path.join(root, 'public', 'open-times.html'), path.join(tmp, 'public', 'open-times.html'));

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
let publishDown = false;   // the queue refuses new jobs
const calBookingPosts = [];
const metaCalls = [];      // events sent to Meta
let calMode = 'ok';        // 'ok' | 'refuse' | 'timeout'
let slotsMode = 'ok';      // 'ok' | 'fail'
const threads = {};        // threadId -> message ids
const calStatus = {};      // uid -> status
const calEventType = {};   // uid -> event type id, when not the test event
const rescheduleCalls = []; const takenStarts = []; const refuseStarts = []; let noNewUid = false;
const calStart = {};       // uid -> start time, when it differs from the webhook's
const calNoMeet = new Set(); // uids whose booking has no Meet link
const calByEmail = {};     // email -> [{createdAt,start,status}]
const calUpcoming = [];    // the event's upcoming bookings (the one-call-per-person check)
let calUpcomingDown = false;
let gmailFailures = 0;
let gmailFailStatus = 500; // the status of a failing Gmail answer (a 4xx is a clear refusal, a 5xx may have sent it)
let gmailLateReply = false;
let n = 0;
const json = (o, status) => new Response(JSON.stringify(o), { status: status || 200, headers: { 'content-type': 'application/json' } });

global.fetch = async (url, opts) => {
  url = String(url); opts = opts || {};
  if (url.startsWith('http://127.0.0.1')) return realFetch(url, opts);
  if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'tok', expires_in: 3600 });
  if (url.endsWith('/messages/send')) {
    if (gmailFailures > 0) { gmailFailures--; return json({ error: { message: 'boom' } }, gmailFailStatus); }
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
    if (gmailLateReply) { gmailLateReply = false; throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); } // sent, but the answer came too late
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
    return json({ data: { status: calStatus[uid] || 'accepted', start: calStart[uid] || '2026-11-11T10:35:00.000Z', meetingUrl: calNoMeet.has(uid) ? '' : 'https://meet.google.com/live-link', eventTypeId: calEventType[uid] || 7785231, ...(uid === 'bk-move' ? { attendees: [{ email: 'move@example.com' }] } : {}) } });
  }
  if (/api\.cal\.com\/v2\/bookings\/[^/?]+\/reschedule$/.test(url) && opts.method === 'POST') {
    const uid = decodeURIComponent(url.split('/').slice(-2)[0]);
    const body = JSON.parse(opts.body);
    rescheduleCalls.push({ uid, start: body.start });
    if (takenStarts.includes(body.start) || refuseStarts.includes(body.start)) return json({ error: 'refused' }, 400);
    return json({ status: 'success', data: { uid: noNewUid ? '' : uid + '-moved', start: body.start } });
  }
  if (url.startsWith('https://api.cal.com/v2/bookings?') && /status=upcoming/.test(url)) {
    assert.ok(url.includes('eventTypeId=7785231'));
    if (calUpcomingDown) return json({ error: 'down' }, 500);
    return json({ data: calUpcoming });
  }
  if (url.startsWith('https://api.cal.com/v2/bookings?')) {
    if (calUpcomingDown) return json({ error: 'down' }, 500);
    const email = decodeURIComponent(url.match(/attendeeEmail=([^&]+)/)[1]);
    assert.ok(url.includes('eventTypeId=7785231'), 'the hidden test copy is checked, not the real event');
    return json({ data: calByEmail[email] || [] });
  }
  if (url.startsWith('https://graph.facebook.com/')) {
    const body = JSON.parse(opts.body);
    metaCalls.push({ url, body, event: body.data[0] });
    return json({ events_received: 1, messages: [], fbtrace_id: 'trace1' });
  }
  if (url.startsWith('https://api.cal.com/v2/slots/available') && /startTime=[^&]*T\d\d:\d\d:00\.000Z&endTime=[^&]*&eventTypeId=\d+$/.test(url) && refuseStarts.length + takenStarts.length) {
    // the exact-time check after a refused move: a refused (not taken) time is still open
    const mid = new Date(new Date(url.match(/startTime=([^&]+)/)[1]).getTime() + 60000).toISOString();
    return json({ data: { slots: refuseStarts.includes(mid) ? { d: [{ time: mid }] } : {} } });
  }
  if (url.startsWith('https://api.cal.com/v2/slots/available')) {
    if (slotsMode === 'fail') return json({ error: 'down' }, 500);
    return json({ data: { slots: {} } });
  }
  if (url === 'https://api.cal.com/v2/bookings' && opts.method === 'POST') {
    if (calMode === 'refuse') return json({ error: 'slot taken' }, 400);
    if (calMode === 'refuse-limit' || calMode === 'refuse-limit-found') {
      // Cal.com's own 1-booking limit (its reason names the email); "found": a booking made a moment ago (two tabs)
      if (calMode === 'refuse-limit-found') { const em = JSON.parse(opts.body).responses.email; calByEmail[em] = [{ uid: 'bk-race', createdAt: new Date().toISOString(), start: new Date(Date.now() + 86400000).toISOString(), status: 'accepted' }]; }
      return json({ status: 'error', error: { code: 'BadRequestException', message: "Attendee with this email can't book because the maximum number of active bookings has been reached.", details: { message: "Attendee with this email can't book because the maximum number of active bookings has been reached.", error: 'Bad Request', statusCode: 400 } } }, 400); // Cal.com API v2's exact reply (its source, errors.service.ts)
    }
    if (calMode === 'refuse-contact') return json({ status: 'error', error: { code: 'BadRequestException', message: 'Attendee email or phone number properties wrong. They must have at least one contact method (email or phone number).' } }, 400);
    if (calMode === 'refuse-email') return json({ status: 'error', error: { code: 'BadRequestException', message: 'Attendee email domain cannot receive emails' } }, 400);
    const b = JSON.parse(opts.body);
    calBookingPosts.push(b);
    return json({ data: { uid: 'bk-resume-' + calBookingPosts.length, id: 9, videoCallUrl: 'https://meet.google.com/x' } });
  }
  if (url.includes('/v2/publish/')) {
    if (publishDown) return json({ error: 'queue down' }, 500);
    published.push({ url, jobId: JSON.parse(opts.body).jobId, notBefore: Number(opts.headers['Upstash-Not-Before']), ran: false });
    return json({ messageId: 'q' + published.length });
  }
  if (url === 'https://api.resend.com/emails') {
    alertsSent.push(JSON.parse(opts.body));
    return json({ id: 'r1' });
  }
  throw new Error('Unmocked fetch: ' + url);
};

const app = require(path.join(tmp, 'server.js'));
// No network in tests: a fake DNS. Any domain takes mail, except *.nomail.test (doesn't exist) and slow.test (times out)
const fakeDns = {
  resolveMx: async (d) => { if (/nomail\.test$/.test(d)) throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' }); if (d === 'slow.test') return new Promise(() => {}); return [{ exchange: 'mx.' + d, priority: 10 }]; },
  resolve4: async (d) => { if (/nomail\.test$/.test(d)) throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' }); return ['192.0.2.1']; }
};
require(path.join(tmp, 'lib', 'emailcheck.js'))._setResolver(fakeDns);
const store = require(path.join(tmp, 'lib', 'store.js'));
require(path.join(tmp, 'lib', 'leads.js'))._setRecordWaitMs(5);
const tasks = require(path.join(tmp, 'lib', 'tasks.js'));
tasks._setScheduleRetryMs(5);
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
// The webhook replies first and does its work after the reply: wait for that work
const lafter = require(path.join(tmp, 'lib', 'after.js'));
const sendWebhook = async (raw, secret) => { const r = await post('/api/cal-webhook', raw, { 'x-cal-signature-256': sign(raw, secret) }); await lafter._idle(); return r; };

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
const reset = () => { store._resetMemory(); sent.length = alertsSent.length = published.length = calBookingPosts.length = 0; for (const k of Object.keys(threads)) delete threads[k]; for (const k of Object.keys(calStatus)) delete calStatus[k]; for (const k of Object.keys(calEventType)) delete calEventType[k]; rescheduleCalls.length = 0; takenStarts.length = 0; refuseStarts.length = 0; noNewUid = false; for (const k of Object.keys(calStart)) delete calStart[k]; calNoMeet.clear(); for (const k of Object.keys(calByEmail)) delete calByEmail[k]; gmailFailures = 0; gmailFailStatus = 500; gmailLateReply = false; publishDown = false; metaCalls.length = 0; calMode = 'ok'; slotsMode = 'ok'; calUpcoming.length = 0; calUpcomingDown = false; };

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

test('8.1: a cancelled booking and another event send nothing', async () => {
  reset();
  for (const raw of [
    JSON.stringify({ triggerEvent: 'BOOKING_RESCHEDULED', payload: JSON.parse(webhookBody({ eventTypeId: 111 })).payload }),
    JSON.stringify({ triggerEvent: 'BOOKING_CANCELLED', payload: JSON.parse(webhookBody()).payload }),
    webhookBody({ eventTypeId: 111 })
  ]) assert.strictEqual((await sendWebhook(raw)).status, 200);
  assert.strictEqual(sent.length, 0);
});

// ---------- A moved call: one email with the new time ----------
const movedBody = (uid, fromUid, startIso) => JSON.stringify({ triggerEvent: 'BOOKING_RESCHEDULED', payload: Object.assign(JSON.parse(webhookBody({ uid, startTime: startIso })).payload, { rescheduleUid: fromUid }) });
async function atTime(iso, fn) {
  const realNow = Date.now;
  Date.now = () => new Date(iso).getTime();
  try { return await fn(); } finally { Date.now = realNow; }
}
const NEW_START = '2026-11-28T06:00:00.000Z'; // Sat 28 Nov, 11:30 am IST
const NEWER_START = '2026-11-29T08:30:00.000Z'; // Sun 29 Nov, 2:00 pm IST
const movedEmails = () => sent.filter(e => /^Your call is moved to /.test(e.subject));

test('moved: our second email hadn\'t gone, so the moved email replaces it at the second email\'s time', async () => {
  reset();
  calStart['bk-m2'] = NEW_START;
  await atTime('2026-11-25T04:30:00.000Z', () => sendWebhook(webhookBody({ uid: 'bk-m1', startTime: '2026-11-27T06:00:00.000Z' }))); // booked 10 am IST
  const secondDue = new Date('2026-11-25T09:30:00.000Z').getTime(); // 5 hours later
  await atTime('2026-11-25T06:00:00.000Z', () => sendWebhook(movedBody('bk-m2', 'bk-m1', NEW_START)));
  assert.strictEqual(movedEmails().length, 0, 'not sent at once');
  assert.strictEqual(published.filter(p => p.notBefore * 1000 === secondDue).length, 2, 'the second email and the moved email, both at the second email\'s time');
  await atTime('2026-11-25T09:30:00.000Z', () => runQueue());
  assert.strictEqual(sent.length, 2, 'the booking email and the moved email: the lead gets one, not two');
  const e = movedEmails()[0];
  assert.strictEqual(e.subject, 'Your call is moved to Sat 28 Nov at 11:30 am IST');
  assert.match(e.text, /^Hi Asha,\n\nShubhang here\. Your call is now rescheduled to Saturday, 28 November, at 11:30 am IST\. I’ll be on the call with you myself\. Looking forward to it\.\n\nHere’s the Google Meet link: https:\/\/meet\.google\.com\/live-link\n\nIf you have any questions before then, just reply here\.\n\nSee you then,\nShubhang$/);
  assert.ok(!e.inReplyTo, 'its own email, with its own subject');
});

test('moved: our second email already went, so the moved email goes right after the move; each move sends one', async () => {
  reset();
  calStart['bk-n1'] = '2026-11-27T06:00:00.000Z'; calStart['bk-n2'] = NEW_START; calStart['bk-n3'] = NEWER_START;
  await atTime('2026-11-25T04:30:00.000Z', () => sendWebhook(webhookBody({ uid: 'bk-n1', startTime: '2026-11-27T06:00:00.000Z' })));
  await atTime('2026-11-25T09:30:00.000Z', () => runQueue());
  assert.strictEqual(sent.length, 2, 'booking email and second email');
  await atTime('2026-11-25T12:00:00.000Z', () => sendWebhook(movedBody('bk-n2', 'bk-n1', NEW_START))); // 5:30 pm IST
  assert.strictEqual(movedEmails().length, 1);
  await atTime('2026-11-25T12:00:00.000Z', () => sendWebhook(movedBody('bk-n2', 'bk-n1', NEW_START))); // the same webhook again
  assert.strictEqual(movedEmails().length, 1, 'the same move twice: one email');
  await atTime('2026-11-25T13:00:00.000Z', () => sendWebhook(movedBody('bk-n3', 'bk-n2', NEWER_START)));
  assert.strictEqual(movedEmails().length, 2, 'moved again: one new email');
  assert.strictEqual(movedEmails()[1].subject, 'Your call is moved to Sun 29 Nov at 2:00 pm IST');
  await atTime('2026-11-25T13:30:00.000Z', () => runQueue());
  assert.strictEqual(movedEmails().length, 2);
});

test('moved: a move at night (9 pm to 8 am in the lead\'s zone) waits until 8 am', async () => {
  reset();
  calStart['bk-o2'] = NEW_START;
  await atTime('2026-11-25T17:00:00.000Z', () => sendWebhook(movedBody('bk-o2', 'bk-unknown', NEW_START))); // 10:30 pm IST
  assert.strictEqual(movedEmails().length, 0);
  assert.ok(published.some(p => p.notBefore * 1000 === new Date('2026-11-26T02:30:00.000Z').getTime()), 'due 8 am IST');
  await atTime('2026-11-26T02:30:00.000Z', () => runQueue());
  assert.strictEqual(movedEmails().length, 1);
});

test('moved twice before the waiting moved email went: one email, with the latest time', async () => {
  reset();
  calStart['bk-p2'] = NEW_START; calStart['bk-p3'] = NEWER_START;
  await atTime('2026-11-25T04:30:00.000Z', () => sendWebhook(webhookBody({ uid: 'bk-p1', startTime: '2026-11-27T06:00:00.000Z' })));
  await atTime('2026-11-25T06:00:00.000Z', () => sendWebhook(movedBody('bk-p2', 'bk-p1', NEW_START)));
  await atTime('2026-11-25T07:00:00.000Z', () => sendWebhook(movedBody('bk-p3', 'bk-p2', NEWER_START)));
  assert.strictEqual(movedEmails().length, 0, 'both wait for the second email\'s time');
  await atTime('2026-11-25T09:30:00.000Z', () => runQueue());
  assert.strictEqual(sent.length, 2);
  assert.strictEqual(movedEmails()[0].subject, 'Your call is moved to Sun 29 Nov at 2:00 pm IST');
});

test('moved: a moved call that was then cancelled sends nothing', async () => {
  reset();
  calStart['bk-q2'] = NEW_START;
  await atTime('2026-11-25T17:00:00.000Z', () => sendWebhook(movedBody('bk-q2', 'bk-q1', NEW_START)));
  calStatus['bk-q2'] = 'cancelled';
  await atTime('2026-11-26T02:30:00.000Z', () => runQueue());
  assert.strictEqual(movedEmails().length, 0);
});

// ---------- Moved-call review fixes (21 Nov) ----------
const toAsha = () => sent.filter(e => e.to === 'asha@example.com');
const movedBodyWith = (uid, fromUid, startIso, edit) => { const b = JSON.parse(movedBody(uid, fromUid, startIso)); edit(b.payload); return JSON.stringify(b); };
const lwebhookMod = require(path.join(tmp, 'lib', 'webhook.js'));

test('moved fix 1: Gmail sends the moved email but answers too late: never sent again, one "may not have gone" alert', async () => {
  reset();
  calStart['bk-s2'] = NEW_START;
  gmailLateReply = true;
  await atTime('2026-11-25T12:00:00.000Z', () => sendWebhook(movedBody('bk-s2', 'bk-s1', NEW_START))); // 5:30 pm IST: goes now
  await atTime('2026-11-25T12:05:00.000Z', () => runQueue()); // the retries and the 10-minute check
  assert.strictEqual(movedEmails().length, 1, 'only once');
  assert.deepStrictEqual(alertsSent.map(x => x.subject), ['Moved-call email may not have gone']);
  assert.match(alertsSent[0].text, /^Moved-call email may not have gone: Asha Rao, Sat 28 Nov at 11:30 am \(the new time\)\. .*Check Sent in Gmail; if it isn't there, send it by hand\.$/);
});

test('moved fix 1: a Gmail 503 is never resent (one "may not have gone" alert); a clear 4xx refusal is retried and sent once', async () => {
  reset();
  calStart['bk-s4'] = NEW_START;
  gmailFailures = 1; gmailFailStatus = 503;
  await atTime('2026-11-25T12:00:00.000Z', () => sendWebhook(movedBody('bk-s4', 'bk-s3', NEW_START)));
  await atTime('2026-11-25T12:05:00.000Z', () => runQueue());
  assert.strictEqual(movedEmails().length, 0);
  assert.deepStrictEqual(alertsSent.map(x => x.subject), ['Moved-call email may not have gone']);

  reset();
  calStart['bk-s6'] = NEW_START;
  gmailFailures = 1; gmailFailStatus = 429;
  await atTime('2026-11-25T12:00:00.000Z', () => sendWebhook(movedBody('bk-s6', 'bk-s5', NEW_START)));
  await atTime('2026-11-25T12:05:00.000Z', () => runQueue());
  assert.strictEqual(movedEmails().length, 1, 'sent on the retry, once');
  assert.strictEqual(alertsSent.length, 0);
});

test('moved fix 2: a call moved to before the email\'s planned time gets its email right away (by day and at night)', async () => {
  reset();
  const EARLY = '2026-11-25T08:00:00.000Z'; // 1:30 pm IST, before the second email's 3 pm
  calStart['bk-e2'] = EARLY;
  await atTime('2026-11-25T04:30:00.000Z', () => sendWebhook(webhookBody({ uid: 'bk-e1', startTime: '2026-11-27T06:00:00.000Z' })));
  await atTime('2026-11-25T06:00:00.000Z', () => sendWebhook(movedBody('bk-e2', 'bk-e1', EARLY)));
  assert.strictEqual(movedEmails().length, 1, 'sent at once');
  assert.strictEqual(movedEmails()[0].subject, 'Your call is moved to Wed 25 Nov at 1:30 pm IST');
  await atTime('2026-11-25T09:30:00.000Z', () => runQueue());
  assert.strictEqual(toAsha().length, 2, 'the booking email and the moved email, no second email');

  reset();
  const DAWN = '2026-11-26T01:30:00.000Z'; // 7 am IST, before the 8 am hold
  calStart['bk-e4'] = DAWN;
  await atTime('2026-11-25T17:00:00.000Z', () => sendWebhook(movedBody('bk-e4', 'bk-e3', DAWN))); // 10:30 pm IST
  assert.strictEqual(movedEmails().length, 1, 'not held to 8 am: the call is at 7 am');
});

test('moved fix 2: a waiting moved email whose call already started is not sent, and Shubhang is told', async () => {
  reset();
  calStart['bk-t2'] = NEW_START;
  await atTime('2026-11-25T17:00:00.000Z', () => sendWebhook(movedBody('bk-t2', 'bk-t1', NEW_START))); // waits for 8 am
  await atTime('2026-11-28T07:00:00.000Z', () => runQueue()); // the queue only ran after the call
  assert.strictEqual(movedEmails().length, 0);
  assert.deepStrictEqual(alertsSent.map(x => x.subject), ['Moved-call email not sent']);
  assert.match(alertsSent[0].text, /The call came before the email's planned time, so it was not sent\./);
});

test('moved fix 3: the booking email still retrying when the call is moved stops; the moved email is the one the lead gets', async () => {
  reset();
  calStart['bk-f2'] = NEW_START;
  gmailFailures = 1; // the booking email's first try fails (a retry is queued)
  await atTime('2026-11-25T04:30:00.000Z', () => sendWebhook(webhookBody({ uid: 'bk-f1', startTime: '2026-11-27T06:00:00.000Z' })));
  await atTime('2026-11-25T04:31:00.000Z', () => sendWebhook(movedBody('bk-f2', 'bk-f1', NEW_START)));
  await atTime('2026-11-25T04:32:00.000Z', () => runQueue());
  assert.deepStrictEqual(toAsha().map(e => e.subject), ['Your call is moved to Sat 28 Nov at 11:30 am IST']);
  assert.strictEqual(alertsSent.length, 0);
});

test('moved fix 3: a booking email retry checks Cal.com: cancelled or at another time, it stops; Cal.com down, it still goes', async () => {
  for (const scenario of ['cancelled', 'time-changed', 'cal-down']) {
    reset();
    gmailFailures = 1;
    await sendWebhook(webhookBody({ uid: 'bk-g-' + scenario }));
    if (scenario === 'cancelled') calStatus['bk-g-cancelled'] = 'cancelled';
    if (scenario === 'time-changed') calStart['bk-g-time-changed'] = '2026-11-12T10:35:00.000Z';
    const realFetchMock = global.fetch;
    if (scenario === 'cal-down') global.fetch = async (url, opts) => (/api\.cal\.com\/v2\/bookings\/bk-g/.test(String(url)) ? json({ error: 'down' }, 500) : realFetchMock(url, opts));
    try { await runQueue(() => toAsha().length > 0); } finally { global.fetch = realFetchMock; } // Cal.com is down only for the retry
    const firsts = toAsha().filter(e => /is scheduled for/.test(e.subject));
    assert.strictEqual(firsts.length, scenario === 'cal-down' ? 1 : 0, scenario);
    assert.strictEqual(alertsSent.length, 0, scenario + ': no alert');
  }
});

test('moved fix 4: a bad time zone falls back to India time', async () => {
  reset();
  calStart['bk-z2'] = NEW_START;
  await atTime('2026-11-25T06:00:00.000Z', () => sendWebhook(movedBodyWith('bk-z2', 'bk-z1', NEW_START, p => { p.attendees[0].timeZone = 'Not/AZone'; })));
  assert.deepStrictEqual(movedEmails().map(e => e.subject), ['Your call is moved to Sat 28 Nov at 11:30 am IST']);
  assert.strictEqual((await store.get('booking:bk-z2')).tz, 'Asia/Kolkata');
  reset();
  await sendWebhook(webhookBody({ uid: 'bk-z3', attendees: [{ name: 'Asha Rao', email: 'asha@example.com', timeZone: 'Not/AZone' }] }));
  assert.strictEqual((await store.get('booking:bk-z3')).tz, 'Asia/Kolkata', 'the booking webhook too');
  assert.match(toAsha()[0].subject, /4:05 pm IST$/);
});

test('moved fix 4: the move can\'t be recorded: Shubhang is alerted with the new time', async () => {
  reset();
  const realSet = store.set;
  store.set = async (key, obj, opts) => { if (key === 'booking:bk-h2') throw new Error('store down'); return realSet(key, obj, opts); };
  try {
    const r = await atTime('2026-11-25T06:00:00.000Z', () => sendWebhook(movedBody('bk-h2', 'bk-h1', NEW_START)));
    assert.strictEqual(r.status, 200);
  } finally { store.set = realSet; }
  assert.strictEqual(movedEmails().length, 0);
  assert.deepStrictEqual(alertsSent.map(x => x.subject), ['Moved-call email not queued']);
  assert.match(alertsSent[0].text, /^Moved-call email not queued: Asha Rao, now Sat 28 Nov at 11:30 am IST\. The move couldn't be recorded \(store down\), so no email with the new time will go\. Send it by hand\.$/);
});

test('moved fix 4: Cal.com sends the move again and the first try never queued the email: queued now, still sent once', async () => {
  reset();
  calStart['bk-r2'] = NEW_START;
  const raw = movedBody('bk-r2', 'bk-r1', NEW_START);
  const first = await atTime('2026-11-25T06:00:00.000Z', () => lwebhookMod.accept(JSON.parse(raw))); // recorded, then the function stopped
  assert.strictEqual(first.result, 'accepted:moved');
  assert.strictEqual(movedEmails().length, 0);
  await atTime('2026-11-25T06:10:00.000Z', () => sendWebhook(raw));
  assert.strictEqual(movedEmails().length, 1, 'queued (and sent) on the repeat');
  await atTime('2026-11-25T06:20:00.000Z', () => sendWebhook(raw));
  await atTime('2026-11-25T06:30:00.000Z', () => runQueue());
  assert.strictEqual(movedEmails().length, 1, 'never twice');
});

test('moved fix 5: no Meet link on the moved booking: the email says it\'s in the invite, and Shubhang is alerted', async () => {
  reset();
  calStart['bk-k2'] = NEW_START; calNoMeet.add('bk-k2');
  await atTime('2026-11-25T06:00:00.000Z', () => sendWebhook(movedBodyWith('bk-k2', 'bk-k1', NEW_START, p => { delete p.videoCallData; })));
  assert.strictEqual(movedEmails().length, 1);
  assert.match(movedEmails()[0].text, /The Google Meet link is in your calendar invite\./);
  await new Promise(r => setTimeout(r, 50)); // the alert is sent alongside, not waited for
  assert.deepStrictEqual(alertsSent.map(x => x.subject), ['Meet link missing: Asha Rao']);
});

test('8.2: the second email goes under the first, in the same thread, with Re:', async () => {
  reset();
  await sendWebhook(webhookBody());
  const results = await runQueue();
  // 10-minute checks (nothing to alert), the late bounce checks at 4 h and 24 h after each email, and the second email
  assert.deepStrictEqual(results.sort(), ['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'sent']);
  assert.strictEqual(sent.length, 2);
  const [first, second] = sent;
  assert.strictEqual(second.subject, 'Re: ' + first.subject);
  assert.strictEqual(second.threadId, first.threadId);
  assert.strictEqual(second.inReplyTo, `<${first.id}@mail.gmail.com>`);
  assert.match(second.text, /Shubhang here\. I’ll be on the call with you myself, on Wednesday, 11 November, at 4:05 pm IST/);
  assert.match(second.text, /https:\/\/meet\.google\.com\/live-link/);
});

test('8.2: no second email when the booking was cancelled or moved, or someone replied in the thread', async () => {
  for (const scenario of ['cancelled', 'time-changed', 'replied']) {
    reset();
    await sendWebhook(webhookBody({ uid: 'bk-' + scenario }));
    if (scenario === 'cancelled') calStatus['bk-cancelled'] = 'cancelled';
    else if (scenario === 'time-changed') calStart['bk-time-changed'] = '2026-11-12T10:35:00.000Z'; // still booked, but at another time
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

test('8.2: the queue fails after the booking email went: Shubhang is alerted to send the second email by hand', async () => {
  reset();
  publishDown = true; // the queue refuses new jobs, so the 5-hour email can't be queued
  await sendWebhook(webhookBody({ uid: 'bk-noqueue' }));
  publishDown = false;
  assert.strictEqual(sent.filter(e => e.to === 'asha@example.com').length, 1, 'the booking email went');
  const a = alertsSent.filter(x => /Second email not scheduled/.test(x.subject));
  assert.strictEqual(a.length, 1, 'one alert');
  assert.match(a[0].text, /^Second email not scheduled: Asha Rao, Wed 11 Nov at 4:05 pm\. .*Send it by hand around .* IST, as a reply under the first\.$/);
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

test('8.3: a nudge-link booking: Meta\'s Schedule event reuses each saved ad detail the new visit lacks (fbclid -> fbc)', async () => {
  reset();
  const body = lead({ email: 'sched@example.com', name: 'Sam Das', fbc: '', sv_attrib: { utm_source: 'facebook', fbclid: 'SAVEDCLICK', first_seen: '1763000000000' } });
  await post('/api/lead', body);
  await post('/api/lead-signal', { kind: 'didnt_book', lead_event_id: body.lead_event_id });
  await runQueueUntil(() => sent.some(e => /One step left/.test(e.subject) && e.to === 'sched@example.com'));
  const code = sent.find(e => /One step left/.test(e.subject) && e.to === 'sched@example.com').text.match(/\?r=([A-Za-z0-9_-]{22})/)[1];
  metaCalls.length = 0;
  // the new visit has only its own campaign, no click id and no fbc cookie
  const slot = { resume_code: code, slotDate: day(), slotTime: '11:00 AM', bookedSlot: 'x', timezone: 'Asia/Kolkata', sv_attrib: { utm_campaign: 'new-campaign' } };
  assert.strictEqual((await (await post('/api/submit-lead', slot)).json()).success, true);
  await new Promise(r => setTimeout(r, 150));
  const schedule = metaCalls.find(c => c.event.event_name === 'Schedule');
  assert.ok(schedule, 'Schedule sent');
  assert.match(String(schedule.event.user_data.fbc || ''), /SAVEDCLICK$/, 'the saved click id made it to Meta');
  // and the booking metadata (already key by key) agrees
  assert.strictEqual(calBookingPosts[0].metadata.fbclid, 'SAVEDCLICK');
  assert.strictEqual(calBookingPosts[0].metadata.utm_campaign, 'new-campaign');
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

test('8.3: nudge 1 went but nudge 2 could not be queued: the retry never sends nudge 1 again, it only queues nudge 2', async () => {
  reset();
  const b = lead({ email: 'twice@example.com', name: 'Tara Iyer' });
  await post('/api/lead', b);
  await post('/api/lead-signal', { kind: 'didnt_book', lead_event_id: b.lead_event_id });
  // the queue goes down the moment nudge 1's job starts: nudge 1 is sent, queuing nudge 2 fails
  const job = published.find(p => !p.ran);
  job.ran = true;
  publishDown = true;
  const raw = JSON.stringify({ jobId: job.jobId });
  await post('/api/jobs/run', raw, { 'upstash-signature': qstashSig(raw) });
  publishDown = false;
  const nudges = () => sent.filter(e => e.to === 'twice@example.com' && /One step left/.test(e.subject));
  assert.strictEqual(nudges().length, 1, 'nudge 1 went');
  const code = nudges()[0].text.match(/\?r=([A-Za-z0-9_-]{22})/)[1];
  // the retry
  const before = published.length;
  assert.strictEqual(await tasks.runTask('nudge1', code, 2), 'sent');
  assert.strictEqual(nudges().length, 1, 'still one nudge 1');
  assert.strictEqual(published.length, before + 1, 'nudge 2 is queued now');
});

test('8.3: nudge 1 went but saving "sent" failed: never sent again, and Shubhang is told nudge 2 is not queued', async () => {
  reset();
  const b = lead({ email: 'unsure@example.com', name: 'Uma Sen' });
  await post('/api/lead', b);
  await post('/api/lead-signal', { kind: 'didnt_book', lead_event_id: b.lead_event_id });
  const nudges = () => sent.filter(e => e.to === 'unsure@example.com' && /One step left/.test(e.subject));
  // the store refuses the "sent" save (twice) right after Gmail sent it
  const realUpdate = store.update;
  store.update = async (key, patch) => { if (patch && patch.nudge1 && patch.nudge1.sentAt) throw new Error('store down'); return realUpdate(key, patch); };
  try {
    const job = published.find(p => !p.ran); job.ran = true;
    const raw = JSON.stringify({ jobId: job.jobId });
    await post('/api/jobs/run', raw, { 'upstash-signature': qstashSig(raw) });
  } finally { store.update = realUpdate; }
  assert.strictEqual(nudges().length, 1, 'Gmail sent it once');
  const code = nudges()[0].text.match(/\?r=([A-Za-z0-9_-]{22})/)[1];
  const a = alertsSent.filter(x => /Nudge 2 not queued/.test(x.subject));
  assert.strictEqual(a.length, 1);
  assert.match(a[0].text, /^Nudge 2 not queued: Uma Sen, Skyline Homes\. Nudge 1 went, but saving that it went failed, so nudge 2 could not be queued\. If they haven’t booked or replied by tomorrow, WhatsApp them\.$/);
  // no retry was queued; even a stray one never sends it again
  assert.notStrictEqual(await tasks.runTask('nudge1', code, 2), 'sent');
  await runQueue();
  assert.strictEqual(nudges().length, 1, 'never a second nudge 1');
  assert.strictEqual(alertsSent.filter(x => /may not have gone|Nudge email not sent/.test(x.subject)).length, 0, 'no wrong "unsure" or "not sent" alert');

  // Gmail clearly fails once: the claim is cleared, so the retry sends it (once)
  reset();
  const b2 = lead({ email: 'retry@example.com', name: 'Ravi Nair' });
  await post('/api/lead', b2);
  await post('/api/lead-signal', { kind: 'didnt_book', lead_event_id: b2.lead_event_id });
  gmailFailures = 1; gmailFailStatus = 429;
  await runQueue();
  gmailFailures = 0;
  assert.strictEqual(sent.filter(e => e.to === 'retry@example.com' && /^One step left/.test(e.subject)).length, 1, 'sent on the retry, once');
  assert.strictEqual(alertsSent.length, 0);
});

test('8.3: Gmail sends nudge 1 but answers too late (timeout): the claim stays, the retry never sends it again, Shubhang is asked to check', async () => {
  reset();
  const b = lead({ email: 'late@example.com', name: 'Lata Iyer' });
  await post('/api/lead', b);
  await post('/api/lead-signal', { kind: 'didnt_book', lead_event_id: b.lead_event_id });
  gmailLateReply = true;
  await runQueue();
  assert.strictEqual(sent.filter(e => e.to === 'late@example.com' && /One step left/.test(e.subject)).length, 1, 'only once');
  const a = alertsSent.filter(x => /may not have gone/.test(x.subject));
  assert.strictEqual(a.length, 1);
  assert.match(a[0].text, /^Nudge email may not have gone: Lata Iyer, Skyline Homes\. .*Check Sent in Gmail; if it isn't there, WhatsApp them instead\. Nudge 2 was not queued either: if they haven’t booked or replied by tomorrow, WhatsApp them\.$/);
});

test('8.3: a lead who booked gets no "unsure" alert, even with a claim left from a lost Gmail answer', async () => {
  reset();
  const b = lead({ email: 'bookedlate@example.com', name: 'Bina Shah' });
  await post('/api/lead', b);
  await post('/api/lead-signal', { kind: 'didnt_book', lead_event_id: b.lead_event_id });
  gmailLateReply = true;
  const job = published.find(p => !p.ran); job.ran = true;
  const raw = JSON.stringify({ jobId: job.jobId });
  await post('/api/jobs/run', raw, { 'upstash-signature': qstashSig(raw) });
  calByEmail['bookedlate@example.com'] = [{ createdAt: Date.now(), start: Date.now() + 86400000, status: 'accepted' }];
  await runQueue();
  assert.strictEqual(alertsSent.filter(x => /may not have gone/.test(x.subject)).length, 0, 'booked is checked first');
  assert.strictEqual(sent.filter(e => e.to === 'bookedlate@example.com').length, 1);
});

test('8.3: Gmail clearly refused and clearing the claim also failed: reported as "not sent", never as "unsure"', async () => {
  reset();
  const b = lead({ email: 'stuck@example.com', name: 'Sara Das' });
  await post('/api/lead', b);
  await post('/api/lead-signal', { kind: 'didnt_book', lead_event_id: b.lead_event_id });
  gmailFailures = 1; gmailFailStatus = 400;
  const realUpdate = store.update;
  store.update = async (key, patch) => { if (patch && patch.nudge1Sending === null) throw new Error('store down'); return realUpdate(key, patch); };
  try { await runQueue(); } finally { store.update = realUpdate; gmailFailures = 0; }
  assert.strictEqual(sent.filter(e => e.to === 'stuck@example.com').length, 0);
  assert.deepStrictEqual(alertsSent.map(x => x.subject), ['Nudge email not sent']);
  assert.strictEqual(alertsSent[0].text, 'Nudge email not sent: Sara Das, Skyline Homes. WhatsApp them two times instead.');
});

test('8.3: Gmail answers 500 or 503 (a server error): treated like a timeout, never resent, one "may not have gone" alert', async () => {
  for (const status of [500, 503]) {
    reset();
    const email = `err${status}@example.com`;
    const b = lead({ email, name: 'Esha Pai' });
    await post('/api/lead', b);
    await post('/api/lead-signal', { kind: 'didnt_book', lead_event_id: b.lead_event_id });
    gmailFailures = 1; gmailFailStatus = status;
    await runQueue(); // the nudge, its retries and the 10-minute check
    gmailFailures = 0;
    assert.strictEqual(sent.filter(e => e.to === email).length, 0, status + ': not sent again after the server error');
    assert.deepStrictEqual(alertsSent.map(x => x.subject), ['Nudge email may not have gone'], status + ': one alert, the right one');
  }
});

test('8.3: nudge 1 went, saving "sent" failed and the task state could not be saved either: one alert only, never a wrong "not sent"', async () => {
  reset();
  const b = lead({ email: 'onealert@example.com', name: 'Om Joshi' });
  await post('/api/lead', b);
  await post('/api/lead-signal', { kind: 'didnt_book', lead_event_id: b.lead_event_id });
  const realUpdate = store.update;
  // during nudge 1's run the store refuses both the "sent" save and the task's "failed" state, so the 10-minute
  // check (run later, once the store is back) still finds "claimed"
  store.update = async (key, patch) => {
    if (patch && ((patch.nudge1 && patch.nudge1.sentAt) || patch.status === 'failed')) throw new Error('store down');
    return realUpdate(key, patch);
  };
  try {
    const job = published.find(p => !p.ran); job.ran = true;
    const raw = JSON.stringify({ jobId: job.jobId });
    await post('/api/jobs/run', raw, { 'upstash-signature': qstashSig(raw) });
  } finally { store.update = realUpdate; }
  assert.strictEqual((await store.get(`task:nudge1:${(await store.get('job:' + published[0].jobId)).payload.key}`)).status, 'claimed', 'the check will find "claimed"');
  await runQueue(); // the 10-minute check
  assert.strictEqual(sent.filter(e => e.to === 'onealert@example.com').length, 1, 'nudge 1 went once');
  assert.deepStrictEqual(alertsSent.map(x => x.subject), ['Nudge 2 not queued'], 'only the right alert; the 10-minute check adds nothing');
});

test('8.3: the 10-minute check finds a nudge Gmail was asked to send: "may not have gone", never "not sent"', async () => {
  reset();
  const b = lead({ email: 'checkclaim@example.com', name: 'Kiran Bose' });
  await post('/api/lead', b);
  await post('/api/lead-signal', { kind: 'didnt_book', lead_event_id: b.lead_event_id });
  // the nudge's task is claimed and Gmail was asked to send it, then the function stopped (no answer, no retry)
  const job = published.find(p => !p.ran);
  const jobRec = await store.get('job:' + job.jobId);
  const nudgeCode = jobRec.payload.key;
  await store.set(`task:nudge1:${nudgeCode}`, { status: 'claimed', claimedAt: Date.now() });
  await store.update('nudge:' + nudgeCode, { nudge1Sending: Date.now() });
  assert.strictEqual(await tasks.runCheck('nudge1', nudgeCode), 'alerted');
  assert.deepStrictEqual(alertsSent.map(x => x.subject), ['Nudge email may not have gone']);
});

test('8.3: nudge 1 went but nudge 2 could never be queued: after the last try, "Nudge 2 not queued", never "Nudge email not sent"', async () => {
  reset();
  const b = lead({ email: 'noqueue2@example.com', name: 'Neel Rao' });
  await post('/api/lead', b);
  await post('/api/lead-signal', { kind: 'didnt_book', lead_event_id: b.lead_event_id });
  const job = published.find(p => !p.ran); job.ran = true;
  const nudgeCode = (await store.get('job:' + job.jobId)).payload.key;
  publishDown = true; // the queue is down for nudge 1's run and every retry
  try {
    const raw = JSON.stringify({ jobId: job.jobId });
    await post('/api/jobs/run', raw, { 'upstash-signature': qstashSig(raw) });
    assert.strictEqual(await tasks.runTask('nudge1', nudgeCode, 2), 'retry');
    assert.strictEqual(await tasks.runTask('nudge1', nudgeCode, 3), 'failed');
  } finally { publishDown = false; }
  assert.strictEqual(sent.filter(e => e.to === 'noqueue2@example.com').length, 1, 'nudge 1 went once');
  assert.deepStrictEqual(alertsSent.map(x => x.subject), ['Nudge 2 not queued']);
  assert.strictEqual(alertsSent[0].text, 'Nudge 2 not queued: Neel Rao, Skyline Homes. Nudge 1 went, but nudge 2 could not be queued. If they haven’t booked or replied by tomorrow, WhatsApp them.');
  assert.strictEqual(await tasks.runCheck('nudge1', nudgeCode), 'ok');
});

test('8.3: a failing nudge is tried 3 times, then Shubhang is alerted with the brief\'s words', async () => {
  reset();
  const b = lead({ email: 'fail@example.com', name: 'Fay Roy' });
  await post('/api/lead', b);
  await post('/api/lead-signal', { kind: 'didnt_book', lead_event_id: b.lead_event_id });
  gmailFailures = 99; gmailFailStatus = 403;
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

test('26 Nov email check: a domain that takes no mail is refused, a typo of a common provider gets "Did you mean", anything unsure goes through', async () => {
  const ec = require(path.join(tmp, 'lib', 'emailcheck.js'));
  assert.strictEqual(ec.suggest('a@gmial.com'), 'a@gmail.com');
  assert.strictEqual(ec.suggest('a@gamil.com'), 'a@gmail.com');
  assert.strictEqual(ec.suggest('a@gmail.co'), 'a@gmail.com');
  assert.strictEqual(ec.suggest('a@gmail.con'), 'a@gmail.com');
  assert.strictEqual(ec.suggest('a@yahooo.com'), 'a@yahoo.com');
  assert.strictEqual(ec.suggest('a@hotmial.com'), 'a@hotmail.com');
  assert.strictEqual(ec.suggest('a@outlok.com'), 'a@outlook.com');
  for (const ok of ['a@gmail.com', 'a@mail.com', 'a@gmx.com', 'a@sahajta.com', 'a@yahoo.co.in', 'a@me.com', 'a@company.in']) assert.strictEqual(ec.suggest(ok), '', ok);

  const ask = async (email, headers) => { const r = await post('/api/check-email', { email }, headers); return { status: r.status, body: await r.json() }; };
  assert.deepStrictEqual((await ask('jinal@handsintechmology.nomail.test')).body, { ok: false, reason: 'no-domain', suggestion: '' });
  assert.deepStrictEqual((await ask('rohan@skyline.in')).body, { ok: true, reason: 'ok', suggestion: '' });
  assert.deepStrictEqual((await ask('rohan@gmial.com')).body, { ok: true, reason: 'ok', suggestion: 'rohan@gmail.com' });
  const t0 = Date.now();
  assert.deepStrictEqual((await ask('rohan@slow.test')).body, { ok: true, reason: 'unsure', suggestion: '' }, 'slow DNS: never blocks');
  assert.ok(Date.now() - t0 < 4000);
  assert.deepStrictEqual((await ask('not an email')).body, { ok: true, reason: 'unsure', suggestion: '' });

  // the resolver's other answers: exists with no mail servers but an address -> ok; a "null MX" -> none; any other error -> unsure
  const fake = (mx, a) => ({ resolveMx: mx, resolve4: a });
  ec._clearCache();
  assert.strictEqual(await ec.domainStatus('x1.test', { resolver: fake(async () => { throw Object.assign(new Error(''), { code: 'ENODATA' }); }, async () => ['192.0.2.9']) }), 'ok');
  assert.strictEqual(await ec.domainStatus('x2.test', { resolver: fake(async () => [{ exchange: '.', priority: 0 }], async () => ['192.0.2.9']) }), 'none');
  assert.strictEqual(await ec.domainStatus('x3.test', { resolver: fake(async () => { throw Object.assign(new Error(''), { code: 'ESERVFAIL' }); }, async () => []) }), 'unsure');
  assert.strictEqual(await ec.domainStatus('x4.test', { resolver: fake(async () => { throw Object.assign(new Error(''), { code: 'ENODATA' }); }, async () => { throw Object.assign(new Error(''), { code: 'ENODATA' }); }) }), 'none');
});

test('26 Nov a booking with an email whose domain takes no mail: asked to fix the email (time kept), Cal.com never called', async () => {
  reset();
  const r = await post('/api/submit-lead', bookingBody({ email: 'jinal.p@handsintechmology.nomail.test', name: 'Jinal P' }));
  assert.strictEqual(r.status, 400);
  const body = await r.json();
  assert.strictEqual(body.code, 'email');
  assert.match(body.error, /check it and try again\. Your time is kept\./);
  assert.strictEqual(calBookingPosts.length, 0);
});

test('26 Nov Cal.com refuses because of the email: asked to fix it (time kept), the alert gives Cal.com\'s reason; another refusal keeps the normal error with its reason', async () => {
  reset();
  calMode = 'refuse-email';
  const r = await post('/api/submit-lead', bookingBody({ email: 'bounce@skyline.in', name: 'Email Person' }));
  assert.strictEqual(r.status, 400);
  assert.strictEqual((await r.json()).code, 'email');
  assert.ok(await waitFor(() => sent.some(e => e.subject === 'A booking could not be made' && /Email Person/.test(e.text))));
  const mail = sent.find(e => /Email Person/.test(e.text));
  assert.match(mail.text, /Cal\.com said: status 400: Attendee email domain cannot receive emails/);
  assert.match(mail.text, /asked to fix their email and book again/);

  reset();
  calMode = 'refuse';
  const r2 = await post('/api/submit-lead', bookingBody({ email: 'taken@skyline.in', name: 'Taken Person' }));
  assert.strictEqual(r2.status, 502);
  assert.strictEqual((await r2.json()).code, 'booking');
  assert.ok(await waitFor(() => sent.some(e => /Taken Person/.test(e.text))));
  assert.match(sent.find(e => /Taken Person/.test(e.text)).text, /Cal\.com said: status 400: slot taken[\s\S]*Please reach out to this person\./);
});

test('26 Nov "check your email" only for Cal.com\'s real email refusal: another refusal that names the email gets the normal "pick a time again", with Cal.com\'s reason in the alert', async () => {
  reset();
  calMode = 'refuse-contact';
  const r = await post('/api/submit-lead', bookingBody({ email: 'contact@skyline.in', name: 'Contact Person' }));
  assert.strictEqual(r.status, 502);
  assert.strictEqual((await r.json()).code, 'booking', 'not "check your email"');
  assert.ok(await waitFor(() => sent.some(e => e.subject === 'A booking could not be made' && /Contact Person/.test(e.text))));
  const mail = sent.find(e => /Contact Person/.test(e.text)).text;
  assert.match(mail, /Cal\.com said: status 400: Attendee email or phone number properties wrong/);
  assert.match(mail, /Please reach out to this person\./);

  const is = app._isEmailRefusal;
  for (const yes of ['status 400: Attendee email domain cannot receive emails', 'status 400: Email is not deliverable', 'status 400: Invalid email address',
    'status 400: The email address is not valid', 'status 400: Email domain does not exist', "status 400: email domain doesn't exist", 'status 400: No MX record for email domain', 'status 400: Please enter a valid email'])
    assert.strictEqual(is(yes), true, yes);
  for (const no of ['status 400: Attendee email or phone number properties wrong. They must have at least one contact method (email or phone number).',
    "status 400: Attendee with this email can't book because the maximum number of active bookings has been reached.",
    'status 400: slot taken', 'status 409: Booking already exists', 'status 400: Invalid time slot', 'status 500: Internal server error', '', 'status 400: email'])
    assert.strictEqual(is(no), false, no);
});

test('27 Nov one upcoming call per person: the same email -> no new booking, their call and reschedule link shown, one alert, nudges stopped', async () => {
  reset();
  const start = new Date(Date.now() + 2 * 86400000).toISOString();
  calByEmail['nandu@skyline.in'] = [{ uid: 'bk-nandu-1', createdAt: new Date().toISOString(), start, status: 'accepted' }];
  const b = bookingBody({ email: 'nandu@skyline.in', name: 'Nandu Wankhade', whatsapp_number: '9811110000' });
  const r = await post('/api/submit-lead', b);
  assert.strictEqual(r.status, 409);
  const body = await r.json();
  assert.strictEqual(body.code, 'already-booked');
  assert.match(body.error, /^You already have a call booked for \w{3} \d{1,2} \w{3} at \d{1,2}:\d{2} (am|pm) IST\.$/);
  assert.strictEqual(body.existing.rescheduleUrl, 'https://cal.com/reschedule/bk-nandu-1');
  assert.strictEqual(calBookingPosts.length, 0, 'no new Cal.com booking');
  assert.ok(await waitFor(() => sent.some(e => e.subject === 'Tried to book again')));
  assert.match(sent.find(e => e.subject === 'Tried to book again').text, /Nandu Wankhade tried to book another call but already has one on .* \(same email\)\. No new booking was made\./);
  assert.ok(await store.get('booked:nandu@skyline.in'), 'marked booked: no nudges');
  assert.strictEqual(metaCalls.length, 0, 'no Schedule');
  await post('/api/submit-lead', b); // the same try again: still one alert
  await new Promise(x => setTimeout(x, 100));
  assert.strictEqual(sent.filter(e => e.subject === 'Tried to book again').length, 1);
});

test('27 Nov one upcoming call per person: another email with the same WhatsApp number (any format) -> no new booking and no details shown', async () => {
  reset();
  const start = new Date(Date.now() + 3 * 86400000).toISOString();
  calUpcoming.push({ uid: 'bk-other', status: 'accepted', start, attendees: [{ email: 'first@skyline.in', name: 'Nandu' }], bookingFieldsResponses: { notes: 'Company or project: Skyline\nWhatsApp: +91 98111 10000\nWhat’s happening right now: x' } });
  const r = await post('/api/submit-lead', bookingBody({ email: 'second@skyline.in', whatsapp_number: '9811110000' }));
  assert.strictEqual(r.status, 409);
  const body = await r.json();
  assert.strictEqual(body.code, 'already-booked');
  assert.strictEqual(body.error, 'You already have a call booked with us.');
  assert.strictEqual(body.existing, null, 'no time, no link for a phone match');
  assert.ok(!JSON.stringify(body).includes('bk-other'));
  assert.strictEqual(calBookingPosts.length, 0);
  assert.ok(await waitFor(() => sent.some(e => e.subject === 'Tried to book again' && /\(same phone\)/.test(e.text))));
});

test('27 Nov one upcoming call per person: a cancelled call, a call that already passed, another person, or Cal.com down -> they book as normal', async () => {
  const cases = [
    ['cancelled', () => { calByEmail['a1@skyline.in'] = [{ uid: 'x1', createdAt: new Date().toISOString(), start: new Date(Date.now() + 86400000).toISOString(), status: 'cancelled' }]; }, 'a1@skyline.in', '9811110001'],
    ['passed', () => { calByEmail['a2@skyline.in'] = [{ uid: 'x2', createdAt: new Date().toISOString(), start: new Date(Date.now() - 3600000).toISOString(), status: 'accepted' }]; }, 'a2@skyline.in', '9811110002'],
    ['another person', () => { calUpcoming.push({ uid: 'x3', status: 'accepted', start: new Date(Date.now() + 86400000).toISOString(), attendees: [{ email: 'z@other.in' }], bookingFieldsResponses: { notes: 'WhatsApp: +91 99999 88888' } }); }, 'a3@skyline.in', '9811110003'],
    ['Cal.com down', () => { calUpcomingDown = true; }, 'a4@skyline.in', '9811110004']
  ];
  for (const [label, setup, email, phone] of cases) {
    reset();
    setup();
    const r = await post('/api/submit-lead', bookingBody({ email, whatsapp_number: phone }));
    assert.strictEqual(r.status, 200, label);
    assert.strictEqual(calBookingPosts.length, 1, label + ': booked');
  }
});

test('27 Nov one upcoming call per person: a booking from a nudge link with an upcoming call -> no new booking, the code is not used up', async () => {
  reset();
  const body = lead({ email: 'nudged@skyline.in', whatsapp_number: '9811110005' });
  await post('/api/lead', body);
  await post('/api/lead-signal', { kind: 'didnt_book', lead_event_id: body.lead_event_id });
  const code = (await store.get('nudgelead:' + body.lead_event_id)).code;
  calByEmail['nudged@skyline.in'] = [{ uid: 'bk-n', createdAt: new Date().toISOString(), start: new Date(Date.now() + 86400000).toISOString(), status: 'accepted' }];
  const r = await post('/api/submit-lead', { resume_code: code, slotDate: day(), slotTime: '11:00 AM', timezone: 'Asia/Kolkata', schedule_event_id: crypto.randomUUID() });
  assert.strictEqual(r.status, 409);
  assert.strictEqual((await r.json()).code, 'already-booked');
  assert.strictEqual(calBookingPosts.length, 0);
  const n = await store.get('nudge:' + code);
  assert.ok(n.booked && !n.used, 'nudges stop; the link still opens');
});

test('27 Nov Cal.com\'s own 1-booking limit refuses: "You already have a call booked", never "check your email"; the call shown when it can be found', async () => {
  reset();
  calMode = 'refuse-limit';
  const r = await post('/api/submit-lead', bookingBody({ email: 'limit@skyline.in', name: 'Limit Person', whatsapp_number: '9811110006' }));
  assert.strictEqual(r.status, 409);
  const body = await r.json();
  assert.strictEqual(body.code, 'already-booked');
  assert.strictEqual(body.error, 'You already have a call booked with us.');
  assert.strictEqual(body.existing, null);
  assert.ok(await waitFor(() => sent.some(e => e.subject === 'Tried to book again' && /Limit Person/.test(e.text))));
  assert.match(sent.find(e => e.subject === 'Tried to book again').text, /\(Cal\.com’s 1-booking limit\)/);
  assert.ok(!sent.some(e => e.subject === 'A booking could not be made'));

  reset();
  calMode = 'refuse-limit-found';
  const r2 = await post('/api/submit-lead', bookingBody({ email: 'race@skyline.in', whatsapp_number: '9811110007' }));
  assert.strictEqual(r2.status, 409);
  const b2 = await r2.json();
  assert.match(b2.error, /^You already have a call booked for /);
  assert.strictEqual(b2.existing.rescheduleUrl, 'https://cal.com/reschedule/bk-race');
});

test('4 no Cal.com key: the booking fails with the normal error, never a fake "booked", and Shubhang gets the details', async () => {
  reset();
  const key = process.env.CAL_API_KEY;
  delete process.env.CAL_API_KEY;
  try {
    const r = await post('/api/submit-lead', bookingBody({ email: 'nokey@example.com', name: 'No Key' }));
    assert.strictEqual(r.status, 503);
    assert.strictEqual(calBookingPosts.length, 0);
    assert.ok(await waitFor(() => sent.some(e => e.subject === 'A booking could not be made' && /No Key/.test(e.text))));
    assert.strictEqual(metaCalls.length, 0, 'no Schedule for a failed booking');
  } finally { process.env.CAL_API_KEY = key; }
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
  const r1 = await realFetch(base + '/api/available-slots?month=2026-11&timeZone=Asia/Kolkata');
  // a failure, not "no open times": the form then shows "We couldn't load open times" and "Try again"
  assert.strictEqual(r1.status, 503);
  assert.deepStrictEqual(await r1.json(), { ok: false, error: 'slots-unavailable' });
  await realFetch(base + '/api/available-slots?month=2026-11&timeZone=Asia/Kolkata');
  assert.ok(await waitFor(() => sent.some(e => e.subject === 'Open times are not loading')));
  await new Promise(r => setTimeout(r, 150));
  assert.strictEqual(sent.filter(e => e.subject === 'Open times are not loading').length, 1);
  assert.ok(alertsSent.some(a => a.subject === 'Open times are not loading'), 'the backup alert path too');
  // Cal.com working with no free times is still a normal, empty answer
  slotsMode = 'ok';
  const r2 = await realFetch(base + '/api/available-slots?month=2026-11&timeZone=Asia/Kolkata');
  assert.strictEqual(r2.status, 200);
});

test('7.4 a bad time zone (or month) is refused with an error and sends no "Open times are not loading" alert', async () => {
  reset();
  for (const q of ['month=2026-11&timeZone=Not/AZone', 'month=2026-11&timeZone=%3Cscript%3E', 'month=2026-13&timeZone=Asia/Kolkata', 'month=abc&timeZone=Asia/Kolkata']) {
    const r = await realFetch(base + '/api/available-slots?' + q);
    assert.strictEqual(r.status, 400, q);
  }
  await new Promise(r => setTimeout(r, 150));
  assert.strictEqual(sent.filter(e => e.subject === 'Open times are not loading').length, 0);
  assert.strictEqual(alertsSent.length, 0);
  // a real zone still works
  assert.strictEqual((await realFetch(base + '/api/available-slots?month=2026-11&timeZone=Asia/Dubai')).status, 200);
});

test('reschedule with our own picker: moves the booking through Cal.com; refuses a taken time, a cancelled booking, another event, a bad request', async () => {
  reset();
  // two days from now at 11:30 am IST, as the picker sends it
  const day = new Date(Date.now() + 2 * 86400000 + 5.5 * 3600000).toISOString().slice(0, 10);
  const startIso = new Date(day + 'T06:00:00.000Z').toISOString(); // 11:30 am IST
  const body = (over) => Object.assign({ uid: 'bk-move', slotDate: day, slotTime: '11:30 AM', timezone: 'Asia/Kolkata' }, over || {});
  const go = async (b) => { const r = await post('/api/reschedule', b); return { status: r.status, d: await r.json() }; };
  const soon = new Date(Date.now() + 86400000).toISOString();
  for (const u of ['bk-move', 'bk-gone', 'bk-other']) calStart[u] = soon; // the current calls are tomorrow

  const ok = await go(body());
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(ok.d, { ok: true, uid: 'bk-move-moved', start: startIso });
  assert.deepStrictEqual(rescheduleCalls[0], { uid: 'bk-move', start: startIso });

  takenStarts.push(startIso);
  assert.deepStrictEqual((await go(body())).d, { ok: false, code: 'taken' });
  takenStarts.length = 0;

  calStatus['bk-gone'] = 'cancelled';
  assert.strictEqual((await go(body({ uid: 'bk-gone' }))).d.code, 'not-booked');
  calEventType['bk-other'] = 999;
  assert.strictEqual((await go(body({ uid: 'bk-other' }))).d.code, 'not-found');
  assert.strictEqual((await go(body({ uid: 'x' }))).status, 400);
  assert.strictEqual((await go(body({ slotTime: 'soon' }))).status, 400);
  assert.strictEqual((await go(body({ slotDate: '2020-01-01' }))).d.code, 'time');
  assert.strictEqual((await post('/api/reschedule', body(), { Origin: 'https://evil.example' })).status, 403);
  assert.strictEqual(rescheduleCalls.length, 2, 'only the two real attempts reached Cal.com');

  // not real times
  for (const t of ['0:30 AM', '11:99 AM', '13:00 PM', '11:60 AM']) assert.strictEqual((await go(body({ slotTime: t }))).d.code, 'invalid', t);
  // a call that already happened can't be moved
  calStart['bk-old'] = new Date(Date.now() - 3600000).toISOString();
  assert.strictEqual((await go(body({ uid: 'bk-old' }))).d.code, 'past');
  // Cal.com refuses but the time is still open: not "taken", so the page shows the Cal.com link
  refuseStarts.push(startIso);
  assert.deepStrictEqual((await go(body())).d, { ok: false, code: 'failed' });
  refuseStarts.length = 0;
  // no new uid from Cal.com: looked up again by the attendee's email
  noNewUid = true;
  calByEmail['move@example.com'] = [{ uid: 'bk-move', start: soon, status: 'cancelled' }, { uid: 'bk-move-found', start: startIso, status: 'accepted' }];
  assert.deepStrictEqual((await go(body())).d, { ok: true, uid: 'bk-move-found', start: startIso });
  noNewUid = false;
  // a light rate limit per address
  let last;
  for (let i = 0; i < 25; i++) last = await go(body({ slotTime: 'bad' }));
  assert.strictEqual(last.status, 429);
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

test('27 Nov Shubhang\'s Open times page: hidden (noindex, no link, not in robots.txt), no Pixel or Clarity, read-only on the form\'s open-times call in IST', async () => {
  for (const u of ['/open-times', '/open-times.html']) {
    const r = await realFetch(base + u);
    assert.strictEqual(r.status, 200, u);
    assert.strictEqual(r.headers.get('x-robots-tag'), 'noindex', u);
  }
  const html = await (await realFetch(base + '/open-times')).text();
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.ok(!/fbq|fbevents|clarity|sv-core|app\.js/.test(html), 'no Pixel, no Clarity, no form code');
  assert.ok(!/submit-lead|\/api\/lead|method:\s*'POST'/.test(html), 'nothing is sent, only read');
  assert.match(html, /\/api\/available-slots\?month=/);
  assert.match(html, /Asia\/Kolkata/);
  assert.doesNotThrow(() => new Function(html.split('<script>')[1].split('</script>')[0]), 'its script parses');
  assert.ok(!/open-times/.test(fs.readFileSync(path.join(root, 'public', 'robots.txt'), 'utf8')));
  for (const f of fs.readdirSync(path.join(root, 'public')).filter(f => f.endsWith('.html') && f !== 'open-times.html')) {
    assert.ok(!/open-times/.test(fs.readFileSync(path.join(root, 'public', f), 'utf8')), f + ' does not link to it');
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
