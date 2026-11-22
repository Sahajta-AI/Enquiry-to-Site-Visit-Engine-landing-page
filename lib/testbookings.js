// Test bookings (Notion "Test bookings", ODOO_V2 only): a booking made with a TEST_EMAILS address is cancelled
// automatically 1 hour after it was made, so test calls never sit in Shubhang's calendar. Its Odoo note says
// "Cancelled by: you" and no rebook reminder is made ("Odoo 11").
// Safety: only an address on the TEST_EMAILS list, checked again on Cal.com's own record right before cancelling.
// A real person's booking is never cancelled.
const cfg = require('./config');
const store = require('./store');
const cal = require('./cal');
const scheduler = require('./scheduler');
const logsafe = require('./logsafe');

const HOUR = 3600 * 1000;
const norm = (e) => String(e || '').trim().toLowerCase();
const isTestEmail = (email) => !!norm(email) && cfg.testEmails().includes(norm(email));

// From the booking webhook (created or moved): queue the cancel for 1 hour later. Never fails the webhook.
async function queueCancel(uid, email) {
  if (!cfg.odooV2() || !uid || !isTestEmail(email)) return 'skipped';
  try {
    await scheduler.schedule('test-cancel', { key: uid }, Date.now() + HOUR);
    return 'queued';
  } catch (err) {
    console.error('⚠️ [Test booking cancel not queued]:', logsafe.safe(err.message));
    return 'failed';
  }
}

async function runCancel(uid) {
  if (!cfg.odooV2()) return 'off';
  if (!cal.configured()) return 'skipped:cal-not-configured';
  if (!(await store.set('testcancel-run:' + uid, 1, { nx: true, ttl: 7 * 86400 }))) return 'duplicate';
  let b;
  try { b = await cal.getBookingFull(uid); } catch (err) { await store.del('testcancel-run:' + uid).catch(() => {}); throw err; }
  if (!isTestEmail(b.email)) return 'skipped:not-a-test-booking';
  if (b.status !== 'accepted') return 'skipped:' + (b.status || 'not-booked');
  // Marked first, so the cancel webhook knows it was us ("Cancelled by: you", no rebook reminder)
  await store.set('testcancel:' + uid, 1, { ttl: 7 * 86400 });
  try {
    await cal.cancelBooking(uid, 'Test booking, cancelled automatically after 1 hour');
  } catch (err) {
    await store.del('testcancel-run:' + uid).catch(() => {}); // the queue tries again
    throw err;
  }
  return 'cancelled';
}

const wasAutoCancelled = async (uid) => !!(uid && await store.get('testcancel:' + uid).catch(() => null));

module.exports = { queueCancel, runCancel, wasAutoCancelled, isTestEmail };
