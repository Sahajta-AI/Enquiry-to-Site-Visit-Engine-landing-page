#!/usr/bin/env node
/**
 * Gmail sign-in when the approver is on another computer (two steps, no waiting server).
 *
 *   node scripts/gmail-token-remote.js link
 *       Prints a sign-in link. Send it to the sender (shubhang@sahajta.com). He opens it, clicks Allow.
 *       His browser then lands on a page that says "can't connect" (127.0.0.1). That is expected.
 *       He copies the full address from the address bar and sends it back.
 *
 *   node scripts/gmail-token-remote.js exchange "http://127.0.0.1:53682/callback?code=...&state=..."
 *       Swaps that address's one-time code for the refresh token, and prints it (never logs the secret).
 *       Add --write to also put it into .env as GOOGLE_REFRESH_TOKEN.
 *
 * Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (read from .env). The OAuth client must be of type "Desktop app".
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const envPath = path.join(__dirname, '..', '.env');
function readEnv() {
  const out = {};
  try {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch (e) { /* no .env */ }
  return out;
}
const env = Object.assign(readEnv(), process.env);
const clientId = env.GOOGLE_CLIENT_ID;
const clientSecret = env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) { console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.'); process.exit(1); }

const redirect = 'http://127.0.0.1:53682/callback';
const scopes = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.metadata'];
const [cmd, arg] = process.argv.slice(2);

if (cmd === 'link') {
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirect, scope: scopes.join(' '),
    access_type: 'offline', prompt: 'select_account consent', login_hint: env.GMAIL_SENDER || 'shubhang@sahajta.com'
  });
  console.log('\n' + url + '\n');
} else if (cmd === 'exchange' && arg) {
  (async () => {
    const code = new URL(arg).searchParams.get('code');
    if (!code) { console.error('No code in that address.'); process.exit(1); }
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: 'authorization_code' })
    });
    const json = await res.json();
    if (!json.refresh_token) { console.error('Failed:', json.error_description || json.error || 'no refresh token'); process.exit(1); }
    if (process.argv.includes('--write')) {
      let text = fs.readFileSync(envPath, 'utf8');
      text = /^GOOGLE_REFRESH_TOKEN=.*$/m.test(text)
        ? text.replace(/^GOOGLE_REFRESH_TOKEN=.*$/m, () => 'GOOGLE_REFRESH_TOKEN=' + json.refresh_token)
        : text + '\nGOOGLE_REFRESH_TOKEN=' + json.refresh_token + '\n';
      fs.writeFileSync(envPath, text);
      console.log('Saved GOOGLE_REFRESH_TOKEN to .env. Scopes granted:', json.scope);
    } else {
      console.log('\nGOOGLE_REFRESH_TOKEN:\n' + json.refresh_token + '\n');
    }
  })().catch(e => { console.error('Failed:', e.message); process.exit(1); });
} else {
  console.error('Usage: link | exchange "<address>" [--write]');
  process.exit(1);
}
