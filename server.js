const express = require('express');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const lcfg = require('./lib/config');
const ltime = require('./lib/time');
const lstore = require('./lib/store');
const lleads = require('./lib/leads');
const lwebhook = require('./lib/webhook');
const lscheduler = require('./lib/scheduler');
const ltasks = require('./lib/tasks');
const lafter = require('./lib/after');
const lalerts = require('./lib/alerts');
const lmeta = require('./lib/meta');
const lqualify = require('./lib/qualify');
const lcal = require('./lib/cal');
const lbookingmeta = require('./lib/bookingmeta');
const ltrackingtest = require('./lib/trackingtest');
const lodooleads = require('./lib/odooleads');
const lodoosignals = require('./lib/odoosignals');

// Load environment variables from .env if present
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envLines = fs.readFileSync(envPath, 'utf8').split('\n');
  envLines.forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const parts = trimmed.split('=');
      const key = parts[0].trim();
      const val = parts.slice(1).join('=').trim();
      if (key && val) {
        process.env[key] = val;
      }
    }
  });
}

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
// Keep the raw body: the Cal.com webhook's signature and the queue's signature are made over it
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); } }));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  if (/^\/tracking-test(\.html)?$/.test(req.path)) res.setHeader('X-Robots-Tag', 'noindex');
  next();
});
// One plain log line per /api request: the endpoint, the status, the result or error code, the timing.
// Never a name, email, number or query string. (Meta's fbtrace_id is on the Meta helper's own line.)
app.use('/api', (req, res, next) => {
  const started = Date.now();
  let code = '';
  const json = res.json.bind(res);
  res.json = (body) => {
    if (body && typeof body === 'object') code = body.code || body.result || body.status || (body.ok === true || body.success === true ? 'ok' : '');
    return json(body);
  };
  res.on('finish', () => {
    console.log(`🧾 [API] ${req.method} ${req.baseUrl}${req.path} status=${res.statusCode} result=${String(code || '-').slice(0, 40)} ms=${Date.now() - started}`);
  });
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// Clean Single-Page Routes (Legacy routes redirect to /)
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/privacy-policy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy-policy.html'));
});

app.get('/terms-and-conditions', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terms-and-conditions.html'));
});

app.get('/cookie-policy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'cookie-policy.html'));
});

app.get('/disclaimer', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'disclaimer.html'));
});

app.get('/support', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'support.html'));
});

app.get('/data-deletion', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'data-deletion.html'));
});

app.get('/fit-and-book', (req, res) => {
  res.redirect('/');
});

// The private test page: no link to it anywhere, noindex, not listed in robots.txt. Its endpoint checks a password every time.
app.get('/tracking-test', (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'tracking-test.html'));
});

app.post('/api/tracking-test', async (req, res) => {
  if (!lleads.originAllowed(req)) return res.status(403).json({ ok: false, code: 'origin' });
  try {
    const out = await ltrackingtest.handle(req);
    res.status(out.status).json(out.body);
  } catch (err) {
    console.error('⚠️ [/api/tracking-test]:', err.message);
    res.status(500).json({ ok: false });
  }
});

// The page that opens right after a successful booking (also the pre-call page when opened directly)
app.get('/thank-you', (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'thank-you.html'));
});

// Function to dynamically reload latest .env config per request
function getLatestConfig() {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const envLines = fs.readFileSync(envPath, 'utf8').split('\n');
    envLines.forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const parts = trimmed.split('=');
        const key = parts[0].trim();
        const val = parts.slice(1).join('=').trim();
        if (key && val) {
          process.env[key] = val;
        }
      }
    });
  }
  let waNum = (process.env.WHATSAPP_NUMBER || '919731173205').replace(/[^\d]/g, '');
  if (waNum.length === 10) {
    waNum = '91' + waNum;
  }

  return {
    DESTINATION_EMAIL: process.env.DESTINATION_EMAIL || 'shubhang@sahajta.com',
    FROM_EMAIL: process.env.FROM_EMAIL || 'shubhang@sahajta.com',
    WHATSAPP_NUMBER: waNum,
    BRIEFING_VIDEO_URL: (process.env.BRIEFING_VIDEO_URL || '').trim(),
    BRIEFING_VIDEO_POSTER: (process.env.BRIEFING_VIDEO_POSTER || '').trim(),
    BRIEFING_VIDEO_CAPTIONS: (process.env.BRIEFING_VIDEO_CAPTIONS || '').trim(),
    DEMO_WHATSAPP_NUMBER: (process.env.DEMO_WHATSAPP_NUMBER || '').replace(/[^\d]/g, ''),
    RESEND_API_KEY: process.env.RESEND_API_KEY || '',
    SMTP_HOST: process.env.SMTP_HOST || 'smtp.gmail.com',
    SMTP_PORT: process.env.SMTP_PORT || 465,
    SMTP_USER: process.env.SMTP_USER || '',
    SMTP_PASS: process.env.SMTP_PASS || '',
    CAL_API_KEY: process.env.CAL_API_KEY || ''
  };
}

// Config endpoint for client runtime variables.
// The Pixel ID is the live one on production and the Sandbox one on previews (never a fallback to the live one).
// No Cal.com booking link: bookings come only through our form.
app.get('/api/config', (req, res) => {
  const config = getLatestConfig();
  res.json({
    metaPixelId: lcfg.pixelId(),
    pixelKind: lcfg.isProduction() ? 'live' : 'sandbox',
    clarityId: lcfg.clarityId(),
    newTracking: lcfg.newTracking(),
    whatsappNumber: config.WHATSAPP_NUMBER,
    briefingVideoUrl: config.BRIEFING_VIDEO_URL,
    briefingVideoPoster: config.BRIEFING_VIDEO_POSTER,
    briefingVideoCaptions: config.BRIEFING_VIDEO_CAPTIONS,
    demoWhatsappNumber: config.DEMO_WHATSAPP_NUMBER
  });
});

// ---------------------------------------------------------------------------
// Automatic emails (Thank-you Page Brief v1, parts 7 and 8)
// ---------------------------------------------------------------------------

// The checked details of this visit, kept for 24 hours (Backend and Tracking Brief, 5.3): the "Didn't book" email and the
// nudges start only from this record. Replies at once, then sends Lead to Meta from the server.
app.post('/api/lead', async (req, res) => {
  if (!lleads.originAllowed(req)) return res.status(403).json({ ok: false, code: 'origin' });
  let out;
  try {
    out = await lleads.saveLead(req.body || {}, req);
  } catch (err) {
    console.error('⚠️ [/api/lead]:', err.message);
    out = { status: 503, body: { ok: false, code: 'store' } };
  }
  res.status(out.status).json(out.body);
  if (out.leadEvent) lafter.after(() => lmeta.send(out.leadEvent));
  if (out.odooLead) {
    lafter.after(() => lodooleads.onLead(out.odooLead));
    lafter.after(() => lodoosignals.checkHealth());
  }
});

// The page was left at the time step without booking ("didnt_book"), or no times showed ("no_times")
app.post('/api/lead-signal', async (req, res) => {
  if (!lleads.originAllowed(req)) return res.status(403).json({ ok: false });
  const b = req.body || {};
  try {
    const result = await lleads.handleSignal({ kind: b.kind, leadEventId: b.lead_event_id, resumeCode: b.resume_code });
    return res.status(200).json({ ok: true, result });
  } catch (err) {
    console.error('⚠️ [/api/lead-signal]:', err.message);
    return res.status(200).json({ ok: false });
  }
});

// Opens a nudge's link: only the first name goes back, never the email, number or answers
app.post('/api/resume', async (req, res) => {
  if (!lleads.originAllowed(req)) return res.status(403).json({ ok: false });
  try {
    const n = await lleads.lookupResume(req.body && req.body.code);
    if (!n) return res.status(200).json({ ok: false });
    return res.status(200).json({ ok: true, firstName: ltasks.firstNameOf(n.lead.name) });
  } catch (err) {
    return res.status(200).json({ ok: false });
  }
});

// Cal.com's "Booking Created" webhook (set on the Lead Conversion Clarity Call event only)
app.post('/api/cal-webhook', async (req, res) => {
  const secret = process.env.CAL_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ ok: false, error: 'CAL_WEBHOOK_SECRET is not set' });
  if (!lwebhook.verifySignature(req.rawBody || '', req.headers['x-cal-signature-256'], secret)) {
    return res.status(401).json({ ok: false });
  }
  try {
    const out = await lwebhook.handle(req.body);
    res.status(out.status).json({ ok: true, result: out.result });
    // Odoo, after the reply, on all three triggers: an Odoo problem never touches the booking or its email
    lafter.after(() => lodooleads.onWebhook(req.body));
    return;
  } catch (err) {
    console.error('❌ [/api/cal-webhook]:', err.message);
    return res.status(500).json({ ok: false });
  }
});

// The delayed job calls this when something is due (second email, nudges, retries, the 10-minute check)
app.post('/api/jobs/run', async (req, res) => {
  if (!lscheduler.verifyQStash(req.rawBody || '', req.headers['upstash-signature'])) return res.status(401).json({ ok: false });
  try {
    const job = await lstore.get('job:' + (req.body && req.body.jobId));
    const result = await ltasks.runJob(job);
    return res.status(200).json({ ok: true, result });
  } catch (err) {
    console.error('❌ [/api/jobs/run]:', err.message);
    return res.status(500).json({ ok: false }); // the queue tries again
  }
});

// The signal job (Odoo Brief, part 6): Vercel Cron calls this with Authorization: Bearer {CRON_SECRET}
app.get('/api/cron/odoo-signals', async (req, res) => {
  if (!lscheduler.verifyCron(req)) return res.status(401).json({ ok: false });
  try {
    const out = await lodoosignals.run({ tests: false });
    return res.status(200).json({ ok: out.ok, result: out.result });
  } catch (err) {
    console.error('❌ [/api/cron/odoo-signals]:', err.message);
    return res.status(500).json({ ok: false });
  }
});

// Used only if the scheduler is switched to Vercel Cron (SCHEDULER=cron): runs whatever is due
app.get('/api/jobs/tick', async (req, res) => {
  if (!lscheduler.verifyCron(req)) return res.status(401).json({ ok: false });
  const ran = [];
  try {
    const due = await lstore.zdueBefore('jobs', Date.now());
    for (const id of due) {
      await lstore.zrem('jobs', id);
      ran.push(await ltasks.runJob(await lstore.get('job:' + id)));
    }
    return res.status(200).json({ ok: true, ran });
  } catch (err) {
    console.error('❌ [/api/jobs/tick]:', err.message);
    return res.status(500).json({ ok: false });
  }
});

// Dynamic available slots endpoint (Supports date=YYYY-MM-DD or month=YYYY-MM)
app.get('/api/available-slots', async (req, res) => {
  const dateStr = req.query.date;
  const monthStr = req.query.month; // e.g. "2026-08"
  const userTimeZone = req.query.timeZone || 'Asia/Kolkata';

  const config = getLatestConfig();
  const calApiKey = config.CAL_API_KEY || process.env.CAL_API_KEY || '';
  let slotsFailed = !calApiKey; // no key means nobody can book either

  if (calApiKey && monthStr) {
    try {
      const parts = monthStr.split('-');
      const year = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10); // 1-indexed
      const lastDay = new Date(year, month, 0).getDate();
      const startTime = `${monthStr}-01T00:00:00.000Z`;
      const endTime = `${monthStr}-${String(lastDay).padStart(2, '0')}T23:59:59.000Z`;

      const calRes = await fetch(`https://api.cal.com/v2/slots/available?startTime=${startTime}&endTime=${endTime}&eventTypeId=${lcfg.eventTypeId()}&timeZone=${encodeURIComponent(userTimeZone)}`, {
        headers: {
          'Authorization': `Bearer ${calApiKey}`,
          'User-Agent': 'Sahajta-AI-Server/1.0 (Node.js)'
        },
        signal: AbortSignal.timeout(8000)
      });

      if (!calRes.ok) slotsFailed = true;
      if (calRes.ok) {
        const data = await calRes.json();
        const slotsByDate = {};
        const availableDates = [];

        if (data && data.data && data.data.slots) {
          for (const dateKey in data.data.slots) {
            const list = data.data.slots[dateKey];
            if (Array.isArray(list) && list.length > 0) {
              const formattedTimes = [];
              list.forEach(slot => {
                const dt = new Date(slot.time || slot.startTime);
                const timeFormatted = dt.toLocaleTimeString('en-US', {
                  hour: '2-digit',
                  minute: '2-digit',
                  timeZone: userTimeZone
                });
                if (!formattedTimes.includes(timeFormatted)) formattedTimes.push(timeFormatted);
              });
              if (formattedTimes.length > 0) {
                slotsByDate[dateKey] = formattedTimes;
                availableDates.push(dateKey);
              }
            }
          }
        }
        return res.json({ month: monthStr, slotsByDate, availableDates });
      }
    } catch (err) {
      console.warn('Cal API month slots error:', err.message);
      slotsFailed = true;
    }
  }

  if (calApiKey && dateStr) {
    try {
      const startTime = `${dateStr}T00:00:00.000Z`;
      const endTime = `${dateStr}T23:59:59.000Z`;
      const calRes = await fetch(`https://api.cal.com/v2/slots/available?startTime=${startTime}&endTime=${endTime}&eventTypeId=${lcfg.eventTypeId()}&timeZone=${encodeURIComponent(userTimeZone)}`, {
        headers: {
          'Authorization': `Bearer ${calApiKey}`,
          'User-Agent': 'Sahajta-AI-Server/1.0 (Node.js)'
        },
        signal: AbortSignal.timeout(8000)
      });
      if (!calRes.ok) slotsFailed = true;
      if (calRes.ok) {
        const data = await calRes.json();
        const slotsList = [];
        if (data && data.data && data.data.slots) {
          for (const k in data.data.slots) {
            data.data.slots[k].forEach(slot => {
              const dt = new Date(slot.time || slot.startTime);
              const timeFormatted = dt.toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
                timeZone: userTimeZone
              });
              if (!slotsList.includes(timeFormatted)) slotsList.push(timeFormatted);
            });
          }
        }
        return res.json({ date: dateStr, slots: slotsList });
      }
    } catch (err) {
      console.warn('Cal API slot fetch error:', err.message);
      slotsFailed = true;
    }
  }

  res.json({ date: dateStr, slots: [], slotsByDate: {}, availableDates: [] });
  if (slotsFailed) {
    // Open times failing to load means nobody can book: also by the backup alert path, at most one every 30 minutes
    lafter.after(() => lalerts.rateLimited('slots-fail', 30 * 60, 'Open times are not loading',
      'The open times failed to load from Cal.com, so nobody can book right now. Please check the Cal.com key and the event.', { backup: true }));
  }
});

// Turns a wall-clock date and time in a named time zone into the real moment (UTC).
// The picker shows times in the visitor's zone, so the booking has to be made in that same zone.
function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
}

function zonedTimeToUtc(dateStr, hours, minutes, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const wallAsUtc = Date.UTC(y, m - 1, d, hours, minutes, 0);
  const offsetAt = (ms) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(new Date(ms)).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    return asUtc - ms;
  };
  let guess = wallAsUtc - offsetAt(wallAsUtc);
  guess = wallAsUtc - offsetAt(guess);
  return new Date(guess);
}

// +91 98765 43210 for an Indian number, an international number as the form sent it
function formatNotesPhone(raw) {
  const v = String(raw || '').trim();
  const digits = v.replace(/\D/g, '');
  if (!v.startsWith('+') && digits.length === 10) return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
  return v;
}

// API Route: Submit Lead Intake & Dispatch Email
// Backend and Tracking Brief: checks (7.1, 7.2), Schedule and QualifiedBooking from the server (5.3, 5.5),
// the source data on the booking (6), the test flag (7.3) and the alerts (7.4). Reply first, then the rest (part 4).
const BOOKING_ERROR = 'The booking could not be made. Please pick a time again.';

app.post('/api/submit-lead', async (req, res) => {
  if (!lleads.originAllowed(req)) return res.status(403).json({ success: false, ok: false, code: 'origin' });
  const config = getLatestConfig();
  const fail = (status, code, msg) => res.status(status).json({ success: false, ok: false, code, error: msg || BOOKING_ERROR });

  // A booking from a nudge's link: the browser sends only resume_code and the time. The details come from the store.
  const resumeCode = typeof req.body.resume_code === 'string' ? req.body.resume_code : '';
  let nudgeRec = null;
  if (resumeCode) {
    const expired = () => fail(400, 'invalid', 'This link has expired. Please start again.');
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(resumeCode)) return expired();
    const n = await lstore.get('nudge:' + resumeCode);
    if (!n) return expired();
    if (n.used) {
      // A retry with the same code for the same time gets that booking back
      const b = n.bookingResult;
      if (b && b.slotDate === req.body.slotDate && b.slotTime === req.body.slotTime) {
        return res.status(200).json({ success: true, ok: true, test: !!b.test, whatsappNumber: config.WHATSAPP_NUMBER, rescheduleUrl: b.rescheduleUrl || null, lead: { name: n.lead.name } });
      }
      return expired();
    }
    if (Date.now() - n.createdAt > lcfg.resumeCodeTtlMs()) return expired();
    nudgeRec = n;
    req.body = Object.assign({}, req.body, {
      name: n.lead.name, company: n.lead.company, email: n.lead.email, whatsapp_number: n.lead.whatsapp_number,
      q1_situation: n.lead.q1_situation, q2_urgency: n.lead.q2_urgency,
      timezone: ltime.isValidTimeZone(req.body.timezone) ? req.body.timezone : n.lead.timezone
    });
  }

  const {
    q1_situation, q2_urgency, name, company, email, whatsapp_number, bookedSlot, timezone, slotDate, slotTime
  } = req.body;
  const pickedTime = `${slotDate || '?'} ${slotTime || '?'}`;
  const detailsText = `Name: ${name}\nCompany: ${company}\nEmail: ${email}\nWhatsApp: ${whatsapp_number}\nTime they picked: ${pickedTime}`;

  // 7.1 The server checks every input again (a nudge's saved details were checked when /api/lead kept them)
  if (!nudgeRec && !lleads.validateDetails(req.body).ok) return fail(400, 'invalid', 'Please check your details and try again.');

  // 7.2 Bots: a filled trap, or a form sent in under 3 seconds. The normal booking error, and an alert in case it was a real person.
  if (!nudgeRec && (req.body.hp_note || !(Number(req.body.form_ms) >= 3000))) {
    lafter.after(() => lalerts.rateLimited('bot-refused', 30 * 60, 'A booking was refused as a bot',
      `A booking was refused by the spam checks (trap field or form sent too fast), in case it was a real person.\n\n${detailsText}`, { backup: false }));
    return fail(502, 'booking');
  }

  // 7.1 The time: in the future, and no more than 8 days ahead (Cal.com applies its own notice and window)
  const bookingZone = ltime.isValidTimeZone(timezone) ? timezone : 'Asia/Kolkata';
  const timeMatch = String(slotTime || '').match(/(\d+):(\d+)\s*(AM|PM)/i);
  let startDt = null;
  if (timeMatch && /^\d{4}-\d{2}-\d{2}$/.test(String(slotDate || ''))) {
    let hours = parseInt(timeMatch[1], 10);
    const minutes = parseInt(timeMatch[2], 10);
    const ampm = timeMatch[3].toUpperCase();
    if (ampm === 'PM' && hours < 12) hours += 12;
    if (ampm === 'AM' && hours === 12) hours = 0;
    startDt = ltime.zonedTimeToUtc(slotDate, hours, minutes, bookingZone);
  }
  if (!startDt || startDt.getTime() <= Date.now() || startDt.getTime() > Date.now() + 8 * 86400000) {
    return fail(400, 'invalid', 'That time is no longer available. Please pick a time again.');
  }

  const calApiKey = config.CAL_API_KEY || process.env.CAL_API_KEY || '';
  const test = lcfg.isTest(email);
  const qualified = lqualify.isQualified(q1_situation, q2_urgency);
  const scheduleId = /^[0-9a-f-]{36}$/i.test(String(req.body.schedule_event_id || '')) ? req.body.schedule_event_id : crypto.randomUUID();
  const leadEventId = nudgeRec ? nudgeRec.leadEventId : String(req.body.lead_event_id || '');
  const savedLead = (nudgeRec && nudgeRec.lead) || {};
  const attrib = lleads.cleanAttrib(req.body.sv_attrib || savedLead.sv_attrib);
  const fbp = req.body.fbp || lleads.cookieFrom(req, '_fbp') || savedLead.fbp || '';
  const fbc = lmeta.buildFbc(req.body.fbc || lleads.cookieFrom(req, '_fbc') || savedLead.fbc || '', attrib);
  const pageUrl = String(req.body.page_url || '').slice(0, 500);

  let calAccepted = false;
  let rescheduleUrl = null;
  let bookingUid = null;
  let googleMeetUrl = null;
  let timedOut = false;

  // No Cal.com key means nothing can be booked: never let that look like a booking (Backend Brief, part 4)
  if (!calApiKey) {
    console.error('⚠️ [Cal.com booking error]: CAL_API_KEY is not set');
    lafter.after(() => lalerts.send('A booking could not be made',
      `The Cal.com key is missing on this server, so no booking can be made. Please reach out to this person.\n\n${detailsText}`,
      `refused:${String(email).toLowerCase()}:${pickedTime}`, { backup: false }));
    return fail(503, 'booking');
  }

  {
    // A retry after a timeout, with the same email and the same time, must not book twice: reply with the booking that exists
    let existing = null;
    try { existing = await lcal.findBookingAt(email, startDt.getTime()); } catch (e) { /* carry on: Cal.com decides */ }

    if (existing) {
      calAccepted = true;
      bookingUid = existing.uid;
      rescheduleUrl = bookingUid ? `https://cal.com/reschedule/${encodeURIComponent(bookingUid)}` : null;
    } else {
      try {
        // Booking notes: four labelled lines, so Cal.com's invite shows them clearly. A test starts with "TEST BOOKING".
        const notes = [
          ...(test ? ['TEST BOOKING'] : []),
          `Company or project: ${company}`,
          `WhatsApp: ${formatNotesPhone(whatsapp_number)}`,
          `What’s happening right now: ${q1_situation || 'N/A'}`,
          `When they’d want it running: ${q2_urgency || 'N/A'}`
        ].join('\n');

        const calRes = await fetch('https://api.cal.com/v2/bookings', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${calApiKey}`,
            'Content-Type': 'application/json',
            'User-Agent': 'Sahajta-AI-Server/1.0 (Node.js)'
          },
          signal: AbortSignal.timeout(8000),
          body: JSON.stringify({
            start: startDt.toISOString(),
            eventTypeId: lcfg.eventTypeId(),
            timeZone: bookingZone,
            language: 'en',
            // Hidden: the source data and flags (never in the notes, which the lead sees)
            metadata: lbookingmeta.buildBookingMetadata({ body: req.body, req, nudgeRec, test, qualified, leadEventId, scheduleId }),
            responses: { name, email, notes }
          })
        });

        if (calRes.ok) {
          calAccepted = true;
          const calData = await calRes.json().catch(() => ({}));
          googleMeetUrl = calData.data?.videoCallUrl || calData.data?.location || null;
          bookingUid = calData.data?.uid || null;
          rescheduleUrl = bookingUid ? `https://cal.com/reschedule/${encodeURIComponent(bookingUid)}` : null;
          console.log(`✅ [Cal.com booking]: created, uid ${bookingUid || '-'}`);
        } else {
          console.warn('⚠️ [Cal.com booking refused]: status', calRes.status);
        }
      } catch (calErr) {
        timedOut = calErr.name === 'TimeoutError';
        console.error('⚠️ [Cal.com booking error]:', timedOut ? 'timed out after 8 seconds' : calErr.message);
      }
    }

    // A booking that Cal.com refused or that timed out is a failed booking: tell the page, send nothing, create nothing.
    // One alert per person (per email and time picked), never merged.
    if (!calAccepted) {
      lafter.after(() => lalerts.send('A booking could not be made',
        `Cal.com ${timedOut ? 'did not answer in time' : 'refused'} a booking. Please reach out to this person.\n\n${detailsText}`,
        `refused:${String(email).toLowerCase()}:${pickedTime}`, { backup: false }));
      return fail(502, 'booking');
    }
  }

  // Nobody who booked gets a "Didn't book" email or a nudge; a used code stays used
  try {
    if (nudgeRec) {
      await lstore.update('nudge:' + resumeCode, {
        used: true, booked: true,
        bookingResult: { slotDate, slotTime, rescheduleUrl, test }
      });
    }
    await lleads.markBooked(leadEventId, email);
  } catch (markErr) {
    console.error('⚠️ [Mark booked error]:', markErr.message);
  }

  // Reply first. Everything else (the team email, the CRM, Meta) happens after the reply.
  res.status(200).json({
    success: true, ok: true, test,
    message: 'Lead captured successfully.',
    whatsappNumber: config.WHATSAPP_NUMBER,
    rescheduleUrl,
    lead: { name, company, email, bookedSlot: bookedSlot || 'Pending calendar confirmation' }
  });

  lafter.after(async () => {
    const formattedSlot = bookedSlot || 'Pending calendar confirmation';
    const timestamp = new Date().toISOString();

    // 1. Internal team email summary
    const teamSubject = `[New Real Estate Lead] ${name} - ${company}`;
    const teamTextSummary = `
===================================================
ENQUIRY-TO-SITE-VISIT ENGINE - NEW QUALIFIED LEAD
===================================================
Full Name:            ${name}
Company / Project:    ${company}
Work Email:           ${email}
WhatsApp Number:      ${whatsapp_number}

[INTAKE QUALIFICATION]
Q1 Project Situation: ${q1_situation || 'Not answered'}
Q2 Implementation:    ${q2_urgency || 'Not answered'}

[BOOKING DETAILS]
Booked Slot:          ${formattedSlot}
Timezone:             ${timezone || 'UTC'}
Submitted At:         ${timestamp}

[ATTRIBUTION & UTMS]
UTM Source:           ${attrib.utm_source || 'Direct / None'}
UTM Medium:           ${attrib.utm_medium || 'Direct / None'}
UTM Campaign:         ${attrib.utm_campaign || 'Direct / None'}
===================================================
`;
    console.log('📥 [Lead captured]: booking made' + (test ? ' (test)' : ''));
    const destinationList = config.DESTINATION_EMAIL.split(',').map(e => e.trim()).filter(Boolean);
    const tasks = destinationList.map(dest => dispatchEmail({
      to: dest, from: config.FROM_EMAIL, subject: teamSubject, text: teamTextSummary, config
    }).catch(err => console.error(`⚠️ [Team email error for ${dest}]:`, err.message)));

    // 2. The CRM (Odoo) is handled by the Odoo Brief's code: the lead at /api/lead, the booking through the Cal.com webhook

    // 3. Meta, from the server: Schedule with the browser's shared event ID, then QualifiedBooking (once per booking)
    tasks.push((async () => {
      const common = {
        req, person: { name, email, phone: whatsapp_number }, sourceUrl: pageUrl, fbp, fbc, test
      };
      await lmeta.send(Object.assign({ eventName: 'Schedule', eventId: scheduleId, customName: 'Lead Conversion Clarity Call' }, common));
      if (qualified) {
        const key = 'qb:' + (bookingUid || scheduleId);
        if (!(await lstore.get(key))) {
          const r = await lmeta.send(Object.assign({ eventName: 'QualifiedBooking', eventId: scheduleId + '-q', customName: 'Lead Conversion Clarity Call' }, common));
          if (r.ok && !r.skipped) await lstore.set(key, { at: Date.now() }, { ttl: 90 * 86400 });
        }
      }
    })().catch(err => console.error('⚠️ [Meta send error]:', err.message)));

    await Promise.allSettled(tasks);
  });
});

/**
 * Universal Dual Email Transport Engine (Nodemailer SMTP primary, Resend API secondary)
 */
async function dispatchEmail({ to, from, subject, text, html, config, isRetry = false }) {
  // Method 1: Nodemailer (SMTP / Gmail)
  if (config.SMTP_USER && config.SMTP_PASS) {
    try {
      const transporter = nodemailer.createTransport({
        host: config.SMTP_HOST || 'smtp.gmail.com',
        port: parseInt(config.SMTP_PORT) || 465,
        secure: parseInt(config.SMTP_PORT) === 465,
        connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 8000,
        auth: {
          user: config.SMTP_USER,
          pass: config.SMTP_PASS
        }
      });

      const mailOptions = {
        from: `"Sahajta AI" <${config.SMTP_USER}>`,
        to: to,
        subject: subject,
        text: text,
        html: html
      };

      const info = await transporter.sendMail(mailOptions);
      console.log(`✅ [Nodemailer SMTP Dispatched to ${to}]: Message ID ${info.messageId}`);
      return;
    } catch (error) {
      console.error(`❌ [Nodemailer SMTP Error for ${to}]:`, error.message);
    }
  }

  // Method 2: Resend API
  if (config.RESEND_API_KEY && !config.RESEND_API_KEY.includes('placeholder')) {
    try {
      const payload = {
        from: from || 'onboarding@resend.dev',
        to: [to],
        subject: subject,
        text: text
      };
      if (html) payload.html = html;

      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        signal: AbortSignal.timeout(8000),
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errText = await response.text();
        if (response.status === 403 && errText.includes('testing emails to your own email address') && !isRetry) {
          const primaryDest = config.DESTINATION_EMAIL.split(',')[0].trim();
          console.log(`⚠️ [Resend Test Mode Note]: Rerouting preview email to account inbox (${primaryDest})...`);
          
          return dispatchEmail({
            to: primaryDest,
            from: from,
            subject: `[TEST PREVIEW for ${to}] ${subject}`,
            text: `[Originally sent to: ${to}]\n\n` + text,
            html: html ? `<div style="background:#fef2f2; border:1px solid #fca5a5; padding:12px; font-weight:bold; color:#991b1b; margin-bottom:16px;">⚠️ [Test Mode Preview]: Originally sent to: ${to}</div>` + html : null,
            config: config,
            isRetry: true
          });
        }
        throw new Error(`HTTP ${response.status}: ${errText}`);
      }

      const data = await response.json();
      console.log(`✅ [Resend API Dispatched to ${to}]: Success ID ${data.id}`);
      return;
    } catch (error) {
      console.error(`❌ [Resend API Error for ${to}]:`, error.message);
    }
  }

  console.log(`ℹ️ [Email Logged for ${to}]: Subject: "${subject}".`);
}

// Start Server (local only; on Vercel, api/index.js imports the app instead)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 Sahajta AI Enquiry-to-Site-Visit Engine running at http://localhost:${PORT}`);
    console.log(`  [✓] Landing Page: http://localhost:${PORT}/`);
  });
}

module.exports = app;
