/**
 * Tracking for every page (Backend and Tracking Brief, parts 5, 6 and 8).
 *  - Loads ONE Pixel, after /api/config replies: the live Pixel on production, the Sandbox Pixel on previews.
 *    The ID always comes from the server. Never hard-coded here.
 *  - One small helper for every tracking call. It does nothing when the Pixel isn't loaded (an ad blocker), so the page never breaks.
 *  - Saves where the visitor came from (sv_attrib, 30 days).
 *  - Microsoft Clarity, only when the server says NEW_TRACKING is on and a Clarity ID is set.
 * Never put a name, email or number in a page address or an analytics event.
 */
(function () {
  'use strict';

  var ATTRIB_KEY = 'sv_attrib';
  var THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  var memoryAttrib = null; // localStorage can fail (private windows): keep the values in memory for the visit
  var cfg = null;
  var pixelLoaded = false;
  var waiting = [];

  // ---------- Where the visitor came from ----------
  function readStored() {
    var raw = null;
    try { raw = window.localStorage.getItem(ATTRIB_KEY); } catch (e) {}
    if (!raw) return memoryAttrib;
    try {
      var o = JSON.parse(raw);
      if (o && o.exp > Date.now() && o.data) return o;
    } catch (e) {}
    return memoryAttrib;
  }

  function captureAttribution() {
    var params;
    try { params = new URLSearchParams(window.location.search); } catch (e) { return; }
    var keys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
    var hasAd = !!params.get('fbclid') || keys.some(function (k) { return params.get(k); });
    if (!hasAd) return; // "angle" on its own never replaces what is saved
    var data = {};
    keys.concat(['fbclid', 'angle']).forEach(function (k) {
      var v = params.get(k);
      if (v) data[k] = v.slice(0, 500);
    });
    data.landing_url = window.location.href.slice(0, 500); // a later ad click replaces the earlier one
    data.referrer = (document.referrer || '').slice(0, 500);
    data.first_seen = new Date().toISOString();
    var wrapped = { exp: Date.now() + THIRTY_DAYS, data: data };
    memoryAttrib = wrapped;
    try { window.localStorage.setItem(ATTRIB_KEY, JSON.stringify(wrapped)); } catch (e) {}
  }

  function attribution() {
    var s = readStored();
    return s ? s.data : {};
  }

  // ---------- Config, then the Pixel ----------
  function loadPixel(id) {
    if (!id || pixelLoaded) return;
    /* Meta's standard base code, with the ID from the server */
    !function (f, b, e, v, n, t, s) {
      if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = []; t = b.createElement(e); t.async = !0;
      t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    window.fbq('set', 'autoConfig', false, id);
    window.fbq('init', id);
    window.fbq('track', 'PageView'); // one PageView per page load
    pixelLoaded = true;
  }

  function loadClarity(id) {
    if (!id || window.clarity) return;
    (function (c, l, a, r, i, t, y) {
      c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
      t = l.createElement(r); t.async = 1; t.src = 'https://www.clarity.ms/tag/' + i;
      y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
    })(window, document, 'clarity', 'script', id);
    try {
      var angle = new URLSearchParams(window.location.search).get('angle') || attribution().angle;
      if (angle) window.clarity('set', 'angle', angle); // tag the session with the headline version
    } catch (e) {}
  }

  function scheduleClarity(id) {
    if (!id) return;
    var go = function () { setTimeout(function () { loadClarity(id); }, 2000); };
    if (document.readyState === 'complete') go();
    else window.addEventListener('load', go);
  }

  captureAttribution();

  var ready = fetch('/api/config')
    .then(function (r) { return r.json(); })
    .then(function (c) {
      cfg = c || {};
      loadPixel(cfg.metaPixelId);
      // Clarity: only with a Clarity ID and NEW_TRACKING on
      if (cfg.newTracking) scheduleClarity(cfg.clarityId);
      waiting.splice(0).forEach(function (fn) { try { fn(); } catch (e) {} });
      return cfg;
    })
    .catch(function () { cfg = {}; return cfg; });

  function whenReady(fn) {
    if (cfg) { try { fn(); } catch (e) {} } else waiting.push(fn);
  }

  // ---------- The one helper ----------
  // Standard events: fbq('track', ...). Custom events: fbq('trackCustom', ...). Does nothing without a Pixel.
  function fire(custom, name, params, eventId) {
    whenReady(function () {
      if (!pixelLoaded || typeof window.fbq !== 'function') return;
      try {
        var opts = eventId ? { eventID: eventId } : undefined;
        if (custom) window.fbq('trackCustom', name, params || {}, opts);
        else window.fbq('track', name, params || {}, opts);
      } catch (e) {}
    });
  }

  window.SVTrack = {
    config: function () { return ready; },
    attribution: attribution,
    // Lead and Schedule: with the event ID shared with the server
    standard: function (name, params, eventId) { fire(false, name, params, eventId); },
    // The new events (5.4) go live only when NEW_TRACKING is on
    newEvent: function (name, params, custom) {
      whenReady(function () { if (cfg && cfg.newTracking) fire(custom !== false, name, params); });
    },
    pixelKind: function () { return cfg && cfg.pixelKind; }
  };
})();
