// "Reply to the visitor first. Send to Meta, and any alert, after the reply" (Backend and Tracking Brief, part 4).
// On Vercel, waitUntil keeps the function alive until the work is done. Elsewhere the work simply keeps running.
let waitUntil = null;
try { waitUntil = require('@vercel/functions').waitUntil; } catch (e) { /* not on Vercel */ }

function after(work) {
  const safe = Promise.resolve(typeof work === 'function' ? work() : work)
    .catch(err => console.error('❌ [after reply]:', err && err.message));
  try { if (waitUntil) waitUntil(safe); } catch (e) { /* no request context: it still runs */ }
  return safe;
}

module.exports = { after };
