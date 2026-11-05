// Pure pieces: times, email words, signatures. Run with: npm test
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const t = require('../lib/time');
const emails = require('../lib/emails');
const scheduler = require('../lib/scheduler');
const webhook = require('../lib/webhook');
const gmail = require('../lib/gmail');

test('times are written one way: "12:25 pm", IST, or the city and "time"', () => {
  const d = new Date('2026-11-11T10:35:00.000Z');
  assert.deepStrictEqual(t.describe(d, 'Asia/Kolkata'), {
    weekday: 'Wednesday', dayLong: 'Wednesday, 11 November', dayShort: 'Wed 11 Nov', time: '4:05 pm', zone: 'IST'
  });
  const dubai = t.describe(new Date('2026-11-11T08:25:00.000Z'), 'Asia/Dubai');
  assert.strictEqual(dubai.time, '12:25 pm');
  assert.strictEqual(dubai.zone, 'Dubai time');
  assert.strictEqual(t.describe(d, 'America/New_York').zone, 'New York time');
  assert.strictEqual(t.describe(new Date('2026-11-11T18:30:00.000Z'), 'Asia/Calcutta').time, '12:00 am');
  assert.strictEqual(t.describe(new Date('2026-11-11T06:30:00.000Z'), 'Asia/Kolkata').time, '12:00 pm');
});

test('due between 9 pm and 8 am in the lead\'s zone: held until 8 am there', () => {
  // 9:30 pm IST on Wed 11 Nov -> 8:00 am IST Thu 12 Nov
  const nine30pm = new Date('2026-11-11T16:00:00.000Z');
  assert.strictEqual(t.holdToMorning(nine30pm, 'Asia/Kolkata').toISOString(), '2026-11-12T02:30:00.000Z');
  // 3 am IST Thu -> 8 am IST the same day
  const threeAm = new Date('2026-11-11T21:30:00.000Z');
  assert.strictEqual(t.holdToMorning(threeAm, 'Asia/Kolkata').toISOString(), '2026-11-12T02:30:00.000Z');
  // 2 pm IST: unchanged
  const twoPm = new Date('2026-11-11T08:30:00.000Z');
  assert.strictEqual(t.holdToMorning(twoPm, 'Asia/Kolkata').getTime(), twoPm.getTime());
  // exactly 8 am and 8:59 pm: unchanged; 9:00 pm: held
  assert.strictEqual(t.holdToMorning(new Date('2026-11-11T02:30:00.000Z'), 'Asia/Kolkata').getTime(), new Date('2026-11-11T02:30:00.000Z').getTime());
  assert.strictEqual(t.holdToMorning(new Date('2026-11-11T15:29:00.000Z'), 'Asia/Kolkata').getTime(), new Date('2026-11-11T15:29:00.000Z').getTime());
  assert.strictEqual(t.holdToMorning(new Date('2026-11-11T15:30:00.000Z'), 'Asia/Kolkata').toISOString(), '2026-11-12T02:30:00.000Z');
  // Dubai: 10 pm there
  assert.strictEqual(t.holdToMorning(new Date('2026-11-11T18:00:00.000Z'), 'Asia/Dubai').toISOString(), '2026-11-12T04:00:00.000Z');
});

test('left at 10 pm Monday: first nudge 8 am Tuesday, second about 10 am Wednesday', () => {
  const leftMonday10pm = new Date('2026-11-09T16:30:00.000Z'); // Mon 9 Nov, 10:00 pm IST
  const firstDue = t.holdToMorning(new Date(leftMonday10pm.getTime() + 3600 * 1000), 'Asia/Kolkata');
  assert.strictEqual(t.describe(firstDue, 'Asia/Kolkata').dayShort + ' ' + t.describe(firstDue, 'Asia/Kolkata').time, 'Tue 10 Nov 8:00 am');
  const second = t.nextDayTenAm(firstDue, 'Asia/Kolkata');
  assert.strictEqual(t.describe(second, 'Asia/Kolkata').dayShort + ' ' + t.describe(second, 'Asia/Kolkata').time, 'Wed 11 Nov 10:00 am');
});

test('IST day for the daily limit', () => {
  assert.strictEqual(t.istDay(new Date('2026-11-11T19:00:00.000Z')), '2026-11-12'); // 12:30 am IST next day
  assert.strictEqual(t.istDay(new Date('2026-11-11T10:00:00.000Z')), '2026-11-11');
});

const base = {
  first: 'Asha', d: t.describe(new Date('2026-11-11T10:35:00.000Z'), 'Asia/Kolkata'),
  meetLink: 'https://meet.google.com/abc-defg-hij', reschedLink: 'https://cal.com/reschedule/bk-1',
  preCallLink: 'https://warmchain.sahajta.com/thank-you', waLink: 'https://wa.me/919731173205?text=YES%2C%20x', videoSet: true
};

test('booking email: subject and key lines are the brief\'s words', () => {
  const e = emails.bookingEmail(base);
  assert.strictEqual(e.subject, 'Your Lead Conversion Clarity Call is scheduled for Wed 11 Nov, 4:05 pm IST');
  assert.match(e.text, /^Hi Asha, it’s Shubhang from Sahajta AI\. Thanks for booking your Lead Conversion Clarity Call\./);
  assert.match(e.text, /It’s scheduled for Wednesday, 11 November, at 4:05 pm IST \(45 minutes\), on Google Meet:\nhttps:\/\/meet\.google\.com\/abc-defg-hij/);
  assert.match(e.text, /1\. Watch the 2-minute video: https:\/\/warmchain\.sahajta\.com\/thank-you/);
  assert.match(e.text, /If you need to move the time, please reschedule before the call here:\nhttps:\/\/cal\.com\/reschedule\/bk-1/);
  assert.match(e.text, /See you on Wednesday,\nShubhang$/);
  assert.ok(!/confirmed|strategy call|free call|consultation/i.test(e.text));
});

test('booking email without a video: item 1 says "See what to expect"; no Meet link: the fallback line', () => {
  const e = emails.bookingEmail(Object.assign({}, base, { videoSet: false, meetLink: '' }));
  assert.match(e.text, /1\. See what to expect: https:\/\/warmchain\.sahajta\.com\/thank-you/);
  assert.match(e.text, /on Google Meet:\nThe Google Meet link is in your calendar invite\./);
});

test('booking email HTML: only the three headings in bold, WhatsApp link shown short', () => {
  const e = emails.bookingEmail(base);
  const html = emails.toHtml(e.text, e.boldLines);
  assert.strictEqual((html.match(/<b>/g) || []).length, 3);
  assert.match(html, /<b>1\. Map your lead journey<\/b>/);
  assert.match(html, /<a href="https:\/\/wa\.me\/919731173205\?text=YES%2C%20x">wa\.me\/919731173205<\/a>/);
  assert.ok(!/<img|<table|style=/.test(html));
  assert.ok(e.text.includes('https://wa.me/919731173205?text=YES%2C%20x')); // the plain copy has the full link
});

test('confirm message matches the page: zone added only outside India', () => {
  const ist = emails.confirmMessage('Asha', base.d, 'Asia/Kolkata');
  assert.strictEqual(ist, 'YES, confirming my Lead Conversion Clarity Call on Wed 11 Nov at 4:05 pm. Asha');
  const dubai = t.describe(new Date('2026-11-11T09:35:00.000Z'), 'Asia/Dubai');
  assert.strictEqual(emails.confirmMessage('Asha', dubai, 'Asia/Dubai'), 'YES, confirming my Lead Conversion Clarity Call on Wed 11 Nov at 1:35 pm Dubai time. Asha');
});

test('second email and nudges: subjects and sign-offs', () => {
  const s = emails.secondEmail({ first: 'Asha', d: base.d, meetLink: 'https://meet.google.com/x', firstSubject: 'S1' });
  assert.strictEqual(s.subject, 'Re: S1');
  assert.match(s.text, /Shubhang here\. I’ll be on the call with you myself, on Wednesday, 11 November, at 4:05 pm IST\. Looking forward to it\./);
  assert.match(s.text, /Here’s the Google Meet link: https:\/\/meet\.google\.com\/x/);
  const n1 = emails.nudge1Email({ first: 'Asha', link: 'https://x.test/?r=abc' });
  assert.strictEqual(n1.subject, 'One step left: pick a time for your call');
  assert.match(n1.text, /It takes 30 seconds\. Pick yours here:\nhttps:\/\/x\.test\/\?r=abc/);
  const n2 = emails.nudge2Email({ first: 'Asha', link: 'https://x.test/?r=abc' });
  assert.strictEqual(n2.subject, 'Re: One step left: pick a time for your call');
  assert.match(n2.text, /Every lead that waits is ad money you’ve already spent\./);
});

test('email to Shubhang about someone who did not book', () => {
  const lead = { name: 'Asha Rao', company: 'Skyline', email: 'a@b.co', whatsapp_number: '9876543210', q1_situation: 'Q1', q2_urgency: 'Q2' };
  const a = emails.leaveEmail('didnt_book', lead, emails.NUDGE_STARTED_LINE);
  assert.strictEqual(a.subject, 'Didn’t book: Asha Rao, Skyline');
  assert.ok(a.text.endsWith('They get our two nudge emails unless they book or reply.'));
  const b = emails.leaveEmail('no_times', lead, emails.NUDGE_NONE_LINE);
  assert.strictEqual(b.subject, 'No times shown: Asha Rao, Skyline');
  assert.ok(b.text.endsWith('No nudge emails for them: WhatsApp them yourself.'));
});

test('Cal.com webhook signature: right secret passes, wrong one does not', () => {
  const raw = '{"triggerEvent":"BOOKING_CREATED"}';
  const sig = crypto.createHmac('sha256', 's3cret').update(raw).digest('hex');
  assert.ok(webhook.verifySignature(raw, sig, 's3cret'));
  assert.ok(!webhook.verifySignature(raw, sig, 'other'));
  assert.ok(!webhook.verifySignature(raw + ' ', sig, 's3cret'));
  assert.ok(!webhook.verifySignature(raw, '', 's3cret'));
});

function qstashJwt(key, rawBody, over) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const claims = Object.assign({
    iss: 'Upstash', sub: 'https://x.test/api/jobs/run', exp: now + 300, nbf: now - 1, iat: now, jti: 'j1',
    body: crypto.createHash('sha256').update(rawBody).digest('base64url')
  }, over || {});
  const data = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64(claims);
  return data + '.' + crypto.createHmac('sha256', key).update(data).digest('base64url');
}

test('only the queue may start a job: QStash signature is checked', () => {
  process.env.QSTASH_CURRENT_SIGNING_KEY = 'cur';
  process.env.QSTASH_NEXT_SIGNING_KEY = 'next';
  const body = '{"jobId":"abc"}';
  assert.ok(scheduler.verifyQStash(body, qstashJwt('cur', body)));
  assert.ok(scheduler.verifyQStash(body, qstashJwt('next', body)));
  assert.ok(!scheduler.verifyQStash(body, qstashJwt('wrong', body)));
  assert.ok(!scheduler.verifyQStash('{"jobId":"zzz"}', qstashJwt('cur', body)));          // body changed
  assert.ok(!scheduler.verifyQStash(body, qstashJwt('cur', body, { exp: 1 })));           // expired
  assert.ok(!scheduler.verifyQStash(body, qstashJwt('cur', body, { sub: 'https://x.test/api/other' })));
  assert.ok(!scheduler.verifyQStash(body, ''));
});

test('Gmail MIME: reply headers, HTML with a plain copy, non-ASCII safe', () => {
  process.env.GMAIL_SENDER = 'shubhang@sahajta.com';
  const raw = gmail.buildMime({ to: 'a@b.co', subject: 'Re: One step left', text: 'Hi’ there', html: '<div>Hi’ there</div>', inReplyTo: '<m1@mail.gmail.com>' });
  assert.match(raw, /^From: Shubhang Sethi <shubhang@sahajta\.com>/);
  assert.match(raw, /In-Reply-To: <m1@mail\.gmail\.com>\r\nReferences: <m1@mail\.gmail\.com>/);
  assert.match(raw, /multipart\/alternative/);
  assert.match(raw, /text\/plain; charset="UTF-8"/);
  assert.match(raw, /text\/html; charset="UTF-8"/);
});
