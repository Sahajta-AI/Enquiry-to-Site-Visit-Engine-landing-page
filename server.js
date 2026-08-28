const express = require('express');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const https = require('https');

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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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

app.get('/thank-you', (req, res) => {
  res.redirect('/');
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
  let waNum = (process.env.WHATSAPP_NUMBER || '').replace(/[^\d]/g, '');
  if (waNum.length === 10) {
    waNum = '91' + waNum;
  }

  return {
    DESTINATION_EMAIL: process.env.DESTINATION_EMAIL || 'poojarisaiyash@gmail.com',
    FROM_EMAIL: process.env.FROM_EMAIL || 'shubhang@sahajta.com',
    WHATSAPP_NUMBER: waNum,
    RESEND_API_KEY: process.env.RESEND_API_KEY || '',
    SMTP_HOST: process.env.SMTP_HOST || 'smtp.gmail.com',
    SMTP_PORT: process.env.SMTP_PORT || 465,
    SMTP_USER: process.env.SMTP_USER || '',
    SMTP_PASS: process.env.SMTP_PASS || '',
    ODOO_URL: process.env.ODOO_URL || 'https://sahajta.odoo.com',
    ODOO_DB: process.env.ODOO_DB || 'sahajta',
    ODOO_USER: process.env.ODOO_USER || 'shubhangsethi@gmail.com',
    ODOO_API_KEY: process.env.ODOO_API_KEY || '',
    CALENDAR_EMBED_URL: process.env.CALENDAR_EMBED_URL || 'https://cal.com/shubhang-sethi/enquiry-to-site-visit-engine',
    CAL_API_KEY: process.env.CAL_API_KEY || '',
    META_PIXEL_ID: process.env.META_PIXEL_ID || '909588332098654',
    META_CAPI_TOKEN: process.env.META_CAPI_TOKEN || ''
  };
}

// SHA-256 Hashing Helpers for Meta CAPI Event Match Quality (EMQ > 8.5)
function hashSha256(value) {
  if (!value) return undefined;
  return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
}

function normalizePhone(phone) {
  if (!phone) return undefined;
  const digits = String(phone).replace(/\D/g, '');
  return digits.length >= 7 ? digits : undefined;
}

// Helper: Native HTTPS POST Request for Meta Graph API
function postJsonHttps(urlStr, bodyObj) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(urlStr);
    const postData = JSON.stringify(bodyObj);

    const options = {
      hostname: parsedUrl.hostname,
      port: 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Sahajta-AI-Server/1.0 (Node.js/CAPI)',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 10000
    };

    const req = https.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(responseBody);
          resolve({ status: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, data: responseBody });
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('HTTPS Request Timed Out'));
    });

    req.write(postData);
    req.end();
  });
}

// Direct Backend Meta Conversions API (CAPI) Engine
async function sendMetaCapiEvent(eventName, req, userData = {}, customData = {}, eventId = null) {
  const config = getLatestConfig();
  const pixelId = config.META_PIXEL_ID;
  const apiToken = process.env.META_CAPI_TOKEN || config.META_CAPI_TOKEN || '';

  if (!pixelId || !apiToken) {
    console.log(`ℹ️ [Meta CAPI Notice]: Skipping CAPI "${eventName}" (META_PIXEL_ID or META_CAPI_TOKEN not configured)`);
    return false;
  }

  try {
    // Extract Client IP and User Agent for high Meta Event Match Quality
    const rawIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';
    const clientIp = rawIp.split(',')[0].trim();
    const clientUserAgent = req.headers['user-agent'] || '';

    // Extract Meta Cookies (_fbp, _fbc) from request
    const cookies = req.headers.cookie || '';
    const fbpMatch = cookies.match(/_fbp=([^;]+)/);
    const fbcMatch = cookies.match(/_fbc=([^;]+)/);
    const fbp = fbpMatch ? fbpMatch[1] : undefined;
    const fbc = fbcMatch ? fbcMatch[1] : undefined;

    // Parse First & Last Name
    let firstName = userData.name || '';
    let lastName = '';
    if (userData.name && userData.name.trim().includes(' ')) {
      const parts = userData.name.trim().split(/\s+/);
      firstName = parts[0];
      lastName = parts.slice(1).join(' ');
    }

    const payload = {
      data: [
        {
          event_name: eventName,
          event_time: Math.floor(Date.now() / 1000),
          event_id: eventId || `capi_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
          event_source_url: req.headers.referer || 'https://sahajta-landing-page-brown.vercel.app/',
          action_source: 'website',
          user_data: {
            em: userData.email ? [hashSha256(userData.email)] : undefined,
            ph: (userData.whatsapp_number || userData.phone) ? [hashSha256(normalizePhone(userData.whatsapp_number || userData.phone))] : undefined,
            fn: firstName ? [hashSha256(firstName)] : undefined,
            ln: lastName ? [hashSha256(lastName)] : undefined,
            client_ip_address: clientIp || undefined,
            client_user_agent: clientUserAgent || undefined,
            fbp: fbp || undefined,
            fbc: fbc || undefined
          },
          custom_data: customData
        }
      ]
    };

    if (process.env.META_TEST_EVENT_CODE) {
      payload.test_event_code = process.env.META_TEST_EVENT_CODE;
    }

    const graphUrl = `https://graph.facebook.com/v20.0/${pixelId}/events?access_token=${apiToken}`;
    
    let capiRes;
    try {
      capiRes = await postJsonHttps(graphUrl, payload);
    } catch (httpsErr) {
      console.warn(`⚠️ [Meta CAPI HTTPS Notice]: postJsonHttps error (${httpsErr.message}), trying fetch fallback...`);
      try {
        const fetchRes = await fetch(graphUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Sahajta-AI-Server/1.0 (Node.js/CAPI)'
          },
          body: JSON.stringify(payload)
        });
        const data = await fetchRes.json();
        capiRes = { status: fetchRes.status, data: data };
      } catch (fetchErr) {
        console.error(`❌ [Meta CAPI Error]: Failed to send "${eventName}". HTTPS err: ${httpsErr.message} | Fetch err: ${fetchErr.message}`);
        return false;
      }
    }

    if (capiRes.status >= 200 && capiRes.status < 300) {
      console.log(`✅ [Meta CAPI Success]: Event "${eventName}" dispatched to Meta Graph API. Received: ${capiRes.data?.events_received || 1}`);
      return true;
    } else {
      console.warn(`⚠️ [Meta CAPI Warning]: Meta Graph API returned status ${capiRes.status}:`, capiRes.data?.error || capiRes.data);
      return false;
    }
  } catch (err) {
    console.error(`❌ [Meta CAPI Error]: Failed to send "${eventName}":`, err.message);
    return false;
  }
}

// Config endpoint for client runtime variables
app.get('/api/config', (req, res) => {
  const config = getLatestConfig();
  res.json({
    calendarEmbedUrl: config.CALENDAR_EMBED_URL,
    metaPixelId: config.META_PIXEL_ID,
    whatsappNumber: config.WHATSAPP_NUMBER
  });
});

// Client CAPI Event Tracking Route
app.post('/api/track-capi', async (req, res) => {
  const { eventName, userData, customData, eventId } = req.body;
  if (!eventName) return res.status(400).json({ success: false, error: 'Missing eventName' });

  const success = await sendMetaCapiEvent(eventName, req, userData || {}, customData || {}, eventId || null);
  res.json({ success });
});

// Dynamic available slots endpoint (Supports date=YYYY-MM-DD or month=YYYY-MM)
app.get('/api/available-slots', async (req, res) => {
  const dateStr = req.query.date;
  const monthStr = req.query.month; // e.g. "2026-08"
  const userTimeZone = req.query.timeZone || 'Asia/Kolkata';

  const config = getLatestConfig();
  const calApiKey = config.CAL_API_KEY || process.env.CAL_API_KEY || '';

  if (calApiKey && monthStr) {
    try {
      const parts = monthStr.split('-');
      const year = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10); // 1-indexed
      const lastDay = new Date(year, month, 0).getDate();
      const startTime = `${monthStr}-01T00:00:00.000Z`;
      const endTime = `${monthStr}-${String(lastDay).padStart(2, '0')}T23:59:59.000Z`;

      const calRes = await fetch(`https://api.cal.com/v2/slots/available?startTime=${startTime}&endTime=${endTime}&eventTypeId=6659881&timeZone=${encodeURIComponent(userTimeZone)}`, {
        headers: {
          'Authorization': `Bearer ${calApiKey}`,
          'User-Agent': 'Sahajta-AI-Server/1.0 (Node.js)'
        }
      });

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
    }
  }

  if (calApiKey && dateStr) {
    try {
      const startTime = `${dateStr}T00:00:00.000Z`;
      const endTime = `${dateStr}T23:59:59.000Z`;
      const calRes = await fetch(`https://api.cal.com/v2/slots/available?startTime=${startTime}&endTime=${endTime}&eventTypeId=6659881&timeZone=${encodeURIComponent(userTimeZone)}`, {
        headers: {
          'Authorization': `Bearer ${calApiKey}`,
          'User-Agent': 'Sahajta-AI-Server/1.0 (Node.js)'
        }
      });
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
    }
  }

  return res.json({ date: dateStr, slots: [], slotsByDate: {}, availableDates: [] });
});

// API Route: Submit Lead Intake & Dispatch Email
app.post('/api/submit-lead', async (req, res) => {
  const config = getLatestConfig();
  const {
    q1_situation,
    q2_urgency,
    name,
    company,
    email,
    whatsapp_number,
    bookedSlot,
    timezone,
    utm_source,
    utm_medium,
    utm_campaign
  } = req.body;

  // Input Validation
  if (!name || !email || !company || !whatsapp_number) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields (name, email, company, whatsapp_number)'
    });
  }

  const timestamp = new Date().toISOString();
  const formattedSlot = bookedSlot || 'Pending calendar confirmation';

  // 1. Internal Team Email Summary
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
UTM Source:           ${utm_source || 'Direct / None'}
UTM Medium:           ${utm_medium || 'Direct / None'}
UTM Campaign:         ${utm_campaign || 'Direct / None'}
===================================================
`;

  console.log('\n📥 REAL ESTATE LEAD CAPTURED:\n' + teamTextSummary);

  // Dispatch Internal Notification to Team Inbox(es)
  const destinationList = config.DESTINATION_EMAIL.split(',').map(e => e.trim()).filter(Boolean);
  destinationList.forEach(dest => {
    dispatchEmail({
      to: dest,
      from: config.FROM_EMAIL,
      subject: teamSubject,
      text: teamTextSummary,
      config: config
    }).catch(err => {
      console.error(`⚠️ [Team Email Error for ${dest}]:`, err.message);
    });
  });

  // Dispatch Prospect Confirmation & Strategy Call Email
  dispatchProspectConfirmationEmail({
    to: email,
    name: name,
    company: company,
    bookedSlot: formattedSlot,
    whatsappNumber: config.WHATSAPP_NUMBER,
    from: config.FROM_EMAIL,
    config: config
  }).catch(err => {
    console.error('⚠️ [Prospect Email Error]:', err.message);
  });

  // Safe Odoo CRM Lead Creation
  if (config.ODOO_API_KEY) {
    dispatchToOdooCRM(req.body, config).catch(err => {
      console.error('⚠️ [Odoo CRM Dispatch Error]:', err.message);
    });
  } else {
    console.log('ℹ️ [Odoo CRM]: No ODOO_API_KEY set in .env. Skipping Odoo sync.');
  }

  // Automatic Cal.com & Google Calendar Event Creation
  const calApiKey = config.CAL_API_KEY || process.env.CAL_API_KEY || '';
  let googleMeetUrl = null;

  if (calApiKey && req.body.slotDate && req.body.slotTime) {
    try {
      const datePart = req.body.slotDate;
      const timeStr = req.body.slotTime;
      const match = timeStr.match(/(\d+):(\d+)\s*(AM|PM)/i);
      if (match) {
        let hours = parseInt(match[1], 10);
        const minutes = parseInt(match[2], 10);
        const ampm = match[3].toUpperCase();
        if (ampm === 'PM' && hours < 12) hours += 12;
        if (ampm === 'AM' && hours === 12) hours = 0;
        const hh = String(hours).padStart(2, '0');
        const mm = String(minutes).padStart(2, '0');
        
        const isoString = `${datePart}T${hh}:${mm}:00+05:30`;
        const startDt = new Date(isoString);

        const calRes = await fetch('https://api.cal.com/v2/bookings', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${calApiKey}`,
            'Content-Type': 'application/json',
            'User-Agent': 'Sahajta-AI-Server/1.0 (Node.js)'
          },
          body: JSON.stringify({
            start: startDt.toISOString(),
            eventTypeId: 6659881,
            timeZone: 'Asia/Kolkata',
            language: 'en',
            metadata: {},
            responses: {
              name: name,
              email: email,
              notes: `Company: ${company} | Phone: ${whatsapp_number} | Q1: ${q1_situation || 'N/A'} | Q2: ${q2_urgency || 'N/A'}`
            }
          })
        });

        if (calRes.ok) {
          const calData = await calRes.json();
          googleMeetUrl = calData.data?.videoCallUrl || calData.data?.location || null;
          console.log(`✅ [Cal.com Sync Success]: Google Calendar booking created! ID: ${calData.data?.id} | Meet: ${googleMeetUrl}`);
        } else {
          const errBody = await calRes.text();
          console.warn('⚠️ [Cal.com Booking Notice]:', errBody);
        }
      }
    } catch (calErr) {
      console.error('⚠️ [Cal.com Booking Error]:', calErr.message);
    }
  }

  // Direct Backend Meta Conversions API (CAPI) Dispatch (Awaited for Vercel serverless completion guarantee)
  const capiUserData = { name, email, whatsapp_number, company };
  const baseEventId = req.body.event_id || `lead_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  
  try {
    await sendMetaCapiEvent('Lead', req, capiUserData, {
      content_name: 'Real Estate Strategy Call Lead',
      company: company
    }, baseEventId);

    if (bookedSlot && bookedSlot !== 'Pending calendar confirmation') {
      await sendMetaCapiEvent('Schedule', req, capiUserData, {
        content_name: 'Strategy Call Slot Confirmed',
        booked_slot: bookedSlot
      }, `sched_${baseEventId}`);
    }
  } catch (err) {
    console.error('⚠️ [Meta CAPI Dispatch Error]:', err.message);
  }

  return res.status(200).json({
    success: true,
    message: 'Lead captured successfully and confirmation dispatched.',
    whatsappNumber: config.WHATSAPP_NUMBER,
    lead: { name, company, email, bookedSlot: formattedSlot }
  });
});

/**
 * Prospect Strategy Call Confirmation Email Dispatcher
 */
async function dispatchProspectConfirmationEmail({ to, name, company, bookedSlot, whatsappNumber, from, config }) {
  const firstName = name.split(' ')[0] || name;
  const subject = `Strategy Call Confirmed — Enquiry-to-Site-Visit Engine for ${company}`;

  const textBody = `Hi ${firstName},

Your Enquiry-to-Site-Visit Engine strategy call for ${company} is officially confirmed!

🗓 Scheduled Slot: ${bookedSlot}
📍 Location: Video Meeting (Calendar link sent)

Complete these 2 quick steps before our call:

1. CONFIRM ON WHATSAPP:
Send a quick message to our team at +${whatsappNumber} confirming you will attend:
"Hi, I have booked my Enquiry-to-Site-Visit Engine strategy call and confirm that I will attend"

2. PRE-CALL NUMBERS CHECKLIST:
Please have the following numbers ready for your project over the last 30 days:
• Total paid enquiries received
• Average first-response time
• Site visits booked
• Site visits actually attended

We look forward to speaking with you!

Best regards,
Sahajta AI Technical Team
Enquiry-to-Site-Visit Engine
https://sahajta.com
`;

  const htmlBody = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #111827; background-color: #F9FAFB; margin: 0; padding: 20px; }
    .card { max-width: 580px; margin: 0 auto; background: #FFFFFF; border: 1px solid #E5E7EB; border-radius: 12px; padding: 32px; box-shadow: 0 4px 12px rgba(0,0,0,0.03); }
    .logo-header { color: #1B4332; font-size: 24px; font-weight: 700; font-family: Georgia, serif; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid #F3F4F6; }
    .badge { display: inline-block; background: rgba(27, 67, 50, 0.08); color: #1B4332; font-weight: 700; font-size: 13px; padding: 4px 12px; border-radius: 999px; margin-bottom: 16px; }
    .slot-box { background: #FFFBEB; border-left: 4px solid #C8991A; padding: 16px; border-radius: 6px; margin: 20px 0; font-weight: 600; color: #92400E; }
    .step-box { background: #F9FAFB; border: 1px solid #E5E7EB; padding: 16px; border-radius: 8px; margin-bottom: 12px; }
    .footer { font-size: 13px; color: #6B7280; margin-top: 28px; padding-top: 16px; border-top: 1px solid #F3F4F6; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo-header">Sahajta AI</div>
    <span class="badge">✓ Strategy Call Confirmed</span>
    <h2>Hi ${firstName},</h2>
    <p>Your <strong>Enquiry-to-Site-Visit Engine</strong> strategy call for <strong>${company}</strong> is confirmed.</p>
    
    <div class="slot-box">
      📅 <strong>Scheduled Slot:</strong> ${bookedSlot}
    </div>

    <h3>Complete these 2 steps before our call:</h3>

    <div class="step-box">
      <strong>1. Confirm On WhatsApp:</strong><br>
      Please send a text to <strong>+${whatsappNumber}</strong> to confirm your attendance.
    </div>

    <div class="step-box">
      <strong>2. Have Your 30-Day Numbers Ready:</strong>
      <ul>
        <li>Paid enquiries received</li>
        <li>Average first-response time</li>
        <li>Site visits booked &amp; attended</li>
      </ul>
    </div>

    <p>Looking forward to connecting!</p>

    <div class="footer">
      <strong>Sahajta AI Technical Team</strong><br>
      Enquiry-to-Site-Visit Engine &bull; <a href="https://sahajta.com" style="color: #1B4332;">www.sahajta.com</a>
    </div>
  </div>
</body>
</html>
`;

  return dispatchEmail({
    to: to,
    from: from,
    subject: subject,
    text: textBody,
    html: htmlBody,
    config: config
  });
}

/**
 * Safe, Relational Odoo CRM JSON-RPC Lead Dispatcher
 * Workflow:
 * 1. Search 'res.partner' (READ ONLY) for an existing contact with matching email.
 * 2. If no contact is found, create 1 new contact in 'res.partner'.
 *    If contact IS found, use existing partner_id (never overwrite/edit existing contact!).
 * 3. Create 1 new opportunity in 'crm.lead' linked to partner_id.
 * 4. Post formatted Log Note to right-side Chatter feed via 'message_post'.
 */
async function dispatchToOdooCRM(leadData, config) {
  const odooUrl = config.ODOO_URL || 'https://sahajta.odoo.com';
  const odooDb = config.ODOO_DB || 'sahajta';
  const odooUser = config.ODOO_USER || 'shubhangsethi@gmail.com';
  const odooApiKey = config.ODOO_API_KEY;

  if (!odooApiKey) {
    console.log('ℹ️ [Odoo CRM]: No ODOO_API_KEY set. Skipping Odoo dispatch.');
    return;
  }

  const endpoint = `${odooUrl.replace(/\/$/, '')}/jsonrpc`;
  console.log(`📡 [Odoo CRM]: Authenticating with Odoo at ${endpoint}...`);

  try {
    // Step 1: Authenticate with Odoo common service (Read-only session UID)
    const authRes = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          service: 'common',
          method: 'authenticate',
          args: [odooDb, odooUser, odooApiKey, {}]
        },
        id: 1
      })
    });

    const authJson = await authRes.json();
    const uid = authJson.result;

    if (!uid) {
      console.error('❌ [Odoo CRM Authentication Error]: Could not authenticate. Response:', authJson);
      return;
    }

    console.log(`✅ [Odoo CRM Authenticated]: UID = ${uid}. Searching for existing Contact in res.partner...`);

    // Step 2: Search res.partner (READ-ONLY) for contact by email
    let partnerId = null;
    if (leadData.email) {
      const searchRes = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'call',
          params: {
            service: 'object',
            method: 'execute_kw',
            args: [
              odooDb,
              uid,
              odooApiKey,
              'res.partner',
              'search',
              [[['email', '=', leadData.email.trim()]]]
            ]
          },
          id: 2
        })
      });

      const searchJson = await searchRes.json();
      if (searchJson.result && Array.isArray(searchJson.result) && searchJson.result.length > 0) {
        partnerId = searchJson.result[0];
        console.log(`🤝 [Odoo CRM Contact Found]: Using existing partner_id = ${partnerId} (Existing contact left 100% untouched)`);
      }
    }

    // Step 3: If contact does not exist, create 1 brand-new contact in res.partner
    if (!partnerId) {
      console.log(`👤 [Odoo CRM]: Contact not found. Creating new contact for ${leadData.name} in res.partner...`);
      const partnerCreateRes = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'call',
          params: {
            service: 'object',
            method: 'execute_kw',
            args: [
              odooDb,
              uid,
              odooApiKey,
              'res.partner',
              'create',
              [
                {
                  name: leadData.name || 'New Lead',
                  email: leadData.email || '',
                  phone: leadData.whatsapp_number || '',
                  company_name: leadData.company || ''
                }
              ]
            ]
          },
          id: 3
        })
      });

      const partnerCreateJson = await partnerCreateRes.json();
      if (partnerCreateJson.result) {
        partnerId = partnerCreateJson.result;
        console.log(`✨ [Odoo CRM New Contact Created]: Partner ID = ${partnerId}`);
      } else {
        console.warn('⚠️ [Odoo CRM Contact Creation Warning]: Could not create res.partner:', partnerCreateJson.error || partnerCreateJson);
      }
    }

    // Step 4: Create Opportunity in crm.lead linked to partner_id
    console.log(`📊 [Odoo CRM]: Creating Opportunity in crm.lead linked to partner_id ${partnerId}...`);
    const leadValues = {
      name: `[Web Lead] ${leadData.company || leadData.name}`,
      contact_name: leadData.name,
      partner_name: leadData.company,
      email_from: leadData.email,
      phone: leadData.whatsapp_number
    };

    if (partnerId) {
      leadValues.partner_id = partnerId;
    }

    const createRes = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: {
          service: 'object',
          method: 'execute_kw',
          args: [
            odooDb,
            uid,
            odooApiKey,
            'crm.lead',
            'create',
            [leadValues]
          ]
        },
        id: 4
      })
    });

    const createJson = await createRes.json();
    const leadId = createJson.result;

    if (leadId) {
      console.log(`🎉 [Odoo CRM Success]: Opportunity created successfully! Record ID: ${leadId}`);

      // Step 5: Post formatted Log Note to right-side Chatter feed
      const logNoteHtml = `
<div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827;">
  <h4 style="color: #1B4332; margin: 0 0 8px 0; font-size: 14px; border-bottom: 1px solid #E5E7EB; padding-bottom: 4px;">📋 Qualified Lead Answers &amp; Booking Details</h4>
  <p style="margin: 0 0 6px 0;"><strong>Q1 Situation:</strong> ${leadData.q1_situation || 'Not answered'}</p>
  <p style="margin: 0 0 6px 0;"><strong>Q2 Urgency:</strong> ${leadData.q2_urgency || 'Not answered'}</p>
  <p style="margin: 0 0 6px 0;"><strong>📅 Booked Call Slot:</strong> ${leadData.bookedSlot || 'Pending calendar confirmation'}</p>
  <p style="margin: 0 0 6px 0;"><strong>🌐 Timezone:</strong> ${leadData.timezone || 'UTC'}</p>
  <p style="margin: 0;"><strong>📊 Attribution:</strong> Source: ${leadData.utm_source || 'Direct'} | Medium: ${leadData.utm_medium || 'Direct'} | Campaign: ${leadData.utm_campaign || 'Direct'}</p>
</div>
`.trim();

      const noteRes = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'call',
          params: {
            service: 'object',
            method: 'execute_kw',
            args: [
              odooDb,
              uid,
              odooApiKey,
              'crm.lead',
              'message_post',
              [leadId]
            ],
            kwargs: {
              body: logNoteHtml,
              message_type: 'comment',
              subtype_xmlid: 'mail.mt_note'
            }
          },
          id: 5
        })
      });

      const noteJson = await noteRes.json();
      if (noteJson.result) {
        console.log(`✅ [Odoo CRM Log Note]: Posted neatly into right-side chatter! Note ID: ${noteJson.result}`);
      } else {
        console.warn('⚠️ [Odoo CRM Log Note Warning]: Could not post log note:', noteJson.error || noteJson);
      }
    } else {
      console.error('❌ [Odoo CRM Lead Creation Error]:', createJson.error || createJson);
    }
  } catch (err) {
    console.error('❌ [Odoo CRM Exception Error]:', err.message);
  }
}

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

// Start Server
app.listen(PORT, () => {
  console.log(`🚀 Sahajta AI Enquiry-to-Site-Visit Engine running at http://localhost:${PORT}`);
  console.log(`  [✓] Landing Page: http://localhost:${PORT}/`);
});
