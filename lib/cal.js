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
  const res = await fetch(`https://api.cal.com/v2/bookings/${encodeURIComponent(uid)}`, { headers: headers() });
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
  const url = `https://api.cal.com/v2/bookings?attendeeEmail=${encodeURIComponent(email)}&eventTypeId=${cfg.eventTypeId()}&take=100`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error('Cal.com bookings lookup failed: ' + res.status);
  const json = await res.json();
  return (Array.isArray(json.data) ? json.data : []).map(b => ({
    createdAt: b.createdAt ? new Date(b.createdAt).getTime() : 0,
    start: b.start || b.startTime ? new Date(b.start || b.startTime).getTime() : 0,
    status: String(b.status || '').toLowerCase()
  }));
}

// True when this email booked since `leftAtMs`, or already has an upcoming booking made before
async function hasBookedOrUpcoming(email, leftAtMs) {
  const list = await bookingsForEmail(String(email).trim().toLowerCase());
  const now = Date.now();
  return list.some(b => b.createdAt >= leftAtMs || (b.start > now && b.status !== 'cancelled' && b.status !== 'rejected'));
}

module.exports = { configured, getBooking, bookingsForEmail, hasBookedOrUpcoming };
