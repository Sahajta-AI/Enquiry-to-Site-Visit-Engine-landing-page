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
    // Same as the video already in the page's HTML, so it shows and starts at once, and stays if /api/config fails
    briefingVideoUrl: '/videos/briefing-540.mp4',
    briefingVideoPoster: '/videos/briefing-poster.jpg',
    briefingVideoCaptions: '/videos/briefing.vtt',
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

  // ---------- Part 9: new events (only fire when NEW_TRACKING is on; sv-core.js checks) ----------
  function track(name, params) {
    try { if (window.SVTrack) window.SVTrack.newEvent(name, params || {}); } catch (e) {}
  }

  // ---------- Settings-driven parts ----------
  function applySettings() {
    var hasVideo = !!settings.briefingVideoUrl;
    var hwTitle = $('ty-hw-title').firstElementChild;

    show($('ty-video-step'), hasVideo);
    if (!hasVideo) {
      var v = $('ty-video');
      if (v && v.getAttribute('src')) { v.removeAttribute('src'); v.load(); }
    }
    show($('ty-watch'), hasVideo);

    if (hasVideo) {
      hwTitle.textContent = '2. Get these 3 numbers ready'; // with the video it is step 2
      setupVideo();
      useVideoFile();
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

  function ownCaptions(video, box) {
    if (!video || !box) return;
    function wire() {
      var t = video.textTracks && video.textTracks[0];
      if (!t) return false;
      t.mode = 'hidden'; // loaded and timed, but not drawn by the browser
      // One line at a time, like the sales video (Shubhang, 18 Nov): only the newest caption, and a 2-line caption
      // is shown as 2 one-line captions, its time shared by the length of each line (one long line got cut with "...")
      var shown = null;
      function draw() {
        var cues = t.activeCues, text = '';
        var cue = cues && cues.length ? cues[cues.length - 1] : null;
        if (cue) {
          var parts = String(cue.text).split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
          var total = parts.reduce(function (n, l) { return n + l.length; }, 0) || 1;
          var at = cue.startTime, now = video.currentTime;
          for (var i = 0; i < parts.length; i++) {
            var end = i === parts.length - 1 ? cue.endTime : at + (cue.endTime - cue.startTime) * parts[i].length / total;
            if (now < end || i === parts.length - 1) { text = parts[i]; break; }
            at = end;
          }
        }
        if (text === shown) return;
        shown = text;
        box.textContent = text;
        box.classList.toggle('is-on', !!text);
      }
      t.addEventListener('cuechange', draw);
      video.addEventListener('timeupdate', draw);
      video.addEventListener('seeked', draw);
      draw();
      return true;
    }
    if (!wire()) {
      if (video.textTracks && video.textTracks.addEventListener) video.textTracks.addEventListener('addtrack', wire);
    }
    // Some browsers reset the mode when the track loads: keep it ours
    video.addEventListener('loadedmetadata', function () { var t = video.textTracks[0]; if (t && t.mode !== 'hidden') t.mode = 'hidden'; });
  }

  // Phones: our control bar (play/pause, time, seek, full screen). It hides 3 seconds after the last tap while
  // playing, shows on a tap, and stays while paused; a tap on the picture pauses and plays.
  function setupBar(wrap, video, bar) {
    var playBtn = $('ty-sb-play'), timeEl = $('ty-sb-time'), trackEl = $('ty-sb-track'), fillEl = $('ty-sb-fill'), fullBtn = $('ty-sb-full');
    var tap = $('ty-tap');
    var toggle = function () { if (video.paused) video.play().catch(function () {}); else video.pause(); };
    var clock = function (t) { t = Math.max(0, Math.floor(t || 0)); var s2 = t % 60; return Math.floor(t / 60) + ':' + (s2 < 10 ? '0' : '') + s2; };
    var drawBar = function () {
      var d = isFinite(video.duration) ? video.duration : 0;
      timeEl.textContent = clock(video.currentTime) + ' / ' + clock(d);
      fillEl.style.width = (d ? (video.currentTime / d) * 100 : 0) + '%';
    };
    var drawPlay = function () {
      bar.classList.toggle('is-paused', video.paused);
      playBtn.setAttribute('aria-label', video.paused ? 'Play' : 'Pause');
    };
    ['timeupdate', 'durationchange', 'seeked', 'loadedmetadata'].forEach(function (ev) { video.addEventListener(ev, drawBar); });
    ['play', 'pause', 'ended'].forEach(function (ev) { video.addEventListener(ev, drawPlay); });
    playBtn.addEventListener('click', toggle);
    if (tap) tap.addEventListener('click', toggle);

    var seekTo = function (x) {
      var r = trackEl.getBoundingClientRect(), d = video.duration;
      if (!isFinite(d) || !r.width) return;
      video.currentTime = Math.min(1, Math.max(0, (x - r.left) / r.width)) * d;
      drawBar();
    };
    var dragging = false;
    trackEl.addEventListener('pointerdown', function (e) { dragging = true; if (trackEl.setPointerCapture) trackEl.setPointerCapture(e.pointerId); seekTo(e.clientX); });
    trackEl.addEventListener('pointermove', function (e) { if (dragging) seekTo(e.clientX); });
    ['pointerup', 'pointercancel'].forEach(function (ev) { trackEl.addEventListener(ev, function () { dragging = false; }); });

    // Full screen: the phone's own full-screen player (iPhones only allow that one), with its own controls
    fullBtn.addEventListener('click', function () {
      if (video.webkitEnterFullscreen && !video.requestFullscreen) { video.webkitEnterFullscreen(); return; }
      if (video.requestFullscreen) {
        video.controls = true;
        video.requestFullscreen().catch(function () { video.controls = false; if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); });
      } else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
    });
    document.addEventListener('fullscreenchange', function () { if (!document.fullscreenElement) video.controls = false; });

    var barTimer = 0;
    var barUp = function () {
      if (bar.hidden) return;
      wrap.classList.add('bar-up');
      clearTimeout(barTimer);
      barTimer = setTimeout(function () { if (!video.paused) wrap.classList.remove('bar-up'); }, 3000);
    };
    ['pointerdown', 'touchstart'].forEach(function (ev) { wrap.addEventListener(ev, barUp, { passive: true }); });
    video.addEventListener('play', function () { setTimeout(barUp, 0); });
    video.addEventListener('pause', function () { clearTimeout(barTimer); wrap.classList.add('bar-up'); });
    drawBar(); drawPlay();
  }

  function setupVideo() {
    if (videoReady) return;
    videoReady = true;

    var wrap = $('ty-video-wrap');
    var video = $('ty-video');
    var playBtn = $('ty-video-play');

    // Captions on from the start, drawn by us at the very bottom of the picture (the browser's own captions
    // jump up over the video's text whenever its control bar shows; Shubhang 15 Nov)
    ownCaptions(video, $('ty-video-cap'));

    var watched = false;
    try { watched = sessionStorage.getItem('sv_watched') === '1'; } catch (e) {}
    show($('ty-watched'), watched);

    // Phones and tablets (touch, no mouse) get our own control bar and tap-to-pause, the same as the sales video
    // (an iPhone's own inline player has no pause). Laptops keep the browser's own controls.
    var touch = !!(window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches);
    var bar = $('ty-bar');
    var useBar = touch && !!bar;
    var showControls = function () {
      wrap.classList.add('has-controls');
      if (useBar) { bar.hidden = false; wrap.classList.add('has-bar'); }
      else video.controls = true;
    };

    // Our gold button only starts the video. From then on the controls take over and our layer is
    // removed completely (a layer left over the picture drew a hard line across it, Shubhang 15 Nov)
    playBtn.addEventListener('click', function () {
      showControls();
      video.play().catch(function () {});
    });

    var started = false, sent90 = false;
    video.addEventListener('play', function () {
      wrap.classList.add('is-playing');
      showControls();
      if (!started) { started = true; track('PreCallVideoStart'); }
    });

    if (useBar) setupBar(wrap, video, bar);
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

  // The page already loads the hosted video (so it starts at once) and it is kept as it is. Only a different file
  // set in the settings replaces it (and it is never swapped once someone has pressed play).
  function useVideoFile() {
    var video = $('ty-video');
    var url = settings.briefingVideoUrl;
    if (!url || video.getAttribute('src') === url || !video.paused || video.currentTime > 0) return;
    video.setAttribute('src', url);
    if (settings.briefingVideoPoster) video.setAttribute('poster', settings.briefingVideoPoster);
    else video.removeAttribute('poster');
    var oldCap = video.querySelector('track');
    if (oldCap) oldCap.parentNode.removeChild(oldCap);
    if (settings.briefingVideoCaptions) {
      var cap = document.createElement('track');
      cap.kind = 'captions';
      cap.label = 'English';
      cap.srclang = 'en';
      cap.src = settings.briefingVideoCaptions;
      cap.default = true;
      video.appendChild(cap);
    }
    video.load();
  }

  // ---------- Go ----------
  renderTop();
  wireButtons();
  applySettings(); // shows the hosted video at once; the settings below can only hide it or swap the file

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
