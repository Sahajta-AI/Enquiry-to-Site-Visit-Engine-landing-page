#!/usr/bin/env node
/**
 * One-time Gmail sign-in for the automatic emails. Shubhang runs this ONCE, on his own computer.
 *
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/gmail-token.js
 *
 * Before: in Google Cloud (a project inside sahajta.com's Google Workspace), turn on the Gmail API, set the OAuth
 * consent screen's user type to "Internal" (no 7-day expiry, no Google verification), and create an OAuth client
 * of type "Desktop app". Ask only for gmail.send and gmail.metadata (this script does).
 *
 * It opens a sign-in link, he approves with shubhang@sahajta.com, and the refresh token is printed here.
 * Put that token into Vercel as GOOGLE_REFRESH_TOKEN through 1Password. Never paste it in chat or email.
 */
const http = require('http');
const crypto = require('crypto');

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.');
  process.exit(1);
}

const PORT = 53682;
const redirect = `http://127.0.0.1:${PORT}/callback`;
const state = crypto.randomBytes(12).toString('hex');
const scopes = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.metadata'];

const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirect,
  response_type: 'code',
  scope: scopes.join(' '),
  access_type: 'offline',
  prompt: 'consent',
  login_hint: process.env.GMAIL_SENDER || 'shubhang@sahajta.com',
  state
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, redirect);
  if (url.pathname !== '/callback') { res.writeHead(404); return res.end(); }
  if (url.searchParams.get('state') !== state || !url.searchParams.get('code')) {
    res.writeHead(400); res.end('Sign-in failed (state or code missing).');
    return;
  }
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: url.searchParams.get('code'), client_id: clientId, client_secret: clientSecret,
        redirect_uri: redirect, grant_type: 'authorization_code'
      })
    });
    const json = await tokenRes.json();
    if (!json.refresh_token) throw new Error(json.error_description || json.error || 'No refresh token came back');
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Done. You can close this tab and go back to the terminal.');
    console.log('\nGOOGLE_REFRESH_TOKEN (put this in Vercel through 1Password, not in chat):\n');
    console.log(json.refresh_token + '\n');
  } catch (err) {
    res.writeHead(500); res.end('Sign-in failed.');
    console.error('Sign-in failed:', err.message);
  }
  server.close();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Open this link, sign in as shubhang@sahajta.com and approve:\n\n' + authUrl + '\n');
});
