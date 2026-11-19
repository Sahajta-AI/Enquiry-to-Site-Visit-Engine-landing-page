// Keeps names, emails and phone numbers out of the logs. Error messages from Odoo, Gmail and Cal.com can echo
// what we sent them (an email address, a quoted value), so every error line goes through safe() first.
function safe(v) {
  return String(v == null ? '' : v)
    .replace(/[^\s<>()"',;:]+@[^\s<>()"',;:]+\.[a-z]{2,}/gi, '[email]')
    .replace(/\+?\d[\d\s-]{7,}\d/g, '[number]')
    .replace(/(["'“‘])[^"'”’\n]{1,200}(["'”’])/g, '$1…$2')
    .slice(0, 300);
}

// An alert's subject without the person: "Meet link missing: Asha Rao" -> "Meet link missing"
function subjectOnly(subject) {
  return String(subject || '').split(':')[0].trim();
}

// A code that opens something (a nudge's booking link, a booking's reschedule): only its first 4 characters,
// enough to match log lines, never enough to use
function maskCode(code) {
  const c = String(code || '');
  return c ? c.slice(0, 4) + '…' : '-';
}

module.exports = { safe, subjectOnly, maskCode };
