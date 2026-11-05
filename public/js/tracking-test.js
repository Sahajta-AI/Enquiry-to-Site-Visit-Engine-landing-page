/**
 * The private tracking test page (Backend and Tracking Brief, part 11).
 * The password goes in a header on every request. Nothing from this page ever goes to the live Pixel
 * except one custom event, TrackingCheck, from the "Live Pixel: final check" mode.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var password = '';
  var info = null;
  var liveMode = /[?&]live=1\b/.test(window.location.search);
  var pixelLoaded = false;
  var pixelId = '';
  var logLines = [];

  function uuid() {
    try { if (crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
  }

  function log(line) {
    var t = new Date().toLocaleTimeString('en-GB');
    logLines.push(t + '  ' + line);
    $('log').textContent = logLines.join('\n');
    $('log').scrollTop = $('log').scrollHeight;
  }

  async function api(body) {
    var res = await fetch('/api/tracking-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-password': password },
      body: JSON.stringify(body)
    });
    var data = await res.json().catch(function () { return {}; });
    return { status: res.status, data: data };
  }

  // ---------- The Pixel on this page: the Sandbox, or (live mode) the live one ----------
  function loadPixel(id) {
    if (!id) return;
    !function (f, b, e, v, n, t, s) {
      if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = []; t = b.createElement(e); t.async = !0;
      t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    window.fbq('set', 'autoConfig', false, id);
    window.fbq('init', id);
    pixelId = id;
  }

  // The script file loads only if nothing (an ad blocker) stopped it
  function pixelScriptLoaded() {
    return !!(window.fbq && window.fbq.loaded === true && document.querySelector('script[src*="fbevents.js"]') && typeof window.fbq.callMethod !== 'undefined');
  }

  function browserSend(kind, name, params, eventId) {
    if (!window.fbq) return 'not sent (Pixel blocked)';
    try {
      var opts = eventId ? { eventID: eventId } : undefined;
      if (kind === 'custom') window.fbq('trackCustom', name, params || {}, opts);
      else window.fbq('track', name, params || {}, opts);
      return 'sent';
    } catch (e) { return 'not sent (' + e.message + ')'; }
  }

  function keysText(k) {
    if (!k) return '-';
    return Object.keys(k).map(function (n) { return n + ': ' + (k[n] ? 'yes' : 'no'); }).join(', ');
  }

  async function serverSend(event, eventId, target) {
    var r = await api({ action: 'send', event: event, eventId: eventId, target: target, pageUrl: window.location.href.split('#')[0] });
    var d = r.data || {};
    if (r.status !== 200 || d.ok === false) {
      return 'error: ' + (d.error || ('HTTP ' + r.status)) + (d.fbtraceId ? ' (fbtrace_id ' + d.fbtraceId + ')' : '');
    }
    return 'received ' + d.eventsReceived + ', fbtrace_id ' + d.fbtraceId + (d.skipped ? ' (' + d.skipped + ')' : '') + '\n      match keys sent: ' + keysText(d.matchKeys);
  }

  function logEvent(event, eventId, target, browser, server) {
    log(event + '  id ' + eventId + '  target ' + target + '\n    browser: ' + browser + '\n    server:  ' + server);
  }

  // ---------- One event ----------
  var BROWSER_ONLY = {
    PageView: ['standard', {}],
    ViewContent: ['standard', { content_name: 'Sales video' }],
    VideoProgress: ['custom', { percent: 25 }],
    BookCallClick: ['custom', { location: 'hero' }],
    FormStart: ['custom', {}],
    FormStep: ['custom', { step: 1 }],
    CalendarView: ['custom', {}],
    TestimonialPlay: ['custom', { name: 'Test' }]
  };
  var BOTH = { Lead: 'Lead Conversion Clarity Call form', Schedule: 'Lead Conversion Clarity Call' };

  async function runEvent(name) {
    var id = uuid();
    var target = 'Sandbox (' + pixelId + ')';
    if (BROWSER_ONLY[name]) {
      var b = browserSend(BROWSER_ONLY[name][0], name, BROWSER_ONLY[name][1], name === 'PageView' ? undefined : id);
      logEvent(name, name === 'PageView' ? '-' : id, target, b, 'not sent (browser only)');
    } else if (BOTH[name]) {
      var br = browserSend('standard', name, { content_name: BOTH[name] }, id);
      var sv = await serverSend(name, id, 'sandbox');
      logEvent(name, id, target, br, sv);
    } else if (name === 'QualifiedBooking') {
      logEvent(name, id + '-q', target, 'not sent (server only)', await serverSend(name, id + '-q', 'sandbox'));
    }
  }

  async function journey() {
    log('--- Full journey (dummy lead: Test Lead) ---');
    await runEvent('PageView');
    var leadId = uuid(), schedId = uuid();
    var target = 'Sandbox (' + pixelId + ')';
    logEvent('Lead', leadId, target, browserSend('standard', 'Lead', { content_name: BOTH.Lead }, leadId), await serverSend('Lead', leadId, 'sandbox'));
    logEvent('Schedule', schedId, target, browserSend('standard', 'Schedule', { content_name: BOTH.Schedule }, schedId), await serverSend('Schedule', schedId, 'sandbox'));
    logEvent('QualifiedBooking', schedId + '-q', target, 'not sent (server only)', await serverSend('QualifiedBooking', schedId + '-q', 'sandbox'));
    log('--- End of journey ---');
  }

  async function liveCheck() {
    var id = uuid();
    var br = browserSend('custom', 'TrackingCheck', { content_name: 'Tracking check' }, id);
    var sv = await serverSend('TrackingCheck', id, 'live');
    logEvent('TrackingCheck', id, 'LIVE (' + pixelId + ')', br, sv);
  }

  // ---------- The top of the page ----------
  function yn(v) { return v ? 'yes' : 'no'; }

  function renderStatus() {
    var t = liveMode ? info.live : info.sandbox;
    $('status').innerHTML = '';
    [
      ['Pixel ID in use', (liveMode ? 'LIVE ' : 'Sandbox ') + (pixelId || '(none set)')],
      ['Pixel script loaded (if not, an ad blocker is likely)', yn(pixelScriptLoaded())],
      ['Graph API version', info.graphVersion],
      ['Access token set', yn(t.tokenSet)],
      ['Test code set', yn(t.testCodeSet)],
      ['NEW_TRACKING', info.newTracking ? 'on' : 'off']
    ].forEach(function (row) {
      var tr = document.createElement('tr');
      row.forEach(function (cell) { var td = document.createElement('td'); td.textContent = cell; tr.appendChild(td); });
      $('status').appendChild(tr);
    });
  }

  async function unlock() {
    password = $('pw').value;
    $('lock-msg').textContent = 'Checking…';
    var r = await api({ action: 'info' });
    if (r.status !== 200 || !r.data.ok) {
      $('lock-msg').textContent = r.status === 503 ? 'The test page is not set up yet (no password on the server).' : 'Wrong password.';
      password = '';
      return;
    }
    info = r.data;
    $('lock').hidden = true;
    $('app').hidden = false;

    if (liveMode && !info.production) { liveMode = false; log('The live check works on production only. Showing the Sandbox.'); }
    pixelId = '';
    loadPixel((liveMode ? info.live : info.sandbox).pixelId);
    $('live-banner').hidden = !liveMode;
    $('sandbox-panel').hidden = liveMode;
    $('live-panel').hidden = !liveMode;
    $('to-live').hidden = liveMode || !info.production;
    $('to-sandbox').hidden = !liveMode;
    setTimeout(renderStatus, 800); // give the Pixel script a moment, so "loaded" is true
    renderStatus();
  }

  $('unlock').addEventListener('click', unlock);
  $('pw').addEventListener('keydown', function (e) { if (e.key === 'Enter') unlock(); });
  $('events').addEventListener('click', function (e) { var n = e.target.getAttribute('data-ev'); if (n) runEvent(n); });
  $('new-events').addEventListener('click', function (e) { var n = e.target.getAttribute('data-ev'); if (n) runEvent(n); });
  $('journey').addEventListener('click', journey);
  $('live-send').addEventListener('click', liveCheck);
  $('to-live').addEventListener('click', function () { window.location.href = '/tracking-test?live=1'; });
  $('to-sandbox').addEventListener('click', function () { window.location.href = '/tracking-test'; });
  $('clear').addEventListener('click', function () { logLines = []; $('log').textContent = ''; });
  $('copy').addEventListener('click', function () {
    var text = logLines.join('\n');
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(function () {});
  });
})();
