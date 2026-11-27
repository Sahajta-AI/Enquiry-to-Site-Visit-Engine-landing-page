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
  assert.match(e.text, /1\. Watch the short video: https:\/\/warmchain\.sahajta\.com\/thank-you/);
  assert.match(e.text, /If you need to move the time, please reschedule before the call here:\nhttps:\/\/cal\.com\/reschedule\/bk-1/);
  assert.match(e.text, /See you on Wednesday,\nShubhang$/);
  assert.ok(!/confirmed|strategy call|free call|consultation/i.test(e.text));
});

test('booking email without a video: item 1 says "See what to expect"; no Meet link: the fallback line', () => {
  const e = emails.bookingEmail(Object.assign({}, base, { videoSet: false, meetLink: '' }));
  assert.match(e.text, /1\. See what to expect: https:\/\/warmchain\.sahajta\.com\/thank-you/);
  assert.match(e.text, /on Google Meet:\nThe Google Meet link is in your calendar invite\./);
});

test('booking email HTML: only the three headings in bold, short link text; the plain copy keeps the full links', () => {
  const e = emails.bookingEmail(base);
  const html = emails.toHtml(e.htmlText, e.boldLines);
  assert.strictEqual((html.match(/<b>/g) || []).length, 3);
  assert.match(html, /<b>1\. Map your lead journey<\/b>/);
  assert.match(html, /<a href="https:\/\/meet\.google\.com\/abc-defg-hij">Join on Google Meet<\/a>/);
  assert.match(html, /1\. <a href="https:\/\/warmchain\.sahajta\.com\/thank-you">Watch the short video<\/a>/);
  assert.match(html, /if you haven’t already: <a href="https:\/\/wa\.me\/919731173205\?text=YES%2C%20x">Confirm on WhatsApp<\/a>/);
  assert.match(html, /please reschedule before the call: <a href="https:\/\/cal\.com\/reschedule\/bk-1">Reschedule here<\/a>/);
  assert.ok(!/>https?:\/\//.test(html)); // no long link shown as text
  assert.ok(!/<img|<table|style=/.test(html));
  assert.ok(e.text.includes('https://wa.me/919731173205?text=YES%2C%20x'));
  assert.ok(e.text.includes('1. Watch the short video: https://warmchain.sahajta.com/thank-you'));
  const noVideo = emails.toHtml(emails.bookingEmail(Object.assign({}, base, { videoSet: false, meetLink: '' })).htmlText, []);
  assert.match(noVideo, /1\. <a href="[^"]+">See what to expect<\/a>/);
  assert.match(noVideo, /The Google Meet link is in your calendar invite\./);
});

test('second email HTML: Meet link shown as "Join on Google Meet"', () => {
  const e = emails.secondEmail(Object.assign({}, base, { firstSubject: 'x' }));
  assert.match(emails.toHtml(e.htmlText, []), /Here’s the Google Meet link: <a href="https:\/\/meet\.google\.com\/abc-defg-hij">Join on Google Meet<\/a>/);
  assert.ok(e.text.includes('https://meet.google.com/abc-defg-hij'));
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

const metaLib = require('../lib/meta');
const qualify = require('../lib/qualify');
const bookingmeta = require('../lib/bookingmeta');

test('5.3 hashing: email, phone, names exactly as the brief says', () => {
  const sha = (v) => require('crypto').createHash('sha256').update(v).digest('hex');
  assert.strictEqual(metaLib.hashEmail('  Rohan@Example.COM '), sha('rohan@example.com'));
  assert.strictEqual(metaLib.hashPhone('9876543210'), sha('919876543210'));          // 91 and the 10 digits
  assert.strictEqual(metaLib.hashPhone('+971 50 123 4567'), sha('971501234567'));
  assert.strictEqual(metaLib.hashPhone('+9710501234567'), sha('971501234567'));       // no 0 right after the country code
  assert.strictEqual(metaLib.hashPhone('+44 07700 900123'), sha('447700900123'));
  assert.strictEqual(metaLib.hashPhone('+1 415 555 0100'), sha('14155550100'));
  assert.strictEqual(metaLib.hashPhone(''), undefined);
  assert.deepStrictEqual(metaLib.nameParts('Rohan  Mehta-Rao'), { fn: 'rohan', ln: 'mehtarao' });
  assert.deepStrictEqual(metaLib.nameParts('Priya'), { fn: 'priya', ln: '' });
  assert.deepStrictEqual(metaLib.nameParts("D'Souza Ann"), { fn: 'dsouza', ln: 'ann' });
});

test('5.3 fbc: the cookie wins; otherwise fb.1.{first_seen ms}.{fbclid} with fbclid exactly as received', () => {
  assert.strictEqual(metaLib.buildFbc('fb.1.1.COOKIE', { fbclid: 'x' }), 'fb.1.1.COOKIE');
  const ms = Date.parse('2026-11-05T10:00:00.000Z');
  assert.strictEqual(metaLib.buildFbc('', { fbclid: 'AbC_xYz', first_seen: '2026-11-05T10:00:00.000Z' }), `fb.1.${ms}.AbC_xYz`);
  assert.strictEqual(metaLib.buildFbc('', {}), undefined);
});

test('5.5 qualified: both answers fit, compared exactly', () => {
  const fit1 = 'We run paid ads but leads go cold because follow-up is slow';
  const fit1b = 'We run paid ads but too few leads book or attend site visits';
  assert.ok(qualify.isQualified(fit1, 'As soon as possible'));
  assert.ok(qualify.isQualified(fit1b, 'Within the next 30 days'));
  assert.ok(!qualify.isQualified(fit1, 'Within the next 1 to 3 months'));
  assert.ok(!qualify.isQualified('We are still planning or exploring', 'As soon as possible'));
  assert.ok(!qualify.isQualified(fit1 + ' ', 'As soon as possible'), 'exact match only');
  assert.ok(qualify.q1Fits(fit1) && !qualify.q2Fits('x'));
});

test('6.2 Cal.com metadata limits: at most 50 keys, keys up to 40 characters, values up to 500', () => {
  const big = {};
  for (let i = 0; i < 60; i++) big['k' + i] = 'v';
  big['x'.repeat(41)] = 'too long a key';
  big.long = 'y'.repeat(900);
  const out = bookingmeta.limit(big);
  assert.ok(Object.keys(out).length <= 50);
  assert.ok(!('x'.repeat(41) in out));
  assert.strictEqual(out.long, undefined === out.long ? undefined : 'y'.repeat(500));
});

test('briefing video: hosted file by default, env overrides it, "none" hides it', () => {
  const lcfg = require(require('path').join(__dirname, '..', 'lib', 'config'));
  const keep = { u: process.env.BRIEFING_VIDEO_URL, p: process.env.BRIEFING_VIDEO_POSTER, c: process.env.BRIEFING_VIDEO_CAPTIONS };
  try {
    delete process.env.BRIEFING_VIDEO_URL; delete process.env.BRIEFING_VIDEO_POSTER; delete process.env.BRIEFING_VIDEO_CAPTIONS;
    assert.deepStrictEqual(lcfg.briefingVideo(), { url: '/videos/briefing-540.mp4', poster: '/videos/briefing-poster.jpg', captions: '/videos/briefing.vtt' });
    process.env.BRIEFING_VIDEO_URL = 'https://cdn.example.test/v.mp4';
    assert.deepStrictEqual(lcfg.briefingVideo(), { url: 'https://cdn.example.test/v.mp4', poster: '', captions: '' });
    process.env.BRIEFING_VIDEO_URL = 'none';
    assert.strictEqual(lcfg.briefingVideo().url, '');
  } finally {
    for (const [k, v] of [['BRIEFING_VIDEO_URL', keep.u], ['BRIEFING_VIDEO_POSTER', keep.p], ['BRIEFING_VIDEO_CAPTIONS', keep.c]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('sales video: no address plays the Mux stream, "none" hides it; poster and captions ship with the site', () => {
  const lcfg = require(require('path').join(__dirname, '..', 'lib', 'config'));
  const keep = process.env.SALES_VIDEO_URL;
  try {
    delete process.env.SALES_VIDEO_URL;
    const v = lcfg.salesVideo();
    assert.match(v.url, /^https:\/\/stream\.mux\.com\/[A-Za-z0-9]+\.m3u8$/);
    assert.strictEqual(v.poster, '/videos/sales-poster-start.webp');
    assert.strictEqual(v.captions, '/videos/sales.vtt');
    process.env.SALES_VIDEO_URL = 'none';
    assert.strictEqual(lcfg.salesVideo().url, '');
    process.env.SALES_VIDEO_URL = 'https://video.example.test/sales.mp4';
    assert.strictEqual(lcfg.salesVideo().url, 'https://video.example.test/sales.mp4');
  } finally { if (keep === undefined) delete process.env.SALES_VIDEO_URL; else process.env.SALES_VIDEO_URL = keep; }
});

test('"Didn\'t book" email: the answers in the words the person picked on screen, not the saved values', () => {
  const lead = { name: 'Asha Rao', company: 'Rao Estates', email: 'a@x.com', whatsapp_number: '9876543210',
    q1_situation: 'We run paid ads but leads go cold because follow-up is slow', q2_urgency: 'Within the next 30 days' };
  const e = emails.leaveEmail('didnt_book', lead, '');
  assert.match(e.text, /What’s happening right now: We run ads, but leads go cold because follow-up is slow\n/);
  assert.match(e.text, /When they’d want it running: Within 30 days$/);
});

test('the on-screen words in lib/qualify.js match the form exactly (every saved value, every label)', () => {
  const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const pairs = [...html.matchAll(/data-value="([^"]+)">\s*<span class="option-label-text">([^<]+)<\/span>/g)].map(m => [m[1], m[2]]);
  assert.strictEqual(pairs.length, 8);
  pairs.forEach(([value, label]) => assert.strictEqual(qualify.SHOWN[value], label, value));
  [...qualify.Q1_VALUES, ...qualify.Q2_VALUES].forEach(v => assert.ok(qualify.SHOWN[v], 'label for ' + v));
});

test('nudge-link booking: each saved ad-source detail this visit lacks is reused, one by one; this visit\'s own details win', () => {
  const prev = process.env.NEW_TRACKING;
  process.env.NEW_TRACKING = 'on';
  try {
    const nudgeRec = { lead: { sv_attrib: { utm_source: 'facebook', utm_campaign: 'saved-campaign', fbclid: 'SAVED', landing_url: 'https://warmchain.sahajta.com/?fbclid=SAVED' }, fbp: 'fb.1.1.saved', fbc: 'fb.1.1.SAVED' } };
    // this visit only has its own utm_campaign: the rest comes from the saved visit
    const md = bookingmeta.buildBookingMetadata({
      body: { sv_attrib: { utm_campaign: 'new-campaign' } }, req: { headers: {} }, nudgeRec, test: true, qualified: true, leadEventId: 'e1', scheduleId: 's1'
    });
    assert.strictEqual(md.utm_campaign, 'new-campaign', 'this visit wins');
    assert.strictEqual(md.utm_source, 'facebook', 'reused from the saved visit');
    assert.strictEqual(md.fbclid, 'SAVED');
    assert.strictEqual(md.landing_url, 'https://warmchain.sahajta.com/?fbclid=SAVED');
    assert.strictEqual(md.fbp, 'fb.1.1.saved');
    assert.strictEqual(md.fbc, 'fb.1.1.SAVED');
    assert.strictEqual(md.nudge, 'yes');
  } finally {
    if (prev === undefined) delete process.env.NEW_TRACKING; else process.env.NEW_TRACKING = prev;
  }
});

test('logs: emails, phone numbers and quoted values are masked; alert subjects lose the person', () => {
  const logsafe = require('../lib/logsafe');
  const s = logsafe.safe(`Odoo crm.lead/create: invalid value 'Asha Rao' for asha.rao+1@example.co.in, phone +91 98765 43210`);
  assert.ok(!/asha|Rao|example|98765/i.test(s), s);
  assert.match(s, /\[email\]/);
  assert.match(s, /\[number\]/);
  assert.strictEqual(logsafe.subjectOnly('Meet link missing: Asha Rao'), 'Meet link missing');
  assert.strictEqual(logsafe.subjectOnly('Didn’t book: Asha Rao, Rao Estates'), 'Didn’t book');
  assert.strictEqual(logsafe.safe('Cal.com booking lookup failed: 500'), 'Cal.com booking lookup failed: 500');
  assert.strictEqual(logsafe.maskCode('Ab3dEf9hIj2kLm5nOp7qRs'), 'Ab3d…');
  assert.strictEqual(logsafe.maskCode(''), '-');
});

test('reschedule pop-up: the booking page path comes from CAL_BOOKING_PAGE (a full cal.com address works too)', async () => {
  const cal = require('../lib/cal');
  const prev = process.env.CAL_BOOKING_PAGE;
  try {
    process.env.CAL_BOOKING_PAGE = 'https://cal.com/shubhang-sethi/enquiry-to-site-visit-engine/';
    assert.strictEqual(await cal.bookingPagePath(), 'shubhang-sethi/enquiry-to-site-visit-engine');
  } finally {
    if (prev === undefined) delete process.env.CAL_BOOKING_PAGE; else process.env.CAL_BOOKING_PAGE = prev;
  }
});

test('27 Nov /api/config never waits long for Cal.com: a slow Cal.com -> \'\' after maxWaitMs; once known, the path comes at once', async () => {
  const cal = require('../lib/cal');
  const saved = { page: process.env.CAL_BOOKING_PAGE, key: process.env.CAL_API_KEY, fetch: global.fetch };
  let calls = 0, slow = true;
  try {
    delete process.env.CAL_BOOKING_PAGE;
    process.env.CAL_API_KEY = process.env.CAL_API_KEY || 'test-key';
    global.fetch = async (url) => {
      if (!String(url).includes('/v2/event-types/')) return saved.fetch(url);
      calls++;
      if (slow) await new Promise(r => setTimeout(r, 400));
      return { ok: true, json: async () => ({ data: { bookingUrl: 'https://cal.com/shubhang-sethi/enquiry-to-site-visit-engine' } }) };
    };
    const t0 = Date.now();
    assert.strictEqual(await cal.bookingPagePath({ maxWaitMs: 100 }), '');
    assert.ok(Date.now() - t0 < 300, 'did not wait for Cal.com');
    await new Promise(r => setTimeout(r, 450)); // the lookup finishes in the background
    slow = false;
    const t1 = Date.now();
    assert.strictEqual(await cal.bookingPagePath({ maxWaitMs: 100 }), 'shubhang-sethi/enquiry-to-site-visit-engine');
    assert.ok(Date.now() - t1 < 50, 'saved: at once');
    assert.strictEqual(calls, 1, 'no second lookup while the saved one is fresh');
  } finally {
    global.fetch = saved.fetch;
    if (saved.page === undefined) delete process.env.CAL_BOOKING_PAGE; else process.env.CAL_BOOKING_PAGE = saved.page;
    if (saved.key === undefined) delete process.env.CAL_API_KEY; else process.env.CAL_API_KEY = saved.key;
  }
});

test('store counter: on Upstash the count and its expiry are set in one step (an address can never stay blocked)', async () => {
  const store = require('../lib/store');
  const saved = { url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN, fetch: global.fetch };
  const calls = [];
  process.env.UPSTASH_REDIS_REST_URL = 'https://store.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
  global.fetch = async (url, opts) => { calls.push(JSON.parse(opts.body)); return new Response(JSON.stringify({ result: 3 }), { status: 200 }); };
  try {
    assert.strictEqual(await store.incr('resched-ip:1.2.3.4', 600), 3);
    assert.strictEqual(calls.length, 1, 'one call, not INCR then EXPIRE');
    const [cmd, script, numKeys, key, ttl] = calls[0];
    assert.strictEqual(cmd, 'EVAL');
    assert.match(script, /INCR/);
    assert.match(script, /TTL/);
    assert.match(script, /EXPIRE/);
    assert.strictEqual(numKeys, '1');
    assert.match(key, /resched-ip:1\.2\.3\.4$/);
    assert.strictEqual(ttl, '600');
  } finally {
    global.fetch = saved.fetch;
    if (saved.url === undefined) delete process.env.UPSTASH_REDIS_REST_URL; else process.env.UPSTASH_REDIS_REST_URL = saved.url;
    if (saved.token === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN; else process.env.UPSTASH_REDIS_REST_TOKEN = saved.token;
  }
});
