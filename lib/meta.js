// Meta's Conversions API, the one helper every server send goes through (Backend and Tracking Brief, 5.3 and 5.5).
// Live Pixel on production, Sandbox Pixel for tests and previews. Nothing real reaches the live Pixel while NEW_TRACKING is off.
const crypto = require('crypto');
const cfg = require('./config');
const alerts = require('./alerts');

const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

// ---- hashing, exactly as the brief says ----
const hashEmail = (email) => sha256(String(email).trim().toLowerCase());

// 91 and the 10 digits for India; otherwise the digits of the + number, with no 0 right after the country code
function phoneDigits(raw) {
  const v = String(raw || '').trim();
  const digits = v.replace(/\D/g, '');
  if (!digits) return '';
  if (!v.startsWith('+') && digits.length === 10) return '91' + digits;
  if (!v.startsWith('+') && digits.length === 12 && digits.startsWith('91')) return digits;
  if (v.startsWith('+')) {
    const cc = countryCodeLength(digits);
    if (digits[cc] === '0') return digits.slice(0, cc) + digits.slice(cc + 1).replace(/^0+/, ''); // +971 050… → 97150…
  }
  return digits;
}

// Length of the country code at the start of a + number: 1 and 7 are one digit, the ITU's two-digit codes are two, the rest are three
const TWO_DIGIT_CODES = new Set(['20', '27', '30', '31', '32', '33', '34', '36', '39', '40', '41', '43', '44', '45', '46', '47', '48', '49',
  '51', '52', '53', '54', '55', '56', '57', '58', '60', '61', '62', '63', '64', '65', '66', '81', '82', '84', '86', '90', '91', '92', '93', '94', '95', '98']);
function countryCodeLength(digits) {
  if (digits[0] === '1' || digits[0] === '7') return 1;
  return TWO_DIGIT_CODES.has(digits.slice(0, 2)) ? 2 : 3;
}

function hashPhone(raw) {
  const d = phoneDigits(raw);
  return d ? sha256(d) : undefined;
}

function isIndianNumber(raw) {
  const d = phoneDigits(raw);
  return d.length === 12 && d.startsWith('91');
}

// First name, and last name if there is one: trimmed, lowercased, no punctuation
function nameParts(fullName) {
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  return { fn: norm(parts[0]), ln: parts.length > 1 ? norm(parts.slice(1).join(' ')) : '' };
}

// _fbc cookie; if there isn't one but the visit came with fbclid: fb.1.{first_seen ms}.{fbclid} (fbclid exactly as received)
function buildFbc(fbc, attrib) {
  if (fbc) return fbc;
  if (attrib && attrib.fbclid) {
    const t = Date.parse(attrib.first_seen);
    return `fb.1.${Number.isFinite(t) ? t : Date.now()}.${attrib.fbclid}`;
  }
  return undefined;
}

function clientIp(req) {
  try {
    const { ipAddress } = require('@vercel/functions');
    const ip = ipAddress(req);
    if (ip) return ip;
  } catch (e) {}
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || (req.socket && req.socket.remoteAddress) || undefined;
}

// ---- the event ----
function buildEvent({ eventName, eventId, req, person, sourceUrl, customName, fbp, fbc }) {
  const { fn, ln } = nameParts(person.name);
  const user = {
    em: [hashEmail(person.email)],
    external_id: [hashEmail(person.email)],
    client_ip_address: clientIp(req),
    client_user_agent: req.headers['user-agent'] || undefined,
    fbp: fbp || undefined,
    fbc: fbc || undefined
  };
  const ph = hashPhone(person.phone);
  if (ph) user.ph = [ph];
  if (fn) user.fn = [sha256(fn)];
  if (ln) user.ln = [sha256(ln)];
  if (isIndianNumber(person.phone)) user.country = [sha256('in')];
  Object.keys(user).forEach(k => user[k] === undefined && delete user[k]);

  const ev = {
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000), // the server's clock, never the browser's
    event_id: eventId,
    action_source: 'website',
    user_data: user
  };
  if (sourceUrl) ev.event_source_url = sourceUrl;
  if (customName) ev.custom_data = { content_name: customName }; // no value, no currency, never the answers
  return ev;
}

// target: 'live' | 'sandbox'. options.liveCheck: the TrackingCheck on production sends with the live test code.
async function send(args, options) {
  const opts = options || {};
  const target = args.target || (args.test ? 'sandbox' : 'live');

  // Production, NEW_TRACKING off: no real visitor's event goes to Meta. Tests (Sandbox) and the test page still send.
  if (target === 'live' && !opts.liveCheck && !cfg.newTracking()) return { ok: true, skipped: 'new-tracking-off' };

  const t = cfg.metaTarget(target);
  if (!t.pixelId || !t.token) {
    console.log(`ℹ️ [Meta]: ${args.eventName} not sent (${target} Pixel ID or token not set)`);
    return { ok: false, skipped: 'not-configured' };
  }

  const body = { data: [args.rawEvent || buildEvent(args)], access_token: t.token }; // the token goes in the body, never in the address
  // test_event_code: top level, next to data. Sandbox sends, and the live check, only.
  if (target === 'sandbox' || opts.liveCheck) { if (t.testCode) body.test_event_code = t.testCode; }

  const started = Date.now();
  let result;
  try {
    const res = await fetch(`https://graph.facebook.com/${cfg.graphVersion()}/${t.pixelId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000)
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok) {
      result = { ok: true, eventsReceived: json.events_received, fbtraceId: json.fbtrace_id, messages: json.messages || [] };
    } else {
      const e = json.error || {};
      result = { ok: false, status: res.status, code: e.code, error: e.message || 'Meta refused the event', fbtraceId: e.fbtrace_id };
    }
  } catch (err) {
    result = { ok: false, error: err.name === 'TimeoutError' ? 'Meta did not answer in 8 seconds' : err.message };
  }

  // One plain log line: the event, the target, the result, Meta's fbtrace_id, the timing. Never a name, email or number.
  console.log(`📡 [Meta ${args.eventName}] target=${target} ok=${result.ok} received=${result.eventsReceived ?? '-'} fbtrace=${result.fbtraceId || '-'} ms=${Date.now() - started}`);

  if (!result.ok && !opts.noAlert) {
    alerts.rateLimited('meta:' + args.eventName, 30 * 60, `Meta refused an event: ${args.eventName}`,
      `Meta refused the ${args.eventName} event (${target} Pixel).\n\nMeta's message: ${result.error}\nfbtrace_id: ${result.fbtraceId || 'none'}`).catch(() => {});
  }
  return result;
}

module.exports = { send, buildEvent, hashEmail, hashPhone, phoneDigits, nameParts, buildFbc, clientIp, sha256 };
