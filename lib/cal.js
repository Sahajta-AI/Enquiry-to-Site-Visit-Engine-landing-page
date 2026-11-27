// Cal.com API checks the emails need: is the booking still booked, and did this person book since they left.
const cfg = require('./config');

const VERSION = '2024-08-13';

function headers() {
  return {
    Authorization: `Bearer ${process.env.CAL_API_KEY || ''}`,
    'cal-api-version': VERSION,
    'User-Agent': 'Sahajta-AI-Server/1.0 (Node.js)'
  };
}

function configured() {
  return !!process.env.CAL_API_KEY;
}

async function getBooking(uid) {
  const res = await fetch(`https://api.cal.com/v2/bookings/${encodeURIComponent(uid)}`, { headers: headers(), signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('Cal.com booking lookup failed: ' + res.status);
  const json = await res.json();
  const d = json.data || {};
  const loc = typeof d.location === 'string' && /^https:\/\//.test(d.location) ? d.location : '';
  return {
    status: String(d.status || '').toLowerCase(),
    start: d.start || d.startTime || null,
    meetLink: d.meetingUrl || loc || ''
  };
}

// Every booking on this event for this email (no status filter, so a booking cancelled since counts too)
async function bookingsForEmail(email) {
  if (!String(email || '').trim()) return []; // never a blank search (it would return everyone's bookings)
  const url = `https://api.cal.com/v2/bookings?attendeeEmail=${encodeURIComponent(email)}&eventTypeId=${cfg.eventTypeId()}&take=100`;
  const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('Cal.com bookings lookup failed: ' + res.status);
  const json = await res.json();
  return (Array.isArray(json.data) ? json.data : []).map(b => ({
    uid: b.uid || '',
    createdAt: b.createdAt ? new Date(b.createdAt).getTime() : 0,
    start: b.start || b.startTime ? new Date(b.start || b.startTime).getTime() : 0,
    status: String(b.status || '').toLowerCase()
  }));
}

// A booking that already exists for this email at this exact time (a retry after a timeout must not book twice)
async function findBookingAt(email, startMs) {
  const list = await bookingsForEmail(String(email).trim().toLowerCase());
  return list.find(b => b.start === startMs && b.status !== 'cancelled' && b.status !== 'rejected') || null;
}

// True when this email booked since `leftAtMs`, or already has an upcoming booking made before
async function hasBookedOrUpcoming(email, leftAtMs) {
  const list = await bookingsForEmail(String(email).trim().toLowerCase());
  const now = Date.now();
  return list.some(b => b.createdAt >= leftAtMs || (b.start > now && b.status !== 'cancelled' && b.status !== 'rejected'));
}

// The booking as the signal job needs it: the hidden metadata, the attendee and the notes (the WhatsApp line)
function shapeFull(b) {
  const att = (Array.isArray(b.attendees) && b.attendees[0]) || {};
  const fields = b.bookingFieldsResponses || b.responses || {};
  const notes = typeof fields.notes === 'string' ? fields.notes : (fields.notes && fields.notes.value) || b.description || '';
  return {
    uid: b.uid || '', status: String(b.status || '').toLowerCase(),
    metadata: b.metadata && typeof b.metadata === 'object' ? b.metadata : {},
    email: att.email || fields.email || '', name: att.name || fields.name || '', notes: String(notes || '')
  };
}

async function getBookingFull(uid) {
  const res = await fetch(`https://api.cal.com/v2/bookings/${encodeURIComponent(uid)}`, { headers: headers(), signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('Cal.com booking lookup failed: ' + res.status);
  return shapeFull((await res.json()).data || {});
}

// Newest first (sortCreated desc), any status
// Never searched with a blank email (Cal.com would return everyone's bookings), and only bookings whose
// attendee email is exactly this one are kept, so another person's details can never be used
async function bookingsFullForEmail(email) {
  const want = String(email || '').trim().toLowerCase();
  if (!want) return [];
  const url = `https://api.cal.com/v2/bookings?attendeeEmail=${encodeURIComponent(want)}&eventTypeId=${cfg.eventTypeId()}&sortCreated=desc&take=100`;
  const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('Cal.com bookings lookup failed: ' + res.status);
  const json = await res.json();
  return (Array.isArray(json.data) ? json.data : []).map(shapeFull).filter(b => String(b.email || '').trim().toLowerCase() === want);
}

// The event's settings we read from Cal.com (never hard-coded): the booking page's path (for example
// "shubhang-sethi/enquiry-to-site-visit-engine", used by the reschedule pop-up) and the minimum booking notice in
// minutes (Notion "Open Sundays… notice safe to change", part 2: Shubhang may set 16 h, 5 h, 3 h…). One lookup at a
// time, kept 5 minutes; an old value is used at once and refreshed in the background.
const EVENT_TTL = 5 * 60 * 1000;
let eventCache = { at: 0, path: '', noticeMin: null };
let eventFetch = null;
function fetchEventInfo() {
  if (eventFetch) return eventFetch;
  eventFetch = (async () => {
    try {
      const res = await fetch(`https://api.cal.com/v2/event-types/${cfg.eventTypeId()}`, {
        headers: Object.assign(headers(), { 'cal-api-version': '2024-06-14' }), signal: AbortSignal.timeout(3000)
      });
      if (!res.ok) return eventCache;
      const d = (await res.json()).data || {};
      const m = String(d.bookingUrl || '').match(/^https:\/\/cal\.com\/([\w.-]+\/[\w.-]+)$/);
      const n = Number(d.minimumBookingNotice);
      eventCache = { at: Date.now(), path: m ? m[1] : eventCache.path, noticeMin: Number.isFinite(n) && n >= 0 ? n : eventCache.noticeMin };
    } catch (e) { /* keep what we had */ }
    return eventCache;
  })().finally(() => { eventFetch = null; });
  return eventFetch;
}

// The saved value at once (refreshed in the background when old); with none saved, Cal.com waited for at most maxWaitMs
async function eventInfo(pick, maxWaitMs) {
  const have = pick(eventCache);
  if (have !== '' && have != null) {
    if (Date.now() - eventCache.at >= EVENT_TTL) fetchEventInfo().catch(() => {});
    return have;
  }
  if (!configured()) return have;
  let timer;
  const late = new Promise(r => { timer = setTimeout(() => r(eventCache), maxWaitMs); });
  try { return pick(await Promise.race([fetchEventInfo(), late])); } finally { clearTimeout(timer); }
}

// The booking page, for the thank-you reschedule pop-up. /api/config must never be slow (27 Nov: it held up the
// page), so: CAL_BOOKING_PAGE if set, else the saved one, else Cal.com for at most maxWaitMs ('' after that).
async function bookingPagePath(opts) {
  const set = String(process.env.CAL_BOOKING_PAGE || '').trim().replace(/^https:\/\/cal\.com\//, '').replace(/^\/+|\/+$/g, '');
  if (set) return set;
  return (await eventInfo(c => c.path, (opts && opts.maxWaitMs) || 3000)) || '';
}

// Cal.com's minimum booking notice in minutes, or null when it isn't known (callers then rely on Cal.com alone)
async function noticeMinutes(opts) {
  const v = await eventInfo(c => c.noticeMin, (opts && opts.maxWaitMs) || 3000);
  return Number.isFinite(v) ? v : null;
}

// The reschedule picker (our own UI): what we need to know about the booking being moved
async function bookingForMove(uid) {
  const res = await fetch(`https://api.cal.com/v2/bookings/${encodeURIComponent(uid)}`, { headers: headers(), signal: AbortSignal.timeout(8000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Cal.com booking lookup failed: ' + res.status);
  const d = (await res.json()).data || {};
  return {
    uid: d.uid || uid,
    status: String(d.status || '').toLowerCase(),
    start: d.start || d.startTime || null,
    eventTypeId: Number(d.eventTypeId || (d.eventType && d.eventType.id) || 0)
  };
}

// Moves the booking (Cal.com's reschedule: the old booking is cancelled, a new one is made, the guest is emailed).
// Returns { ok, uid, start } or { ok: false, status }.
async function rescheduleBooking(uid, startIso) {
  const res = await fetch(`https://api.cal.com/v2/bookings/${encodeURIComponent(uid)}/reschedule`, {
    method: 'POST',
    headers: Object.assign(headers(), { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ start: startIso, reschedulingReason: 'Moved from the website' }),
    signal: AbortSignal.timeout(10000)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, status: res.status };
  const d = json.data || {};
  return { ok: true, uid: d.uid || '', start: d.start || d.startTime || startIso };
}

// Is this exact moment still an open time on the event? (true / false; throws when Cal.com can't say)
async function isSlotOpen(startMs) {
  const from = new Date(startMs - 60000).toISOString();
  const to = new Date(startMs + 60000).toISOString();
  const res = await fetch(`https://api.cal.com/v2/slots/available?startTime=${from}&endTime=${to}&eventTypeId=${cfg.eventTypeId()}`, {
    headers: headers(), signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error('Cal.com slots lookup failed: ' + res.status);
  const slots = (((await res.json()) || {}).data || {}).slots || {};
  return Object.keys(slots).some(k => (slots[k] || []).some(s => new Date(s.time || s.startTime).getTime() === startMs));
}

// After a move where Cal.com gave no new uid: the attendee's live booking at the new time ('' when none is found)
async function findMovedUid(oldUid, startMs) {
  const old = await getBookingFull(oldUid);
  if (!old.email) return '';
  const list = await bookingsForEmail(String(old.email).trim().toLowerCase());
  const hit = list.find(b => b.uid && b.uid !== oldUid && b.start === startMs && b.status !== 'cancelled' && b.status !== 'rejected');
  return hit ? hit.uid : '';
}

// Cancels a booking (Cal.com emails the guest). Used only for test bookings (lib/testbookings.js).
async function cancelBooking(uid, reason) {
  const res = await fetch(`https://api.cal.com/v2/bookings/${encodeURIComponent(uid)}/cancel`, {
    method: 'POST',
    headers: Object.assign(headers(), { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ cancellationReason: reason }),
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error('Cal.com cancel failed: ' + res.status);
  return true;
}

// ---------- One upcoming call per person (Notion "Safety net: one upcoming call per person", 27 Nov) ----------
// A phone number in any shape ("+91 98765 43210", "09876543210", "9876543210") -> its digits, an Indian number as
// its 10 digits, so the same number always compares equal
function normPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  while (d.length > 10 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  return d.length >= 8 ? d : '';
}

// The WhatsApp number our booking notes carry ("WhatsApp: +91 98765 43210"); bookings made on Cal.com's own page have none
function phoneFromNotes(notes) {
  const m = String(notes || '').match(/WhatsApp:\s*([+\d][\d\s()-]{6,})/i);
  return m ? normPhone(m[1]) : '';
}

const live = (b, now) => b.start > now && b.status !== 'cancelled' && b.status !== 'rejected';

// Every upcoming booking on this event (one page is plenty: bookings open about 8 days ahead)
async function upcomingBookings() {
  const url = `https://api.cal.com/v2/bookings?eventTypeId=${cfg.eventTypeId()}&status=upcoming&take=250`;
  const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error('Cal.com upcoming bookings lookup failed: ' + res.status);
  const json = await res.json();
  return (Array.isArray(json.data) ? json.data : []).map(b => Object.assign(shapeFull(b), {
    start: b.start || b.startTime ? new Date(b.start || b.startTime).getTime() : 0
  }));
}

// This person's next upcoming, not cancelled call: the same email, or the same WhatsApp number in the notes.
// { uid, start, by: 'email' | 'phone' } or null. Throws when Cal.com can't be checked (the caller books as normal).
async function upcomingForPerson(email, phone) {
  const now = Date.now();
  const want = String(email || '').trim().toLowerCase();
  const wantPhone = normPhone(phone);
  const [byEmail, all] = await Promise.all([
    want ? bookingsForEmail(want) : Promise.resolve([]),
    wantPhone ? upcomingBookings() : Promise.resolve([])
  ]);
  const e = byEmail.filter(b => live(b, now)).sort((a, b) => a.start - b.start)[0];
  if (e) return { uid: e.uid, start: e.start, by: 'email' };
  const p = all.filter(b => live(b, now) && wantPhone && phoneFromNotes(b.notes) === wantPhone).sort((a, b) => a.start - b.start)[0];
  if (p) return { uid: p.uid, start: p.start, by: String(p.email).trim().toLowerCase() === want ? 'email' : 'phone' };
  return null;
}

module.exports = { noticeMinutes, _resetEventCache: () => { eventCache = { at: 0, path: '', noticeMin: null }; }, upcomingForPerson, normPhone, phoneFromNotes, cancelBooking, isSlotOpen, findMovedUid, bookingForMove, rescheduleBooking, bookingPagePath, getBookingFull, bookingsFullForEmail, configured, getBooking, bookingsForEmail, findBookingAt, hasBookedOrUpcoming };
