// Gmail API on Shubhang's mailbox (not SMTP, not a bulk-mail service): the emails sit in his Sent folder,
// replies reach him, and the second email can go under the first. Scopes needed: gmail.send and gmail.metadata.
const cfg = require('./config');

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
let tokenCache = { value: null, exp: 0 };

function isConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN);
}

async function accessToken() {
  if (tokenCache.value && tokenCache.exp > Date.now() + 60000) return tokenCache.value;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) throw new Error('Gmail sign-in failed: ' + (json.error_description || json.error || res.status));
  tokenCache = { value: json.access_token, exp: Date.now() + (json.expires_in || 3600) * 1000 };
  return tokenCache.value;
}

async function api(path, options) {
  const token = await accessToken();
  const res = await fetch(API + path, Object.assign({}, options, {
    headers: Object.assign({ Authorization: `Bearer ${token}` }, (options && options.headers) || {})
  }));
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Gmail API ' + res.status + ': ' + ((json.error && json.error.message) || 'error'));
  return json;
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
const b64url = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);

// HTML with a plain-text copy; In-Reply-To and References put a reply under an earlier email
function buildMime({ to, subject, text, html, inReplyTo }) {
  const boundary = 'sahajta_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const headers = [
    `From: ${encodeHeader(cfg.SENDER_NAME)} <${cfg.senderEmail()}>`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    `Date: ${new Date().toUTCString()}`
  ];
  if (inReplyTo) {
    headers.push(`In-Reply-To: ${inReplyTo}`);
    headers.push(`References: ${inReplyTo}`);
  }
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    b64(text),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    b64(html),
    `--${boundary}--`,
    ''
  ];
  return headers.join('\r\n') + '\r\n\r\n' + body.join('\r\n');
}

function headerValue(message, name) {
  const list = (message.payload && message.payload.headers) || [];
  const h = list.find(x => String(x.name).toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}

// Sends the email, then reads its Message-ID back (a reply under it needs that)
async function send({ to, subject, text, html, inReplyTo, threadId }) {
  const raw = b64url(buildMime({ to, subject, text, html, inReplyTo }));
  const body = { raw };
  if (threadId) body.threadId = threadId;
  const sent = await api('/messages/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  let messageId = null;
  try {
    const meta = await api(`/messages/${sent.id}?format=metadata&metadataHeaders=Message-ID`);
    messageId = headerValue(meta, 'Message-ID');
  } catch (e) {
    console.warn('⚠️ [Gmail]: sent, but could not read the Message-ID back:', e.message);
  }
  return { id: sent.id, threadId: sent.threadId, messageId };
}

// The ids of every message in the thread, so we can see whether anyone wrote since our email
async function threadMessageIds(threadId) {
  const t = await api(`/threads/${encodeURIComponent(threadId)}?format=metadata&metadataHeaders=From`);
  return (t.messages || []).map(m => m.id);
}

module.exports = { isConfigured, send, threadMessageIds, buildMime, headerValue };
