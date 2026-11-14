/**
 * /thank-you: the page after a booking, and the pre-call page when opened without one.
 * Booking details come from the browser's session memory (key "sv_booked"), never from the address.
 * This page never fires "Schedule", so a reload or a direct visit sends nothing.
 */
(function () {
  'use strict';

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  var settings = {
    whatsappNumber: '919731173205',
    briefingVideoUrl: '',
    briefingVideoPoster: '',
    briefingVideoCaptions: '',
    demoWhatsappNumber: ''
  };

  function $(id) { return document.getElementById(id); }

  // ---------- Booking details ----------
  function readBooking() {
    var raw = null;
    try { raw = sessionStorage.getItem('sv_booked'); } catch (e) { return null; }
    if (!raw) return null;
    try {
      var b = JSON.parse(raw);
      if (!b || !/^\d{4}-\d{2}-\d{2}$/.test(b.slotDate || '')) return null;
      if (!/^\s*\d{1,2}:\d{2}\s*(AM|PM)\s*$/i.test(b.slotTime || '')) return null;
      return b;
    } catch (e) { return null; }
  }

  // "09:00 AM" -> "9:00 am"
  function formatTime(slotTime) {
    var m = String(slotTime).match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    return parseInt(m[1], 10) + ':' + m[2] + ' ' + m[3].toLowerCase();
  }

  // The date is already in the booking's own zone, so read it as a plain calendar date
  function dateParts(slotDate) {
    var p = slotDate.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return { weekday: DAYS[d.getUTCDay()], day: p[2], month: MONTHS[p[1] - 1] };
  }

  function zoneLabel(tz) {
    if (!tz || tz === 'Asia/Kolkata' || tz === 'Asia/Calcutta') return 'IST';
    var city = String(tz).split('/').pop().replace(/_/g, ' ');
    return city + ' time';
  }

  function isIndia(tz) {
    return !tz || tz === 'Asia/Kolkata' || tz === 'Asia/Calcutta';
  }

  // ---------- Page state ----------
  var booking = readBooking();
  var confirmMessage = 'YES';

  function setText(id, text) { var el = $(id); if (el) el.textContent = text; }
  function show(el, on) { if (el) el.hidden = !on; }

  function renderTop() {
    if (booking) {
      var dp = dateParts(booking.slotDate);
      var time = formatTime(booking.slotTime);
      var zone = zoneLabel(booking.timezone);
      var dayText = dp.weekday + ', ' + dp.day + ' ' + dp.month;
      var when = dayText + ' at ' + time + ' ' + zone;
      var first = (booking.firstName || '').trim();

      var h1 = $('ty-h1');
      h1.textContent = '';
      h1.appendChild(document.createTextNode('You’re booked'));
      if (first) {
        h1.appendChild(document.createTextNode(', '));
        var nameSpan = document.createElement('span');
        nameSpan.setAttribute('data-clarity-mask', 'true');
        nameSpan.textContent = first;
        h1.appendChild(nameSpan);
      }
      h1.appendChild(document.createTextNode('.'));

      // The date shows once, in the card ("Scheduled for" and the time in bold); no grey line under the heading

      show($('ty-tick'), true);
      show($('ty-card-label'), true);
      setText('ty-card-time', when);
      show($('ty-card-time'), true);
      show($('ty-card-lead'), false);
      show($('ty-invite'), true);

      if (booking.rescheduleUrl && /^https:\/\//.test(booking.rescheduleUrl)) {
        $('ty-resched-link').setAttribute('href', booking.rescheduleUrl);
        show($('ty-resched'), true);
      }

      var shortDay = dp.weekday.slice(0, 3) + ' ' + dp.day + ' ' + dp.month.slice(0, 3);
      confirmMessage = 'YES, confirming my Lead Conversion Clarity Call on ' + shortDay + ' at ' + time +
        (isIndia(booking.timezone) ? '' : ' ' + zone) + '.' + (first ? ' ' + first : '');
      document.title = 'Your Lead Conversion Clarity Call | Sahajta AI';
    } else {
      // Pre-call page
      show($('ty-oncall'), true);
      confirmMessage = 'YES';
    }
  }

  // ---------- Confirm button: WhatsApp only (the text/SMS option was removed, Shubhang 11 Nov) ----------
  function wireButtons() {
    var wa = $('btn-wa');
    var after = $('ty-after-tap');
    var number = String(settings.whatsappNumber).replace(/\D/g, '') || '919731173205';

    wa.setAttribute('href', 'https://wa.me/' + number + '?text=' + encodeURIComponent(confirmMessage));

    wa.addEventListener('click', function () {
      track('ConfirmWhatsApp');
      after.textContent = 'WhatsApp is open. Send the message there to confirm.';
      show(after, true);
    });
  }

  // ---------- Part 9: new events (only fire when NEW_TRACKING is on; tracking.js checks) ----------
  function track(name, params) {
    try { if (window.SVTrack) window.SVTrack.newEvent(name, params || {}); } catch (e) {}
  }

  // ---------- Settings-driven parts ----------
  function applySettings() {
    var hasVideo = !!settings.briefingVideoUrl;
    var hwTitle = $('ty-hw-title').firstElementChild;

    show($('ty-video-step'), hasVideo);
    show($('ty-watch'), hasVideo);

    if (hasVideo) {
      hwTitle.textContent = '2. Get these 3 numbers ready'; // with the video it is step 2
      setupVideo();
    } else {
      hwTitle.textContent = 'Get these 3 numbers ready';
    }

    var demo = String(settings.demoWhatsappNumber || '').replace(/\D/g, '');
    if (demo) {
      $('btn-demo').setAttribute('href', 'https://wa.me/' + demo + '?text=' + encodeURIComponent('Hi'));
      $('btn-demo').addEventListener('click', function () { track('DemoTap'); });
      show($('live-demo'), true);
    }
  }

  // ---------- Video (our own player, nothing downloads until play) ----------
  var videoReady = false;

  function setupVideo() {
    if (videoReady) return;
    videoReady = true;

    var wrap = $('ty-video-wrap');
    var video = $('ty-video');
    var playBtn = $('ty-video-play');

    if (settings.briefingVideoPoster) video.setAttribute('poster', settings.briefingVideoPoster);
    video.setAttribute('preload', 'none');
    video.src = settings.briefingVideoUrl;
    if (settings.briefingVideoCaptions) {
      var track = document.createElement('track');
      track.kind = 'captions';
      track.label = 'English';
      track.srclang = 'en';
      track.src = settings.briefingVideoCaptions;
      video.appendChild(track);
    }

    var watched = false;
    try { watched = sessionStorage.getItem('sv_watched') === '1'; } catch (e) {}
    show($('ty-watched'), watched);

    playBtn.addEventListener('click', function () {
      video.controls = true;
      wrap.classList.add('has-controls');
      if (video.paused) video.play().catch(function () {});
      else video.pause();
    });

    var started = false, sent90 = false;
    video.addEventListener('play', function () {
      wrap.classList.add('is-playing');
      if (!started) { started = true; track('PreCallVideoStart'); }
    });
    video.addEventListener('pause', function () { wrap.classList.remove('is-playing'); });
    video.addEventListener('ended', function () { wrap.classList.remove('is-playing'); });

    // "Watched" shows only after 90%, and stays after a reload (session memory)
    video.addEventListener('timeupdate', function () {
      if (!video.duration || !isFinite(video.duration)) return;
      if (video.currentTime / video.duration < 0.9) return;
      if (!sent90) { sent90 = true; track('PreCallVideo90'); }
      if (!watched) {
        watched = true;
        try { sessionStorage.setItem('sv_watched', '1'); } catch (e) {}
        show($('ty-watched'), true);
      }
    });
  }

  // ---------- Go ----------
  renderTop();
  wireButtons();
  applySettings(); // no video until the settings say so

  fetch('/api/config')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data) return;
      ['whatsappNumber', 'briefingVideoUrl', 'briefingVideoPoster', 'briefingVideoCaptions', 'demoWhatsappNumber'].forEach(function (k) {
        if (typeof data[k] === 'string') settings[k] = data[k];
      });
      wireButtonLinksOnly();
      applySettings();
    })
    .catch(function () {});

  // Settings arrived after the first paint: refresh only the links that depend on the number
  function wireButtonLinksOnly() {
    var number = String(settings.whatsappNumber).replace(/\D/g, '') || '919731173205';
    $('btn-wa').setAttribute('href', 'https://wa.me/' + number + '?text=' + encodeURIComponent(confirmMessage));
  }
})();
