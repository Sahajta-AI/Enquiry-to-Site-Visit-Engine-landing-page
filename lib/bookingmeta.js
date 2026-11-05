// The hidden metadata saved on each Cal.com booking (Backend and Tracking Brief, 6.2). The lead never sees it:
// never in the notes. The Odoo Brief reads these keys later, for the signals after the call.
const cfg = require('./config');
const meta = require('./meta');
const leads = require('./leads');

// Cal.com's limits: up to 50 keys, keys up to 40 characters, values up to 500 characters
function limit(md) {
  const out = {};
  Object.keys(md).slice(0, 50).forEach(k => { if (k.length <= 40) out[k] = String(md[k]).slice(0, 500); });
  return out;
}

function buildBookingMetadata({ body, req, nudgeRec, test, qualified, leadEventId, scheduleId }) {
  // Always saved, even while NEW_TRACKING is off: qualified (the reports read it), test (tests only), nudge (from a nudge's link)
  const md = { qualified: qualified ? 'yes' : 'no' };
  if (test) md.test = 'yes';
  if (nudgeRec) md.nudge = 'yes';

  // While NEW_TRACKING is off, save none of the rest
  if (!cfg.newTracking()) return limit(md);

  const saved = (nudgeRec && nudgeRec.lead) || {};
  const own = leads.cleanAttrib(body.sv_attrib);
  // From a nudge's link, a key this visit doesn't have comes from the visit they first left
  const attrib = Object.keys(own).length ? own : leads.cleanAttrib(saved.sv_attrib);
  const fbp = body.fbp || leads.cookieFrom(req, '_fbp') || saved.fbp || '';
  const fbc = meta.buildFbc(body.fbc || leads.cookieFrom(req, '_fbc') || saved.fbc || '', attrib);

  const put = (k, v) => { if (v !== undefined && v !== null && String(v).trim() !== '') md[k] = String(v); };
  ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'angle', 'fbclid'].forEach(k => put(k, attrib[k]));
  put('fbc', fbc);
  put('fbp', fbp);
  put('landing_url', attrib.landing_url);
  put('referrer', attrib.referrer);
  put('first_seen', attrib.first_seen);
  put('lead_event_id', leadEventId);
  put('schedule_event_id', scheduleId);
  put('client_ip', meta.clientIp(req));
  put('client_user_agent', req.headers['user-agent']);
  put('consent_at', body.consent_at || saved.consent_at);
  return limit(md);
}

module.exports = { buildBookingMetadata, limit };
