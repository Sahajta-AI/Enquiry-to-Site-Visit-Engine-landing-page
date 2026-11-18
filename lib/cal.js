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

// The booking page's path on cal.com (for example "shubhang-sethi/enquiry-to-site-visit-engine"), used by the
// reschedule pop-up. Looked up from the event type once an hour; CAL_BOOKING_PAGE overrides it.
let pageCache = { at: 0, path: '' };
async function bookingPagePath() {
  const set = String(process.env.CAL_BOOKING_PAGE || '').trim().replace(/^https:\/\/cal\.com\//, '').replace(/^\/+|\/+$/g, '');
  if (set) return set;
  if (pageCache.path && Date.now() - pageCache.at < 3600 * 1000) return pageCache.path;
  if (!configured()) return '';
  try {
    const res = await fetch(`https://api.cal.com/v2/event-types/${cfg.eventTypeId()}`, {
      headers: Object.assign(headers(), { 'cal-api-version': '2024-06-14' }), signal: AbortSignal.timeout(3000)
    });
    if (!res.ok) return pageCache.path;
    const url = String(((await res.json()).data || {}).bookingUrl || '');
    const m = url.match(/^https:\/\/cal\.com\/([\w.-]+\/[\w.-]+)$/);
    if (m) pageCache = { at: Date.now(), path: m[1] };
  } catch (e) { /* the page falls back to the plain reschedule link */ }
  return pageCache.path;
}

module.exports = { bookingPagePath, getBookingFull, bookingsFullForEmail, configured, getBooking, bookingsForEmail, findBookingAt, hasBookedOrUpcoming };
