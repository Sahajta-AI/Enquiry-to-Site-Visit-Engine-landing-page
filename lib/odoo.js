// The Odoo client (Odoo Brief v1, part 4): Odoo 19's JSON-2 API, named arguments only, 8-second timeout, one retry.
//   POST {ODOO_URL}/json/2/{model}/{method}   Authorization: Bearer {ODOO_API_KEY}   X-Odoo-Database: {ODOO_DB}
// Only the Odoo Brief's code writes to Odoo. It never deletes, never makes a contact, never sets partner_id,
// never adds tags and never marks a lead won or lost.
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

function _reset() { cache.clear(); }

module.exports = {
  configured, call, searchRead, create, write, note, esc, OdooError, plainText,
  stageId, teamId, userId, sourceId, meetingTypeId, firstId,
  _reset, _setRetryWaitMs: (ms) => { retryWaitMs = ms; }, _setTimeoutMs: (ms) => { timeoutMs = ms; }
};
