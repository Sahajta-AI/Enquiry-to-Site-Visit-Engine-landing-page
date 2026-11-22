// The automatic emails and the way they run (Thank-you Page Brief v1, part 8).
// Every send is a "task": claimed before sending (set only if new, so it goes once), tried up to 3 times within
// 2 minutes, checked again after 10 minutes, and an alert goes to Shubhang if it still did not go.
const cfg = require('./config');
const logsafe = require('./logsafe');
const t = require('./time');
const store = require('./store');
const gmail = require('./gmail');
const cal = require('./cal');
const emails = require('./emails');
const alerts = require('./alerts');
const scheduler = require('./scheduler');
const odooleads = require('./odooleads');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let scheduleRetryMs = 2000;

const HOUR = 3600 * 1000;
const FIVE_HOURS = 5 * HOUR;
const STATE_TTL = 90 * 86400;

const bookingKey = (uid) => 'booking:' + uid;
const nudgeKey = (code) => 'nudge:' + code;

function videoIsSet() {
  return !!cfg.briefingVideo().url;
}

function whatsappNumber() {
  let n = (process.env.WHATSAPP_NUMBER || '919731173205').replace(/\D/g, '');
  if (n.length === 10) n = '91' + n;
  return n;
}

function firstNameOf(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

// "Odoo 6" (ODOO_V2 only): once Gmail accepted an email and it's saved as sent, it goes into the lead's log in Odoo.
// Never before, never for a failed email, and a failure here never touches the email (it's only logged).
async function logToOdoo(key, email, tpl) {
  try {
    await odooleads.logEmail({ key, email, test: cfg.isTest(email), subject: tpl.subject, text: tpl.text });
  } catch (err) {
    console.warn('⚠️ [Odoo email log]:', logsafe.safe(err.message));
  }
}

async function sendMail(opts) {
  if (!gmail.isConfigured()) throw Object.assign(new Error('Gmail is not configured (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN)'), { refused: true });
  const tpl = opts.tpl;
  return gmail.send({
    to: opts.to,
    subject: tpl.subject,
    text: tpl.text,
    html: emails.toHtml(tpl.htmlText || tpl.text, tpl.boldLines),
    inReplyTo: opts.inReplyTo,
    threadId: opts.threadId
  });
}

// ---------- 8.1 The booking email, at once ----------
async function handleFirst(uid, attempt) {
  const rec = await store.get(bookingKey(uid));
  if (!rec) return 'stopped:no-record';
  // Already sent (a retry): only make sure the second email is scheduled (not when the call was moved since:
  // the moved email replaces the second one)
  if (rec.first && rec.first.sentAt) {
    if (!rec.movedTo && !(rec.second && (rec.second.scheduled || rec.second.sentAt || rec.second.alerted))) await scheduleSecond(uid, rec);
    return 'sent';
  }
  // Moved before the booking email went: the moved email (with the new time) is the one the lead gets
  if (rec.movedTo) return 'stopped:moved';
  // A retry: check with Cal.com that the booking is still there at that time. If Cal.com can't be reached,
  // send as before (the lead must not go without a booking email).
  if (attempt > 1 && cal.configured()) {
    let booking = null;
    try { booking = await cal.getBooking(uid); } catch (err) { console.warn('⚠️ [Booking email retry]: Cal.com check failed, sending anyway:', logsafe.safe(err.message)); }
    if (booking) {
      if (booking.status === 'cancelled' || booking.status === 'rejected') return 'stopped:' + booking.status;
      const bookedAt = booking.start ? new Date(booking.start).getTime() : NaN;
      if (Number.isFinite(bookedAt) && bookedAt !== new Date(rec.startISO).getTime()) return 'stopped:time-changed';
    }
  }

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
  const firstRec = { sentAt: Date.now(), gmailId: sent.id, threadId: sent.threadId, messageId: sent.messageId, subject: tpl.subject };
  if (cfg.odooV2()) firstRec.text = tpl.text; // a brand-new booking's lead may come after the email: logged then
  await store.update(bookingKey(uid), { first: firstRec });
  await logToOdoo('first:' + uid, rec.email, tpl);

  if (!meetLink) {
    alerts.send('Meet link missing: ' + rec.name,
      `The booking for ${rec.name} (${d.dayShort} at ${d.time} ${d.zone}) came without a Google Meet link, so the first email says "${emails.MEET_FALLBACK}"`,
      'meet:' + uid).catch(() => {});
  }

  await scheduleSecond(uid, Object.assign({}, rec, { first: { sentAt: Date.now() } }));
  return 'sent';
}

// 5 hours after our first email went; due between 9 pm and 8 am in the lead's zone: 8 am.
// Tried twice; if the queue still fails, Shubhang gets an alert to send it by hand (never silently lost).
async function scheduleSecond(uid, rec) {
  const sentAt = (rec.first && rec.first.sentAt) || Date.now();
  const due = t.holdToMorning(new Date(sentAt + FIVE_HOURS), rec.tz);
  let lastErr;
  for (let i = 0; i < 2; i++) {
    try {
      await store.update(bookingKey(uid), { second: { dueAt: due.getTime() } });
      await scheduler.schedule('task', { name: 'second', key: uid }, due.getTime());
      await store.update(bookingKey(uid), { second: { dueAt: due.getTime(), scheduled: true } }).catch(() => {});
      return true;
    } catch (err) {
      lastErr = err;
      console.error(`❌ [Second email not scheduled, try ${i + 1}]: ${logsafe.safe(err.message)}`);
      if (i === 0) await sleep(scheduleRetryMs);
    }
  }
  const call = t.describe(new Date(rec.startISO), rec.tz);
  const when = t.describe(due, 'Asia/Kolkata');
  await alerts.send('Second email not scheduled',
    `Second email not scheduled: ${rec.name}, ${call.dayShort} at ${call.time}. The booking email went, but the 5-hour follow-up could not be queued (${lastErr && lastErr.message}). Send it by hand around ${when.dayShort} at ${when.time} IST, as a reply under the first.`,
    'second-sched:' + uid).catch(e => console.error('⚠️ [Alert failed]:', logsafe.safe(e.message)));
  await store.update(bookingKey(uid), { second: { dueAt: due.getTime(), alerted: true } }).catch(() => {});
  return false;
}

// ---------- 8.2 The second email, a reply under the first ----------
async function handleSecond(uid) {
  const rec = await store.get(bookingKey(uid));
  if (rec && rec.movedTo) return 'stopped:moved'; // the call was moved: the moved email replaces this one
  if (!rec || !rec.first || !rec.first.sentAt) return 'stopped:first-not-sent';
  const dueAt = rec.second && rec.second.dueAt;
  if (dueAt && Date.now() > dueAt + HOUR) return 'skipped:late';

  if (!cal.configured()) throw new Error('CAL_API_KEY is not set, so the booking cannot be checked');
  const booking = await cal.getBooking(uid);
  if (booking.status !== 'accepted') return 'stopped:' + (booking.status || 'not-booked');
  // The email names the day and time: send it only if the booking is still at that time
  const bookedAt = booking.start ? new Date(booking.start).getTime() : NaN;
  if (!Number.isFinite(bookedAt)) return 'stopped:time-unknown';
  if (bookedAt !== new Date(rec.startISO).getTime()) return 'stopped:time-changed';

  const ids = await gmail.threadMessageIds(rec.first.threadId);
  if (ids.some(id => id !== rec.first.gmailId)) return 'stopped:replied';

  const d = t.describe(new Date(rec.startISO), rec.tz);
  const tpl = emails.secondEmail({
    first: firstNameOf(rec.name), d, meetLink: booking.meetLink || rec.meetLink || '', firstSubject: rec.first.subject
  });
  const sent = await sendMail({ to: rec.email, tpl, inReplyTo: rec.first.messageId, threadId: rec.first.threadId });
  await store.update(bookingKey(uid), { second: Object.assign({}, rec.second, { sentAt: Date.now(), gmailId: sent.id }) });
  await logToOdoo('second:' + uid, rec.email, tpl);
  return 'sent';
}

// ---------- A moved call: one email with the new time ----------
// Claimed ("movedSending") before Gmail sends it, like the nudges: a retry that finds the claim with no "sent"
// never sends it again (Shubhang is asked to check Sent instead).
async function handleMoved(uid) {
  const rec = await store.get(bookingKey(uid));
  if (!rec) return 'stopped:no-record';
  if (rec.moved && rec.moved.sentAt) return 'sent';
  if (rec.movedTo) return 'stopped:moved-again'; // the newer move sends its own email
  if (!cal.configured()) throw new Error('CAL_API_KEY is not set, so the booking cannot be checked');
  let booking;
  try {
    booking = await cal.getBooking(uid);
  } catch (err) {
    if (rec.movedSending) return 'stopped:unsure'; // can't check now, and it may have gone: never resend
    throw err;
  }
  if (booking.status !== 'accepted') return 'stopped:' + (booking.status || 'not-booked');
  const bookedAt = booking.start ? new Date(booking.start).getTime() : NaN;
  if (Number.isFinite(bookedAt) && bookedAt !== new Date(rec.startISO).getTime()) return 'stopped:time-changed';
  if (rec.movedSending) return 'stopped:unsure';
  if (new Date(rec.startISO).getTime() <= Date.now()) return 'stopped:call-passed';

  const d = t.describe(new Date(rec.startISO), rec.tz);
  const meetLink = booking.meetLink || rec.meetLink || '';
  const tpl = emails.movedEmail({ first: firstNameOf(rec.name), d, meetLink });
  const sent = await sendOnce(bookingKey(uid), 'movedSending', () => sendMail({ to: rec.email, tpl }));
  // It went; if saving that fails, the claim still stops any second send
  await saveSentTo(bookingKey(uid), { moved: Object.assign({}, rec.moved, { sentAt: Date.now(), gmailId: sent.id, threadId: sent.threadId, messageId: sent.messageId, subject: tpl.subject }) })
    .catch(e => console.error('⚠️ [Moved email sent, not saved]:', logsafe.safe(e.message)));
  await logToOdoo('moved:' + uid, rec.email, tpl);

  if (!meetLink) {
    alerts.send('Meet link missing: ' + rec.name,
      `The moved booking for ${rec.name} (${d.dayShort} at ${d.time} ${d.zone}) came without a Google Meet link, so the moved email says "${emails.MEET_FALLBACK}"`,
      'meet:' + uid).catch(() => {});
  }
  return 'sent';
}

// Queued for its time (tried twice); if the queue fails, Shubhang is asked to send it by hand
async function scheduleMoved(uid, dueAt) {
  let lastErr;
  for (let i = 0; i < 2; i++) {
    try {
      await scheduler.schedule('task', { name: 'moved', key: uid }, dueAt);
      await store.update(bookingKey(uid), { moved: { dueAt, scheduled: true } }).catch(() => {});
      return 'scheduled';
    } catch (err) {
      lastErr = err;
      console.error(`❌ [Moved email not scheduled, try ${i + 1}]: ${logsafe.safe(err.message)}`);
      if (i === 0) await sleep(scheduleRetryMs);
    }
  }
  const rec = await store.get(bookingKey(uid)).catch(() => null);
  const call = rec ? t.describe(new Date(rec.startISO), rec.tz) : null;
  const when = t.describe(new Date(dueAt), 'Asia/Kolkata');
  await alerts.send('Moved-call email not scheduled',
    `Moved-call email not scheduled: ${rec ? `${rec.name}, now ${call.dayShort} at ${call.time}` : uid}. It could not be queued (${lastErr && lastErr.message}). Send it by hand around ${when.dayShort} at ${when.time} IST.`,
    'moved-sched:' + uid).catch(e => console.error('⚠️ [Alert failed]:', logsafe.safe(e.message)));
  await store.update(bookingKey(uid), { moved: { dueAt, alerted: true } }).catch(() => {});
  return 'alerted';
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

// A nudge is claimed ("sending") before Gmail sends it and marked "sent" right after. A retry that finds a claim with
// no "sent" can't tell whether Gmail sent it, so it never sends again: Shubhang is asked to check instead.
// The claim is cleared only when Gmail clearly refused (it answered with an error), so the normal retry still sends.
// A timeout or network error keeps the claim: Gmail may have sent it and only the answer was lost.
let saveRetryMs = 500;
// The same claim for any email: `recKey` is the record in the store, `claimKey` the field that holds the claim
async function sendOnce(recKey, claimKey, send) {
  const claimed = await store.update(recKey, { [claimKey]: Date.now() }); // if this fails, nothing was sent
  if (!claimed) throw new Error('The record is gone, so the email was not sent'); // never send unclaimed
  try {
    return await send();
  } catch (err) {
    if (!err.refused) throw err; // maybe sent: the retry finds the claim and asks Shubhang to check
    let cleared = false;
    for (let i = 0; i < 2 && !cleared; i++) {
      try { await store.update(recKey, { [claimKey]: null }); cleared = true; } catch (e) { if (i === 0) await sleep(saveRetryMs); }
    }
    // The claim couldn't be cleared: a retry would wrongly report "unsure". We know it did not go, so stop here
    // and say so plainly.
    if (!cleared) err.final = 'not-sent';
    throw err;
  }
}

// "Already booked" is checked first: someone who booked gets no nudge and no "unsure" alert.
// Then a claim with no "sent" means it may have gone: never send it a second time.
async function stopReasonOrUnsure(n, claimKey) {
  const claimed = !!(n && n[claimKey]);
  try {
    const why = await nudgeStopReason(n);
    if (why) return why;
  } catch (err) {
    if (claimed) return 'unsure'; // can't check bookings now, and it may have gone: ask Shubhang, never resend
    throw err;
  }
  return claimed ? 'unsure' : null;
}

async function saveSentTo(recKey, patch) {
  for (let i = 0; i < 2; i++) {
    try { await store.update(recKey, patch); return; } catch (err) { if (i === 0) await sleep(saveRetryMs); else throw err; }
  }
}
const saveSent = (code, patch) => saveSentTo(nudgeKey(code), patch);
const sendNudgeOnce = (code, field, send) => sendOnce(nudgeKey(code), field + 'Sending', send);

async function handleNudge1(code) {
  const n = await store.get(nudgeKey(code));
  // Already sent (a retry after a later step failed): never send it again, only make sure nudge 2 is queued
  if (n && n.nudge1 && n.nudge1.sentAt) {
    if (!n.nudge2Queued && !(n.nudge2 && n.nudge2.sentAt)) await queueNudge2(code, n.nudge2Due || nudge2DueFrom(n.nudge1.sentAt, n));
    return 'sent';
  }
  const why = await stopReasonOrUnsure(n, 'nudge1Sending');
  if (why) return 'stopped:' + why;
  if (n.nudge1Due && Date.now() > n.nudge1Due + HOUR) return 'skipped:late';

  const tpl = emails.nudge1Email({ first: firstNameOf(n.lead.name), link: `${cfg.siteUrl()}/?r=${code}` });
  const sent = await sendNudgeOnce(code, 'nudge1', () => sendMail({ to: n.lead.email, tpl }));
  const sentAt = Date.now();
  const due = nudge2DueFrom(sentAt, n);
  // Saved the moment it went (tried twice), so nothing after this can send it twice
  try {
    await saveSent(code, {
      nudge1: { sentAt, gmailId: sent.id, threadId: sent.threadId, messageId: sent.messageId, subject: tpl.subject },
      nudge2Due: due
    });
  } catch (e) {
    // It went, but nudge 2 can't be queued without the saved thread: say so plainly (no retry, the claim stays)
    throw Object.assign(new Error('Nudge 1 went, but saving that it went failed: ' + e.message), { final: 'sent-not-saved' });
  }
  await logToOdoo('nudge1:' + code, n.lead.email, tpl);
  await queueNudge2(code, due);
  return 'sent';
}

function nudge2DueFrom(sentAt, n) {
  const waits = cfg.nudgeTestWaits();
  return waits ? sentAt + waits.second : t.nextDayTenAm(new Date(sentAt), n.lead.timezone).getTime();
}

async function queueNudge2(code, due) {
  await scheduler.schedule('task', { name: 'nudge2', key: code }, due);
  await store.update(nudgeKey(code), { nudge2Queued: true }).catch(() => {});
}

async function handleNudge2(code) {
  const n = await store.get(nudgeKey(code));
  if (n && n.nudge2 && n.nudge2.sentAt) return 'sent'; // already went: a retry never sends it again
  const why = await stopReasonOrUnsure(n, 'nudge2Sending');
  if (why) return 'stopped:' + why;
  if (!n.nudge1 || !n.nudge1.sentAt) return 'stopped:first-not-sent';
  if (n.nudge2Due && Date.now() > n.nudge2Due + HOUR) return 'skipped:late';

  const ids = await gmail.threadMessageIds(n.nudge1.threadId);
  if (ids.some(id => id !== n.nudge1.gmailId)) return 'stopped:replied';

  const tpl = emails.nudge2Email({ first: firstNameOf(n.lead.name), link: `${cfg.siteUrl()}/?r=${code}` });
  const sent = await sendNudgeOnce(code, 'nudge2', () => sendMail({ to: n.lead.email, tpl, inReplyTo: n.nudge1.messageId, threadId: n.nudge1.threadId }));
  // It went; if saving that fails, the claim still stops any second send
  await saveSent(code, { nudge2: { sentAt: Date.now(), gmailId: sent.id } }).catch(e => console.error('⚠️ [Nudge 2 sent, not saved]:', logsafe.safe(e.message)));
  await logToOdoo('nudge2:' + code, n.lead.email, tpl);
  return 'sent';
}

const HANDLERS = { first: handleFirst, second: handleSecond, moved: handleMoved, nudge1: handleNudge1, nudge2: handleNudge2 };

// ---------- Alerts ----------
// The moved email: one alert per moved booking, ever (every kind shares one key), and always the right one
async function movedAlert(rec, who, key, kind) {
  const onceKey = `moved:${key}`;
  // No kind given (the 10-minute check, the last retry): the record says what really happened
  if (!kind && rec) {
    if (rec.moved && rec.moved.sentAt) return false; // it went: nothing to report
    if (rec.movedSending) kind = 'unsure'; // Gmail was asked to send it: never say "not sent"
  }
  if (kind === 'unsure') {
    return alerts.send('Moved-call email may not have gone',
      `Moved-call email may not have gone: ${who} (the new time). Gmail was asked to send it, but we couldn't confirm it went, so it was not sent again. Check Sent in Gmail; if it isn't there, send it by hand.`,
      onceKey);
  }
  if (kind === 'call-passed') {
    return alerts.send('Moved-call email not sent',
      `Moved-call email not sent: ${who} (the new time). The call came before the email's planned time, so it was not sent. Check in with them if needed.`,
      onceKey);
  }
  return alerts.send('Moved-call email not sent', `Moved-call email not sent: ${who} (the new time). Send it by hand.`, onceKey);
}

// kind: undefined or 'not-sent' (the normal "not sent"), 'unsure' (may have gone), 'sent-not-saved' (nudge 1 went,
// nudge 2 not queued)
async function alertFor(name, key, kind) {
  if (name === 'first' || name === 'second' || name === 'moved') {
    const rec = await store.get(bookingKey(key));
    const who = rec ? `${rec.name}, ${t.describe(new Date(rec.startISO), rec.tz).dayShort} at ${t.describe(new Date(rec.startISO), rec.tz).time}` : key;
    if (name === 'moved') return movedAlert(rec, who, key, kind);
    const text = name === 'first'
      ? `Booking email not sent: ${who}. Send both emails by hand: the first now, the second about 5 hours later, as a reply.`
      : `Second email not sent: ${who}. Send it by hand, as a reply under the first.`;
    return alerts.send(name === 'first' ? 'Booking email not sent' : 'Second email not sent', text, `${name}:${key}`);
  }
  const n = await store.get(nudgeKey(key));
  // One alert per nudge, ever: every kind shares one key, so whichever goes first is the only one.
  // (Alerts sent before this change used their own keys: those still count.)
  const onceKey = `${name}:${key}`;
  for (const old of [':unsure', ':not-saved']) {
    if (await store.get('alerted:' + onceKey + old).catch(() => null)) return false;
  }
  // No kind given (the 10-minute check, the last retry, a late nudge): the record says what really happened
  if (!kind && n) {
    const went = n[name] && n[name].sentAt;
    if (went) {
      if (name === 'nudge2' || n.nudge2Queued || (n.nudge2 && n.nudge2.sentAt)) return false; // it went: nothing to report
      kind = 'not-queued';
    } else if (n[name + 'Sending']) {
      kind = 'unsure'; // Gmail was asked to send it: never say "not sent"
    }
  }
  const who = n ? `${n.lead.name}, ${n.lead.company}` : key;
  const noNudge2 = name === 'nudge1' ? ' Nudge 2 was not queued either: if they haven’t booked or replied by tomorrow, WhatsApp them.' : '';
  if (kind === 'unsure') {
    return alerts.send('Nudge email may not have gone',
      `Nudge email may not have gone: ${who}. Gmail was asked to send it, but we couldn't confirm it went, so it was not sent again. Check Sent in Gmail; if it isn't there, WhatsApp them instead.${noNudge2}`,
      onceKey);
  }
  if (kind === 'sent-not-saved') {
    return alerts.send('Nudge 2 not queued',
      `Nudge 2 not queued: ${who}. Nudge 1 went, but saving that it went failed, so nudge 2 could not be queued. If they haven’t booked or replied by tomorrow, WhatsApp them.`,
      onceKey);
  }
  if (kind === 'not-queued') {
    return alerts.send('Nudge 2 not queued',
      `Nudge 2 not queued: ${who}. Nudge 1 went, but nudge 2 could not be queued. If they haven’t booked or replied by tomorrow, WhatsApp them.`,
      onceKey);
  }
  return alerts.send('Nudge email not sent', `Nudge email not sent: ${who}. WhatsApp them two times instead.`, onceKey);
}

// ---------- The runner ----------
async function runTask(name, key, attempt) {
  const stateKey = `task:${name}:${key}`;
  attempt = attempt || 1;

  if (attempt === 1) {
    const claimed = await store.set(stateKey, { status: 'claimed', claimedAt: Date.now() }, { nx: true, ttl: STATE_TTL });
    if (!claimed) return 'duplicate';
    await scheduler.schedule('check', { name, key }, Date.now() + 10 * 60 * 1000).catch(e => console.error('⚠️ [10-minute check not scheduled]:', logsafe.safe(e.message)));
  } else {
    const st = await store.get(stateKey);
    if (!st || st.status !== 'claimed') return 'not-claimed';
  }

  try {
    const result = await HANDLERS[name](key, attempt);
    await store.update(stateKey, { status: result === 'sent' ? 'sent' : 'stopped', result, doneAt: Date.now() });
    // A nudge that could not go within an hour of its time is a failure (a stopped one is not)
    if (result === 'skipped:late' && name.startsWith('nudge')) await alertFor(name, key);
    if (result === 'stopped:unsure' && (name.startsWith('nudge') || name === 'moved')) await alertFor(name, key, 'unsure');
    // The moved email waited and the call came first: say so instead of nothing
    if (result === 'stopped:call-passed' && name === 'moved') await alertFor(name, key, 'call-passed');
    console.log(`📧 [Email ${name}]: ${logsafe.maskCode(key)} -> ${result}`); // the code opens the person's link: masked
    return result;
  } catch (err) {
    console.error(`❌ [Email ${name} attempt ${attempt}]: ${logsafe.safe(err.message)}`);
    // We know exactly what happened and a retry can't help (or would mislabel it): alert now, no retry
    if (err.final) {
      await store.update(stateKey, { status: 'failed', error: err.message, doneAt: Date.now() }).catch(() => {});
      await alertFor(name, key, err.final);
      return 'failed';
    }
    if (attempt < 3) {
      await scheduler.schedule('retry', { name, key, attempt: attempt + 1 }, Date.now() + (attempt === 1 ? 40 : 80) * 1000).catch(e => console.error('⚠️ [Retry not scheduled]:', logsafe.safe(e.message)));
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

module.exports = { scheduleMoved, runTask, runCheck, runJob, firstNameOf, bookingKey, nudgeKey, HANDLERS, _setScheduleRetryMs: (ms) => { scheduleRetryMs = ms; saveRetryMs = ms; } };
