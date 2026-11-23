// The Odoo client (Odoo Brief v1, part 4): Odoo 19's JSON-2 API, named arguments only, 8-second timeout, one retry.
//   POST {ODOO_URL}/json/2/{model}/{method}   Authorization: Bearer {ODOO_API_KEY}   X-Odoo-Database: {ODOO_DB}
// Only the Odoo Brief's code writes to Odoo. It never marks a lead won or lost, and deletes nothing except as below.
// With ODOO_V2 off: it also never makes a contact, never sets partner_id and never adds tags (as before).
// With ODOO_V2 on (Notion "Odoo 0"), and only on Warm-Chain leads (Service Interested In = "Warm-Chain System";
// hand-made leads without that tag are never touched), it may also:
//   - create Contacts (company and person) and link the lead to the person (partner_id), "Odoo 1";
//   - add the one tag "Warm-Chain System" to Service Interested In, "Odoo 3";
//   - remove (unlink) reminders our own code created, recognised by their exact titles (OUR_REMINDERS), and only
//     through removeOurReminders below, which checks both the title and the tag first;
//   - archive (never delete) "[TEST] " leads and their test Contacts 24 hours after creation.
// Everything else stays blocked: no other deletes, never Won or Lost.
const alerts = require('./alerts');
const logsafe = require('./logsafe');

const clean = (v) => String(v || '').trim();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let retryWaitMs = 3000;
let timeoutMs = 8000;

function configured() {
  return !!(clean(process.env.ODOO_API_KEY) && clean(process.env.ODOO_DB));
}

function baseUrl() {
  return (clean(process.env.ODOO_URL) || 'https://sahajta.odoo.com').replace(/\/+$/, '');
}

class OdooError extends Error {
  constructor(message, status) { super(message); this.name = 'OdooError'; this.status = status; }
}

async function callOnce(model, method, args) {
  const res = await fetch(`${baseUrl()}/json/2/${model}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${clean(process.env.ODOO_API_KEY)}`,
      'X-Odoo-Database': clean(process.env.ODOO_DB),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(args || {}),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
  if (!res.ok) {
    const msg = (json && (json.message || json.name)) || ('HTTP ' + res.status);
    throw new OdooError(`Odoo ${model}/${method}: ${String(msg).slice(0, 200)}`, res.status);
  }
  return json;
}

// After a timeout, a dropped connection or an Odoo server error we can't tell whether Odoo saved the first try
const unsure = (err) => !err.status || err.status >= 500;

// One call, tried once more after a few seconds. A refused key (401 or 403) raises the "key" alert, at most once a day.
// opts.check (for calls that make something: a lead, a note, a reminder): when the first try may have been saved,
// look for it in Odoo before trying again, so a retry never makes a second copy. If the look itself fails, no retry.
async function call(model, method, args, opts) {
  if (!configured()) throw new OdooError('Odoo is not configured', 0);
  try {
    return await callOnce(model, method, args);
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      alerts.rateLimited('odoo-key', 24 * 3600, 'The Odoo API key needs renewing',
        'Odoo refused the website\'s API key. Please make a new key (Odoo profile > My Preferences > Account Security > API Keys) and put it in Vercel as ODOO_API_KEY.', { backup: false }).catch(() => {});
      throw err;
    }
    await sleep(retryWaitMs);
    const check = opts && opts.check;
    if (check && unsure(err)) {
      let found;
      try { found = await check(); } catch (e) { throw err; }
      if (found != null) {
        console.warn(`⚠️ [Odoo] ${model}/${method}: the first try was saved after all (${logsafe.safe(err.message)}); not sent again`);
        return found;
      }
    }
    return callOnce(model, method, args);
  }
}

// Odoo's time format (UTC), a few minutes back to allow for clock differences
function odooTime(msAgo) {
  return new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace('T', ' ');
}
const RECENT = 10 * 60 * 1000;

// The words of a note without its HTML, to compare what we sent with what Odoo kept
function plainText(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

const searchRead = (model, domain, fields, extra) =>
  call(model, 'search_read', Object.assign({ domain, fields, limit: 50 }, extra || {}));
// match: the fields that identify the new record if a retry has to check whether the first try was saved
const create = async (model, vals, match) => {
  const since = odooTime(RECENT);
  const domain = [['create_date', '>=', since]].concat((match || ['name']).filter(f => vals[f] != null).map(f => [f, '=', vals[f]]));
  const check = async () => {
    const rows = await searchRead(model, domain, ['id'], { limit: 1, order: 'id desc' });
    return rows && rows[0] ? [rows[0].id] : null;
  };
  return (await call(model, 'create', { vals_list: [vals] }, { check }))[0];
};
const write = (model, ids, vals) => call(model, 'write', { ids, vals });

// An internal note: nobody gets an email. Every value that came from the form is HTML-escaped by the caller.
const note = (leadId, html) => {
  const since = odooTime(RECENT);
  const check = async () => {
    const rows = await searchRead('mail.message', [['model', '=', 'crm.lead'], ['res_id', '=', leadId], ['date', '>=', since]], ['id', 'body'], { limit: 20 });
    const hit = (rows || []).find(r => plainText(r.body) === plainText(html));
    return hit ? [hit.id] : null;
  };
  return call('crm.lead', 'message_post', {
    ids: [leadId], body: html, body_is_html: true, message_type: 'comment', subtype_xmlid: 'mail.mt_note'
  }, { check });
};

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ---- things found by name, once, and kept (never by number) ----
const cache = new Map();
async function cached(key, finder) {
  if (cache.has(key)) return cache.get(key);
  const v = await finder();
  if (v != null) cache.set(key, v);
  return v;
}
const firstId = async (model, domain) => {
  const rows = await searchRead(model, domain, ['id'], { limit: 1 });
  return rows && rows[0] ? rows[0].id : null;
};

const stageId = (name) => cached('stage:' + name, () => firstId('crm.stage', [['name', '=', name]]));
const teamId = () => cached('team', () => firstId('crm.team', [['name', '=', 'Sales']]));
const userId = () => cached('user', () => firstId('res.users', [['name', '=', 'Shubhang Sethi']]));
const sourceId = (name) => cached('source:' + name, () => firstId('utm.source', [['name', '=', name]]));
const meetingTypeId = () => cached('acttype:Meeting', () => firstId('mail.activity.type', [['name', '=', 'Meeting']]));

const SERVICE_FIELD = 'x_studio_service_interested_in_1'; // "Service Interested In" (many2many to crm.tag)
const WARM_CHAIN = 'Warm-Chain System';
// The tag already exists (made 21 Nov): found by name, never made here, never by number
const warmChainTagId = () => cached('tag:' + WARM_CHAIN, () => firstId('crm.tag', [['name', '=', WARM_CHAIN]]));
const recurringPlanId = (name) => cached('plan:' + name, () => firstId('crm.recurring.plan', [['name', '=', name]]));
const todoTypeId = () => cached('acttype:To-Do', () => firstId('mail.activity.type', [['name', '=', 'To-Do']]));

// A lead not on WhatsApp has the same reminders starting "SMS/Call: " instead of "WhatsApp: " (Shubhang, 23 Nov):
// they count as ours, the same as the WhatsApp ones. Only that exact swap; any other title stays untouched.
const WA = 'WhatsApp: ';
const SMS = 'SMS/Call: ';
const smsTwin = (title) => (String(title).startsWith(WA) ? SMS + String(title).slice(WA.length) : null);
const withTwins = (titles) => [...new Set((titles || []).flatMap(x => (smsTwin(x) ? [x, smsTwin(x)] : [x])))];
const baseTitle = (title) => (String(title).startsWith(SMS) ? WA + String(title).slice(SMS.length) : title);

// The reminders our own code makes ("Odoo 0"): the only ones it may ever remove (with their "SMS/Call: " twins)
const OUR_REMINDERS_BASE = [
  'WhatsApp: follow up (didn\'t book)',
  'WhatsApp: personal message (evening before the call)',
  'WhatsApp: call-day reminder',
  'After the call: update the stage',
  'WhatsApp: get the call rebooked',
  'Reply to their email',
  'Next step: plan what\'s next for this lead',
  'Check why they filled the form again',
  'Came back: read the history first',
  'Past client is back: check what they need',
  'WhatsApp: share open times (the booking form didn\'t load)',
  'Update Expected Revenue and MRR to the proposal amount',
  // old titles still open on live leads
  'Personal message the evening before the call',
  'WhatsApp follow-up',
  'Get the call booked'
];
const OUR_REMINDERS = withTwins(OUR_REMINDERS_BASE);

const tagIdsOf = (row) => (Array.isArray(row && row[SERVICE_FIELD]) ? row[SERVICE_FIELD] : []);

// Is this lead a Warm-Chain lead? Read from Odoo itself, never assumed.
async function isWarmChain(leadId) {
  const tag = await warmChainTagId();
  if (!tag) return false;
  const rows = await searchRead('crm.lead', [['id', '=', leadId]], ['id', SERVICE_FIELD], { context: { active_test: false }, limit: 1 });
  return !!(rows && rows[0] && tagIdsOf(rows[0]).includes(tag));
}

// Removes this lead's open reminders with these titles. Refuses (throws) a title that isn't ours, and does nothing on a
// lead without the Warm-Chain tag. Returns how many were removed.
async function removeOurReminders(leadId, titles) {
  const bad = (titles || []).filter(x => !OUR_REMINDERS.includes(x));
  if (bad.length) throw new OdooError('Not one of our reminders, never removed: ' + bad.join(', '), 0);
  if (!titles || !titles.length) return 0;
  if (!(await isWarmChain(leadId))) return 0;
  const acts = await searchRead('mail.activity', [['res_model', '=', 'crm.lead'], ['res_id', '=', leadId], ['summary', 'in', withTwins(titles)]], ['id', 'summary']);
  const ids = (acts || []).filter(a => OUR_REMINDERS.includes(a.summary)).map(a => a.id);
  if (!ids.length) return 0;
  // Gone already means the first try worked
  await call('mail.activity', 'unlink', { ids }, {
    check: async () => ((await searchRead('mail.activity', [['id', 'in', ids]], ['id'])) || []).length ? null : true
  });
  return ids.length;
}

function _reset() { cache.clear(); }

module.exports = {
  configured, call, searchRead, create, write, note, esc, OdooError, plainText,
  stageId, teamId, userId, sourceId, meetingTypeId, firstId, cached,
  SERVICE_FIELD, WARM_CHAIN, warmChainTagId, recurringPlanId, todoTypeId, OUR_REMINDERS, smsTwin, withTwins, baseTitle, tagIdsOf, isWarmChain, removeOurReminders,
  _reset, _setRetryWaitMs: (ms) => { retryWaitMs = ms; }, _setTimeoutMs: (ms) => { timeoutMs = ms; }
};
