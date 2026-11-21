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
    demoWhatsappNumber: '',
    calBookingPage: '' // e.g. "shubhang-sethi/enquiry-to-site-visit-engine": the reschedule pop-up needs it
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

      // Shown only with a live booking's link; after a move with no new uid it's hidden (never the cancelled one's link)
      var reschedOk = !!(booking.rescheduleUrl && /^https:\/\//.test(booking.rescheduleUrl));
      if (reschedOk) $('ty-resched-link').setAttribute('href', booking.rescheduleUrl);
      else $('ty-resched-link').setAttribute('href', '#');
      show($('ty-resched'), reschedOk);

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

    // A web page can't see whether the message was sent. So: "WhatsApp is open…" right after the tap, and once they
    // come back to this page (or a phone reloads it on the way back), "Sent it? You're all set." (Shubhang, 18 Nov)
    var OPEN_LINE = 'WhatsApp is open. Send the message there to confirm.';
    var BACK_LINE = 'Sent it? You’re all set.';
    var tapped = false, wentAway = false;
    var remembered = false;
    try { remembered = sessionStorage.getItem('sv_wa_tapped') === '1'; } catch (e) {}
    if (remembered) { after.textContent = BACK_LINE; show(after, true); }

    wa.addEventListener('click', function () {
      track('ConfirmWhatsApp');
      tapped = true; wentAway = false;
      try { sessionStorage.setItem('sv_wa_tapped', '1'); } catch (e) {}
      after.textContent = OPEN_LINE;
      show(after, true);
    });

    var cameBack = function () {
      if (!tapped || !wentAway) return;
      after.textContent = BACK_LINE;
    };
    document.addEventListener('visibilitychange', function () {
      if (!tapped) return;
      if (document.visibilityState === 'hidden') wentAway = true;
      else cameBack();
    });
    // Laptops: WhatsApp Web opens in another tab or window; this one loses focus without being hidden
    window.addEventListener('blur', function () { if (tapped) wentAway = true; });
    window.addEventListener('focus', cameBack);
    window.addEventListener('pageshow', function (e) { if (e.persisted && tapped) { wentAway = true; cameBack(); } });
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

    // "Watched" belongs to this booking (a new booking starts fresh); the pre-call page has its own
    var b = readBooking();
    var watchKey = 'sv_watched:' + (b ? [b.slotDate, b.slotTime, b.rescheduleUrl || ''].join('|') : 'pre-call');
    var watched = false;
    try { watched = sessionStorage.getItem(watchKey) === '1'; sessionStorage.removeItem('sv_watched'); } catch (e) {}
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

    // "Watched" shows only after 90% of the video was actually played (skipping ahead doesn't count),
    // and stays after a reload for this booking (session memory)
    var playedSeconds = function () {
      var r = video.played, total = 0;
      for (var i = 0; r && i < r.length; i++) total += r.end(i) - r.start(i);
      return total;
    };
    video.addEventListener('timeupdate', function () {
      if (!video.duration || !isFinite(video.duration)) return;
      if (playedSeconds() / video.duration < 0.9) return;
      if (!sent90) { sent90 = true; track('PreCallVideo90'); }
      if (!watched) {
        watched = true;
        try { sessionStorage.setItem(watchKey, '1'); } catch (e) {}
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

  // The new time from Cal.com, in the booking's own zone: "2026-11-21" and "10:30 AM", as the page keeps them
  function slotInZone(iso, tz) {
    var parts = {};
    new Intl.DateTimeFormat('en-US', { timeZone: tz || 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: true })
      .formatToParts(new Date(iso)).forEach(function (x) { parts[x.type] = x.value; });
    return { slotDate: parts.year + '-' + parts.month + '-' + parts.day, slotTime: parts.hour + ':' + parts.minute + ' ' + String(parts.dayPeriod || '').toUpperCase() };
  }

  function onRescheduled(data) {
    var start = data && (data.startTime || (data.booking && data.booking.startTime));
    var uid = data && (data.uid || (data.booking && data.booking.uid));
    if (!booking || !start) return;
    var slot = slotInZone(start, booking.timezone);
    booking.slotDate = slot.slotDate;
    booking.slotTime = slot.slotTime;
    if (uid) booking.rescheduleUrl = 'https://cal.com/reschedule/' + encodeURIComponent(uid);
    // No new uid: the old link points at the cancelled booking, so drop it (the new invite email has the right one)
    else if (data && data.fromPicker) booking.rescheduleUrl = null;
    try { sessionStorage.setItem('sv_booked', JSON.stringify(booking)); } catch (e) {}
    renderTop();
    wireButtonLinksOnly();
  }

  // ---------- Reschedule: our own time picker in a pop-up (the booking form's design), Cal.com moves the booking ----------
  var RS = { year: 0, month: 0, selected: null, time: null, cache: {}, busy: false, error: '', fallback: false, opener: null };
  var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var pad2 = function (n) { return (n < 10 ? '0' : '') + n; };
  var esc = function (v) { return String(v).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };

  function rsUid() {
    var m = String((booking && booking.rescheduleUrl) || '').match(/^https:\/\/cal\.com\/reschedule\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function rsWhen(slotDate, slotTime) {
    var dp = dateParts(slotDate);
    return dp.weekday.slice(0, 3) + ', ' + dp.day + ' ' + dp.month.slice(0, 3) + ' at ' + formatTime(slotTime) + ' ' + zoneLabel(booking.timezone);
  }

  function rsMonth(year, month) {
    var key = year + '-' + pad2(month + 1);
    if (RS.cache[key]) return Promise.resolve(RS.cache[key]);
    return fetch('/api/available-slots?month=' + key + '&timeZone=' + encodeURIComponent(booking.timezone || 'Asia/Kolkata'))
      .then(function (r) { if (!r.ok) throw new Error('slots'); return r.json(); })
      .then(function (d) {
        // The current time is not offered as a "new" time
        var data = { availableDates: [], slotsByDate: {} };
        (d.availableDates || []).forEach(function (day) {
          var times = (d.slotsByDate[day] || []).filter(function (tm) { return !(day === booking.slotDate && tm === booking.slotTime); });
          if (times.length) { data.availableDates.push(day); data.slotsByDate[day] = times; }
        });
        RS.cache[key] = data;
        return data;
      });
  }

  function rsRender() {
    var box = $('rs-picker');
    box.innerHTML = '<p class="cal-status">Finding open times…</p>';
    rsMonth(RS.year, RS.month).then(function (data) {
      var days = data.availableDates;
      if (!RS.selected || days.indexOf(RS.selected) < 0) RS.selected = days[0] || null;
      var times = RS.selected ? data.slotsByDate[RS.selected] : [];
      if (!RS.time || times.indexOf(RS.time) < 0) RS.time = times[0] || null;

      var first = new Date(RS.year, RS.month, 1).getDay();
      var count = new Date(RS.year, RS.month + 1, 0).getDate();
      var prevCount = new Date(RS.year, RS.month, 0).getDate();
      var cells = [];
      for (var i = first - 1; i >= 0; i--) cells.push('<div class="cal-day-cell other-month">' + (prevCount - i) + '</div>');
      for (var d = 1; d <= count; d++) {
        var key = RS.year + '-' + pad2(RS.month + 1) + '-' + pad2(d);
        if (days.indexOf(key) < 0) { cells.push('<div class="cal-day-cell disabled">' + d + '</div>'); continue; }
        var on = key === RS.selected;
        cells.push('<button type="button" class="cal-day-cell available' + (on ? ' selected' : '') + '" data-date="' + key + '" aria-pressed="' + on + '" aria-label="' + MONTH_NAMES[RS.month] + ' ' + d + '">' + d + '</button>');
      }
      for (var n = 1, rest = (cells.length > 35 ? 42 : 35) - cells.length; n <= rest; n++) cells.push('<div class="cal-day-cell other-month">' + n + '</div>');

      var slotBtn = function (tm) {
        var on = tm === RS.time;
        return '<button type="button" class="time-slot-btn' + (on ? ' selected' : '') + '" data-time="' + esc(tm) + '" aria-pressed="' + on + '">' + esc(tm) + '</button>';
      };
      var am = times.filter(function (tm) { return /\bam$/i.test(tm.trim()); });
      var pm = times.filter(function (tm) { return am.indexOf(tm) < 0; });
      var slots = times.length
        ? (am.length ? '<div class="time-section-label">Morning</div><div class="time-slots-grid">' + am.map(slotBtn).join('') + '</div>' : '') +
          (pm.length ? '<div class="time-section-label">Afternoon and evening</div><div class="time-slots-grid">' + pm.map(slotBtn).join('') + '</div>' : '')
        : '<p class="cal-status">No open times this month.</p>';

      var picked = RS.selected && RS.time ? rsWhen(RS.selected, RS.time) : '';
      box.innerHTML =
        (RS.error ? '<p class="cal-error" role="alert">' + esc(RS.error) +
          (RS.fallback ? ' <a class="rs-fallback" href="' + esc(booking.rescheduleUrl) + '">Reschedule on Cal.com instead</a>' : '') + '</p>' : '') +
        '<div class="month-calendar-wrapper"><div class="cal-layout-row"><div>' +
          '<div class="month-nav-header">' +
            '<button type="button" class="month-nav-btn" id="rs-prev" aria-label="Previous month"><svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M11 3L5 9l6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>' +
            '<div class="month-title">' + MONTH_NAMES[RS.month] + ' ' + RS.year + '</div>' +
            '<button type="button" class="month-nav-btn" id="rs-next" aria-label="Next month"><svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M7 3l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>' +
          '</div>' +
          '<div class="calendar-weekdays-grid"><div>SUN</div><div>MON</div><div>TUE</div><div>WED</div><div>THU</div><div>FRI</div><div>SAT</div></div>' +
          '<div class="calendar-days-grid">' + cells.join('') + '</div>' +
        '</div><div class="time-slots-container">' + slots + '</div></div>' +
        '<div class="slot-summary-box"><div class="selected-slot-badge">' + esc(picked) + '</div>' +
          '<button type="button" class="btn-primary" id="rs-confirm"' + (picked && !RS.busy ? '' : ' disabled') + '>' + (RS.busy ? 'Moving your call…' : 'Move my call to this time') + '</button></div></div>';

      $('rs-prev').addEventListener('click', function () { rsShift(-1); });
      $('rs-next').addEventListener('click', function () { rsShift(1); });
      Array.prototype.forEach.call(box.querySelectorAll('.cal-day-cell.available'), function (b) {
        b.addEventListener('click', function () { RS.selected = b.getAttribute('data-date'); RS.time = null; RS.error = ''; rsRender(); });
      });
      Array.prototype.forEach.call(box.querySelectorAll('.time-slot-btn'), function (b) {
        b.addEventListener('click', function () { RS.time = b.getAttribute('data-time'); RS.error = ''; rsRender(); });
      });
      $('rs-confirm').addEventListener('click', rsConfirm);
    }).catch(function () {
      box.innerHTML = '<div class="cal-status"><p>We couldn’t load open times. Please check your connection and try again.</p>' +
        '<button type="button" class="cal-retry" id="rs-retry">Try again</button><br>' +
        '<a class="rs-fallback" href="' + esc(booking.rescheduleUrl) + '">Or reschedule on Cal.com</a></div>';
      $('rs-retry').addEventListener('click', rsRender);
    });
  }

  function rsShift(delta) {
    RS.month += delta;
    if (RS.month < 0) { RS.month = 11; RS.year--; }
    if (RS.month > 11) { RS.month = 0; RS.year++; }
    RS.selected = null; RS.time = null; RS.error = '';
    rsRender();
  }

  function rsConfirm() {
    if (RS.busy || !RS.selected || !RS.time) return;
    RS.busy = true; RS.error = ''; RS.fallback = false; rsRender();
    $('rs-close').disabled = true;
    var from = rsWhen(booking.slotDate, booking.slotTime);
    fetch('/api/reschedule', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: rsUid(), slotDate: RS.selected, slotTime: RS.time, timezone: booking.timezone || 'Asia/Kolkata' })
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d || {} }; }); })
      .then(function (res) {
        RS.busy = false;
        $('rs-close').disabled = false;
        if (!res.ok || !res.d.ok) {
          // Cal.com's own page is the fallback whenever ours can't move the call (a taken time just needs another pick)
          RS.fallback = res.d.code !== 'taken';
          RS.error = res.d.code === 'taken' ? 'That time was just taken. Please pick another time.'
            : res.d.code === 'not-booked' ? 'This booking can no longer be moved here. Please use the link in your email.'
            : res.d.code === 'past' ? 'This call’s time has already passed, so it can’t be moved here.'
            : res.d.code === 'too-many' ? 'Too many tries. Please wait a few minutes, or use the link below.'
            : 'We couldn’t move your call. Please try again.';
          RS.cache = {}; // fresh times after a refusal
          rsRender();
          return;
        }
        track('Rescheduled');
        onRescheduled({ startTime: res.d.start, uid: res.d.uid, fromPicker: true });
        var to = rsWhen(booking.slotDate, booking.slotTime);
        $('rs-current').textContent = '';
        $('rs-tz').textContent = '';
        $('rs-title').hidden = true;
        $('rs-picker').innerHTML = '<div class="rs-done"><p class="rs-done-title">Your call is moved.</p>' +
          '<p>From <s>' + esc(from) + '</s><br>to <strong>' + esc(to) + '</strong>.<br>Cal.com is emailing you the new invite.</p>' +
          '<button type="button" class="btn-primary" id="rs-done-close">Done</button></div>';
        $('rs-done-close').addEventListener('click', rsClose);
      })
      .catch(function () { RS.busy = false; $('rs-close').disabled = false; RS.fallback = true; RS.error = 'We couldn’t move your call. Please check your connection and try again.'; rsRender(); });
  }

  function rsOpen(opener) {
    RS.opener = opener || null;
    $('rs-title').hidden = false;
    var p = booking.slotDate.split('-').map(Number);
    RS.year = p[0]; RS.month = p[1] - 1; RS.selected = null; RS.time = null; RS.error = ''; RS.fallback = false; RS.cache = {};
    $('rs-tz').textContent = isIndia(booking.timezone) ? 'Times are in India time (IST).' : 'Times are in your time zone (' + zoneLabel(booking.timezone).replace(/ time$/, '') + ').';
    $('rs-current').innerHTML = 'Currently booked for <strong>' + esc(rsWhen(booking.slotDate, booking.slotTime)) + '</strong>';
    var modal = $('rs-modal');
    modal.hidden = false;
    // next frame, so the fade-in runs
    requestAnimationFrame(function () { modal.classList.add('active'); });
    document.body.classList.add('modal-open');
    rsRender();
    setTimeout(function () { var c = $('rs-close'); if (c) c.focus(); }, 50);
  }

  function rsClose() {
    var modal = $('rs-modal');
    modal.classList.remove('active');
    document.body.classList.remove('modal-open');
    setTimeout(function () { modal.hidden = true; }, 250);
    if (RS.opener && RS.opener.focus) RS.opener.focus();
  }

  function wireReschedule() {
    var link = $('ty-resched-link');
    var modal = $('rs-modal');
    if (!link || !modal) return;
    link.addEventListener('click', function (e) {
      if (!booking || !rsUid()) return; // no booking id: the link opens Cal.com as before
      e.preventDefault();
      track('RescheduleOpen');
      rsOpen(link);
    });
    $('rs-close').addEventListener('click', function () { if (!RS.busy) rsClose(); }); // never while a move is running
    modal.addEventListener('click', function (e) { if (e.target === modal && !RS.busy) rsClose(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !modal.hidden && !RS.busy) rsClose(); });
  }

  // ---------- Go ----------
  renderTop();
  wireButtons();
  wireReschedule();
  applySettings(); // shows the hosted video at once; the settings below can only hide it or swap the file

  fetch('/api/config')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data) return;
      ['whatsappNumber', 'briefingVideoUrl', 'briefingVideoPoster', 'briefingVideoCaptions', 'demoWhatsappNumber', 'calBookingPage'].forEach(function (k) {
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
