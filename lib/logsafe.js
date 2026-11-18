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

module.exports = { safe, subjectOnly };
