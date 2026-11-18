// "Reply to the visitor first. Send to Meta, and any alert, after the reply" (Backend and Tracking Brief, part 4).
// On Vercel, waitUntil keeps the function alive until the work is done. Elsewhere the work simply keeps running.
let waitUntil = null;
try { waitUntil = require('@vercel/functions').waitUntil; } catch (e) { /* not on Vercel */ }

const pending = new Set();

function after(work) {
  const safe = Promise.resolve().then(() => (typeof work === 'function' ? work() : work))
    .catch(err => console.error('❌ [after reply]:', err && err.message));
  pending.add(safe);
  safe.finally(() => pending.delete(safe));
  try { if (waitUntil) waitUntil(safe); } catch (e) { /* no request context: it still runs */ }
  return safe;
}

// Tests: wait until all the work after replies is done
async function _idle() {
  while (pending.size) await Promise.all([...pending]);
}

module.exports = { after, _idle };
