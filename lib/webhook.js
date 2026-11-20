// Cal.com's booking webhook (Thank-you Page Brief v1, 8.1). Set on the Lead Conversion Clarity Call event only,
// "Booking Created" and "Booking Rescheduled" triggers. A moved call gets one "moved" email (see acceptMoved);
// cancelled bookings send nothing from here.
const crypto = require('crypto');
const cfg = require('./config');
const store = require('./store');
const tasks = require('./tasks');
const t = require('./time');

// x-cal-signature-256: the HMAC-SHA256 of the raw body, in hex, made with the webhook's secret
function verifySignature(rawBody, header, secret) {
  if (!secret || !header) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody || '').digest('hex');
  const given = String(header).replace(/^sha256=/, '').trim();
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function meetLinkFrom(p) {
  const candidates = [
    p.videoCallData && p.videoCallData.url,
    p.metadata && p.metadata.videoCallUrl,
    p.location
  ];
  return candidates.find(v => typeof v === 'string' && /^https:\/\//.test(v)) || '';
}

// Checks and records the booking (quick, before the reply). Returns what to do after the reply:
// { reply, uid } where uid is set when the booking email should go.
async function accept(body) {
  const event = body && body.triggerEvent;
  if (event === 'BOOKING_RESCHEDULED') return acceptMoved(body.payload || {});
  if (event !== 'BOOKING_CREATED') return { status: 200, result: 'ignored:' + event };

  const p = body.payload || {};
  const attendee = (p.attendees || [])[0] || {};
  if (!p.uid || !attendee.email || !p.startTime) return { status: 200, result: 'ignored:incomplete' };

  // The webhook is on the Lead Conversion Clarity Call event only; a booking for another event sends nothing
  if (p.eventTypeId && Number(p.eventTypeId) !== cfg.eventTypeId()) return { status: 200, result: 'ignored:other-event' };

  // "Set only if new": a second webhook for the same booking must not wipe what the first one recorded
  await store.set('booking:' + p.uid, {
    uid: p.uid,
    name: attendee.name || '',
    email: attendee.email,
    tz: attendee.timeZone || 'Asia/Kolkata',
    startISO: new Date(p.startTime).toISOString(),
    meetLink: meetLinkFrom(p),
    createdAt: Date.now()
  }, { ttl: 90 * 86400, nx: true });

  return { status: 200, result: 'accepted', uid: p.uid };
}

// A moved call: the new booking is recorded and gets one "moved" email.
// - our second email hadn't gone yet: the moved email replaces it, at the second email's planned time;
// - it already went (or there is none): the moved email goes right away, held to 8 am if that's night for the lead;
// - moved again before a waiting moved email went: the new one takes its place and time.
// The old booking is marked moved, so its waiting second or moved email stops.
async function acceptMoved(p) {
  const attendee = (p.attendees || [])[0] || {};
  const oldUid = p.rescheduleUid || p.fromReschedule || '';
  if (!p.uid || !attendee.email || !p.startTime) return { status: 200, result: 'ignored:incomplete' };
  if (p.eventTypeId && Number(p.eventTypeId) !== cfg.eventTypeId()) return { status: 200, result: 'ignored:other-event' };

  const now = Date.now();
  const tz = attendee.timeZone || 'Asia/Kolkata';
  const old = oldUid && oldUid !== p.uid ? await store.get('booking:' + oldUid) : null;
  const waiting = (job) => job && !job.sentAt && job.dueAt && job.dueAt > now;
  const dueAt = old && waiting(old.second) && !(old.second && old.second.alerted) ? old.second.dueAt
    : old && waiting(old.moved) ? old.moved.dueAt
    : t.holdToMorning(new Date(now), tz).getTime();

  // "Set only if new": the same webhook twice queues one email
  const fresh = await store.set('booking:' + p.uid, {
    uid: p.uid,
    name: attendee.name || (old && old.name) || '',
    email: attendee.email,
    tz,
    startISO: new Date(p.startTime).toISOString(),
    meetLink: meetLinkFrom(p),
    createdAt: now,
    movedFrom: oldUid || null,
    moved: { dueAt }
  }, { ttl: 90 * 86400, nx: true });
  if (!fresh) return { status: 200, result: 'duplicate' };
  if (old) await store.update('booking:' + oldUid, { movedTo: p.uid }).catch(() => {});
  return { status: 200, result: 'accepted:moved', movedUid: p.uid, dueAt };
}

// The booking email (after the reply). Its own retries and alerts live in tasks.runTask.
async function sendFirst(uid) {
  return tasks.runTask('first', uid, 1);
}

// The moved email (after the reply): sent now when it's due now, otherwise queued for its time
async function queueMoved(uid, dueAt) {
  if (dueAt <= Date.now() + 60 * 1000) return tasks.runTask('moved', uid, 1);
  return tasks.scheduleMoved(uid, dueAt);
}

// Kept for callers that want both steps at once (tests, the test page)
async function handle(body) {
  const out = await accept(body);
  if (!out.uid) return out;
  return { status: 200, result: await sendFirst(out.uid) };
}

module.exports = { verifySignature, accept, sendFirst, queueMoved, handle, meetLinkFrom };
