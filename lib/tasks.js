// The four automatic emails and the way they run (Thank-you Page Brief v1, part 8).
// Every send is a "task": claimed before sending (set only if new, so it goes once), tried up to 3 times within
// 2 minutes, checked again after 10 minutes, and an alert goes to Shubhang if it still did not go.
const cfg = require('./config');
const t = require('./time');
const store = require('./store');
const gmail = require('./gmail');
const cal = require('./cal');
const emails = require('./emails');
const alerts = require('./alerts');
const scheduler = require('./scheduler');

const HOUR = 3600 * 1000;
const FIVE_HOURS = 5 * HOUR;
const STATE_TTL = 90 * 86400;

const bookingKey = (uid) => 'booking:' + uid;
const nudgeKey = (code) => 'nudge:' + code;

function videoIsSet() {
  return !!(process.env.BRIEFING_VIDEO_URL || '').trim();
}

function whatsappNumber() {
  let n = (process.env.WHATSAPP_NUMBER || '919731173205').replace(/\D/g, '');
  if (n.length === 10) n = '91' + n;
  return n;
}

function firstNameOf(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

async function sendMail(opts) {
  if (!gmail.isConfigured()) throw new Error('Gmail is not configured (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN)');
  const tpl = opts.tpl;
  return gmail.send({
    to: opts.to,
    subject: tpl.subject,
    text: tpl.text,
    html: emails.toHtml(tpl.text, tpl.boldLines),
    inReplyTo: opts.inReplyTo,
    threadId: opts.threadId
  });
}

// ---------- 8.1 The booking email, at once ----------
async function handleFirst(uid) {
  const rec = await store.get(bookingKey(uid));
  if (!rec) return 'stopped:no-record';
  if (rec.first && rec.first.sentAt) return 'sent';

  const d = t.describe(new Date(rec.startISO), rec.tz);
  const first = firstNameOf(rec.name);
  const message = emails.confirmMessage(first, d, rec.tz);
  const meetLink = rec.meetLink || '';
  const tpl = emails.bookingEmail({
    first, d, meetLink,
    reschedLink: `https://cal.com/reschedule/${encodeURIComponent(uid)}`,
    preCallLink: cfg.siteUrl() + '/thank-you',
    waLink: emails.whatsappLink(whatsappNumber(), message),
    videoSet: videoIsSet()
  });

  const sent = await sendMail({ to: rec.email, tpl });
  await store.update(bookingKey(uid), {
    first: { sentAt: Date.now(), gmailId: sent.id, threadId: sent.threadId, messageId: sent.messageId, subject: tpl.subject }
  });

  if (!meetLink) {
    alerts.send('Meet link missing: ' + rec.name,
      `The booking for ${rec.name} (${d.dayShort} at ${d.time} ${d.zone}) came without a Google Meet link, so the first email says "${emails.MEET_FALLBACK}"`,
      'meet:' + uid).catch(() => {});
  }

  // 5 hours after our first email went; due between 9 pm and 8 am in the lead's zone: 8 am
  const due = t.holdToMorning(new Date(Date.now() + FIVE_HOURS), rec.tz);
  await store.update(bookingKey(uid), { second: { dueAt: due.getTime() } });
  await scheduler.schedule('task', { name: 'second', key: uid }, due.getTime());
  return 'sent';
}

// ---------- 8.2 The second email, a reply under the first ----------
async function handleSecond(uid) {
  const rec = await store.get(bookingKey(uid));
  if (!rec || !rec.first || !rec.first.sentAt) return 'stopped:first-not-sent';
  const dueAt = rec.second && rec.second.dueAt;
  if (dueAt && Date.now() > dueAt + HOUR) return 'skipped:late';

  if (!cal.configured()) throw new Error('CAL_API_KEY is not set, so the booking cannot be checked');
  const booking = await cal.getBooking(uid);
  if (booking.status !== 'accepted') return 'stopped:' + (booking.status || 'not-booked');

  const ids = await gmail.threadMessageIds(rec.first.threadId);
  if (ids.some(id => id !== rec.first.gmailId)) return 'stopped:replied';

  const d = t.describe(new Date(rec.startISO), rec.tz);
  const tpl = emails.secondEmail({
    first: firstNameOf(rec.name), d, meetLink: booking.meetLink || rec.meetLink || '', firstSubject: rec.first.subject
  });
  const sent = await sendMail({ to: rec.email, tpl, inReplyTo: rec.first.messageId, threadId: rec.first.threadId });
  await store.update(bookingKey(uid), { second: Object.assign({}, rec.second, { sentAt: Date.now(), gmailId: sent.id }) });
  return 'sent';
}

// ---------- 8.3 The two nudges ----------
async function nudgeStopReason(n) {
  if (!n) return 'missing';
  if (n.used || n.booked) return 'booked';
  const flagged = await store.get('booked:' + String(n.lead.email).trim().toLowerCase());
  if (flagged) return 'booked';
  if (!cal.configured()) throw new Error('CAL_API_KEY is not set, so bookings cannot be checked');
  if (await cal.hasBookedOrUpcoming(n.lead.email, n.leftAt)) return 'booked';
  return null;
}

async function handleNudge1(code) {
  const n = await store.get(nudgeKey(code));
  const why = await nudgeStopReason(n);
  if (why) return 'stopped:' + why;
  if (n.nudge1Due && Date.now() > n.nudge1Due + HOUR) return 'skipped:late';

  const tpl = emails.nudge1Email({ first: firstNameOf(n.lead.name), link: `${cfg.siteUrl()}/?r=${code}` });
  const sent = await sendMail({ to: n.lead.email, tpl });

  const waits = cfg.nudgeTestWaits();
  const due = waits ? new Date(Date.now() + waits.second) : t.nextDayTenAm(new Date(), n.lead.timezone);
  await store.update(nudgeKey(code), {
    nudge1: { sentAt: Date.now(), gmailId: sent.id, threadId: sent.threadId, messageId: sent.messageId, subject: tpl.subject },
    nudge2Due: due.getTime()
  });
  await scheduler.schedule('task', { name: 'nudge2', key: code }, due.getTime());
  return 'sent';
}

async function handleNudge2(code) {
  const n = await store.get(nudgeKey(code));
  const why = await nudgeStopReason(n);
  if (why) return 'stopped:' + why;
  if (!n.nudge1 || !n.nudge1.sentAt) return 'stopped:first-not-sent';
  if (n.nudge2Due && Date.now() > n.nudge2Due + HOUR) return 'skipped:late';

  const ids = await gmail.threadMessageIds(n.nudge1.threadId);
  if (ids.some(id => id !== n.nudge1.gmailId)) return 'stopped:replied';

  const tpl = emails.nudge2Email({ first: firstNameOf(n.lead.name), link: `${cfg.siteUrl()}/?r=${code}` });
  const sent = await sendMail({ to: n.lead.email, tpl, inReplyTo: n.nudge1.messageId, threadId: n.nudge1.threadId });
  await store.update(nudgeKey(code), { nudge2: { sentAt: Date.now(), gmailId: sent.id } });
  return 'sent';
}

const HANDLERS = { first: handleFirst, second: handleSecond, nudge1: handleNudge1, nudge2: handleNudge2 };

// ---------- Alerts ----------
async function alertFor(name, key) {
  if (name === 'first' || name === 'second') {
    const rec = await store.get(bookingKey(key));
    const who = rec ? `${rec.name}, ${t.describe(new Date(rec.startISO), rec.tz).dayShort} at ${t.describe(new Date(rec.startISO), rec.tz).time}` : key;
    const text = name === 'first'
      ? `Booking email not sent: ${who}. Send both emails by hand: the first now, the second about 5 hours later, as a reply.`
      : `Second email not sent: ${who}. Send it by hand, as a reply under the first.`;
    return alerts.send(name === 'first' ? 'Booking email not sent' : 'Second email not sent', text, `${name}:${key}`);
  }
  const n = await store.get(nudgeKey(key));
  const who = n ? `${n.lead.name}, ${n.lead.company}` : key;
  return alerts.send('Nudge email not sent', `Nudge email not sent: ${who}. WhatsApp them two times instead.`, `${name}:${key}`);
}

// ---------- The runner ----------
async function runTask(name, key, attempt) {
  const stateKey = `task:${name}:${key}`;
  attempt = attempt || 1;

  if (attempt === 1) {
    const claimed = await store.set(stateKey, { status: 'claimed', claimedAt: Date.now() }, { nx: true, ttl: STATE_TTL });
    if (!claimed) return 'duplicate';
    await scheduler.schedule('check', { name, key }, Date.now() + 10 * 60 * 1000).catch(e => console.error('⚠️ [10-minute check not scheduled]:', e.message));
  } else {
    const st = await store.get(stateKey);
    if (!st || st.status !== 'claimed') return 'not-claimed';
  }

  try {
    const result = await HANDLERS[name](key);
    await store.update(stateKey, { status: result === 'sent' ? 'sent' : 'stopped', result, doneAt: Date.now() });
    // A nudge that could not go within an hour of its time is a failure (a stopped one is not)
    if (result === 'skipped:late' && name.startsWith('nudge')) await alertFor(name, key);
    console.log(`📧 [Email ${name}]: ${key} -> ${result}`);
    return result;
  } catch (err) {
    console.error(`❌ [Email ${name} attempt ${attempt}]: ${err.message}`);
    if (attempt < 3) {
      await scheduler.schedule('retry', { name, key, attempt: attempt + 1 }, Date.now() + (attempt === 1 ? 40 : 80) * 1000).catch(e => console.error('⚠️ [Retry not scheduled]:', e.message));
      return 'retry';
    }
    await store.update(stateKey, { status: 'failed', error: err.message, doneAt: Date.now() });
    await alertFor(name, key);
    return 'failed';
  }
}

// 10 minutes after each claim: a claimed email that never went gets an alert
async function runCheck(name, key) {
  const st = await store.get(`task:${name}:${key}`);
  if (st && st.status === 'claimed') {
    await store.update(`task:${name}:${key}`, { status: 'failed', error: 'not sent after 10 minutes' });
    await alertFor(name, key);
    return 'alerted';
  }
  return 'ok';
}

async function runJob(job) {
  if (!job) return 'unknown-job';
  const { name, key, attempt } = job.payload || {};
  if (job.kind === 'task') return runTask(name, key, 1);
  if (job.kind === 'retry') return runTask(name, key, attempt);
  if (job.kind === 'check') return runCheck(name, key);
  return 'unknown-kind';
}

module.exports = { runTask, runCheck, runJob, firstNameOf, bookingKey, nudgeKey, HANDLERS };
