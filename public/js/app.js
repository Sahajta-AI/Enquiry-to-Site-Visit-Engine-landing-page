/**
 * SAHAJTA AI — ENQUIRY-TO-SITE-VISIT ENGINE
 * Client-side booking form, Meta Pixel tracker and page behaviour
 */

document.addEventListener('DOMContentLoaded', () => {
  // State variables (this whole object is posted to /api/submit-lead: add keys only on purpose)
  // lead_event_id: this visit's id. It ties the booking to the details /api/lead keeps, so a booking stops any nudge.
  const wizardState = {
    currentStep: 1,
    q1_situation: '',
    q2_urgency: '',
    name: '',
    company: '',
    email: '',
    whatsapp_number: '',
    bookedSlot: '',
    lead_event_id: '',
    schedule_event_id: '',
    consent_at: '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  };

  // Opened from a nudge email's link: { code, firstName }. The browser never holds their email, number or answers.
  let resume = null;
  // "Didn't book" signal: armed when "See open times" is pressed, disarmed by a booking
  let leaveArmed = false;
  let leaveSent = false;
  let noTimesSent = false;
  let formShownAt = 0;       // when question 1 first showed: form_ms counts from here
  let formStartTracked = false;
  let calendarViewTracked = false;

  function newId() {
    try { if (crypto.randomUUID) return crypto.randomUUID(); } catch (err) {}
    try {
      const a = new Uint8Array(16);
      crypto.getRandomValues(a);
      a[6] = (a[6] & 0x0f) | 0x40; a[8] = (a[8] & 0x3f) | 0x80;
      const h = Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    } catch (err) {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); });
    }
  }

  function readCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }

  function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true
    }).catch(() => {});
  }

  function beaconJson(url, body) {
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(url, new Blob([JSON.stringify(body)], { type: 'application/json' }))) return;
    } catch (err) {}
    postJson(url, body);
  }

  // DOM Elements
  const modalBackdrop = document.getElementById('intake-modal');
  const modalCloseBtn = document.getElementById('modal-close-btn');
  const ctaButtons = document.querySelectorAll('.js-open-modal');

  // Wizard steps
  const wizardStep1 = document.getElementById('wizard-step-1');
  const wizardStep2 = document.getElementById('wizard-step-2');
  const wizardStep3 = document.getElementById('wizard-step-3');
  const wizardStep4 = document.getElementById('wizard-step-4');

  const stepPill = document.getElementById('wizard-step-pill');
  const progressFill = document.getElementById('wizard-progress-fill');
  const modalBody = modalBackdrop.querySelector('.modal-body');

  // Back buttons
  const btnStep2Back = document.getElementById('btn-step-2-back');
  const btnStep3Back = document.getElementById('btn-step-3-back');
  const btnStep4Back = document.getElementById('btn-step-4-back');
  const btnStep3Submit = document.getElementById('btn-step-3-submit');

  // Words for the form live in data attributes on the modal
  const msg = (key) => modalBackdrop.dataset[key] || '';

  // Events that must fire once, even after Back or closing and reopening the panel
  const firedOnce = {};

  // Tracking goes through /js/tracking.js: one Pixel, and a helper that does nothing when the Pixel isn't loaded
  const track = {
    standard: (name, params, eventId) => { if (window.SVTrack) window.SVTrack.standard(name, params, eventId); },
    // The new events (Backend and Tracking Brief, 5.4) go live only when NEW_TRACKING is on
    event: (name, params, custom) => { if (window.SVTrack) window.SVTrack.newEvent(name, params, custom); }
  };

  // 1. Modal toggle: reopening returns to the same screen
  let lastOpener = null;

  function openModal(opener) {
    lastOpener = opener || document.activeElement;
    modalBackdrop.classList.add('active');
    document.body.classList.add('modal-open');
    goToStep(wizardState.currentStep || 1);
    if (modalCloseBtn) modalCloseBtn.focus({ preventScroll: true });
  }

  function closeModal() {
    modalBackdrop.classList.remove('active');
    document.body.classList.remove('modal-open');
    if (lastOpener && typeof lastOpener.focus === 'function') {
      lastOpener.focus({ preventScroll: true });
    }
    updateStickyButton();
  }

  // Where the button is: hero, videos, final or sticky
  function buttonLocation(btn) {
    if (btn.closest('#sticky-cta')) return 'sticky';
    const sec = btn.closest('section');
    const map = { hero: 'hero', testimonials: 'videos', final: 'final' };
    return (sec && map[sec.id]) || 'page';
  }

  ctaButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      track.event('BookCallClick', { location: buttonLocation(btn) });
      openModal(btn.closest('#sticky-cta') ? null : btn);
    });
  });

  if (modalCloseBtn) {
    modalCloseBtn.addEventListener('click', closeModal);
  }

  modalBackdrop.addEventListener('click', (e) => {
    if (e.target === modalBackdrop) {
      closeModal();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalBackdrop.classList.contains('active')) {
      closeModal();
    }
  });

  // 2. Wizard navigation
  const progressByStep = { 1: '25%', 2: '50%', 3: '75%', 4: '100%' };

  function goToStep(stepNumber) {
    wizardState.currentStep = stepNumber;
    // The time step is wider on laptops: the calendar and the times side by side
    const box = document.querySelector('#intake-modal .modal-container');
    if (box) box.classList.toggle('is-time-step', stepNumber === 4);

    if (stepNumber === 1 && !formShownAt) formShownAt = Date.now();
    if (stepNumber === 1 && !formStartTracked) { formStartTracked = true; track.event('FormStart'); }

    [wizardStep1, wizardStep2, wizardStep3, wizardStep4].forEach(el => {
      if (el) el.classList.remove('active');
    });

    const stepEl = { 1: wizardStep1, 2: wizardStep2, 3: wizardStep3, 4: wizardStep4 }[stepNumber];
    if (stepEl) stepEl.classList.add('active');

    progressFill.style.width = progressByStep[stepNumber] || '25%';
    stepPill.textContent = (stepEl && stepEl.dataset.progressLabel) || '';
    if (modalBody) modalBody.scrollTop = 0;

    if (stepNumber === 3) {
      // Start loading open times now so they show at once on the next screen
      preloadMonthSlots();
    } else if (stepNumber === 4) {
      renderTimeZoneLine();
      loadCalComEmbed();
    }
  }

  // 3. Question 1 and 2: the whole box is tappable, the next screen shows after a short pause
  function bindOptionGroup(selector, field, nextStep) {
    const cards = document.querySelectorAll(selector);
    cards.forEach(card => {
      card.addEventListener('click', () => {
        cards.forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        wizardState[field] = card.dataset.value;
        track.event('FormStep', { step: nextStep - 1 });
        setTimeout(() => goToStep(nextStep), 250);
      });
    });
  }

  bindOptionGroup('.js-q1-option', 'q1_situation', 2);
  bindOptionGroup('.js-q2-option', 'q2_urgency', 3);

  if (btnStep2Back) btnStep2Back.addEventListener('click', () => goToStep(1));
  if (btnStep3Back) btnStep3Back.addEventListener('click', () => goToStep(2));
  if (btnStep4Back) btnStep4Back.addEventListener('click', () => goToStep(3));

  // 4. Contact details
  const contactForm = document.getElementById('intake-contact-form');
  const nameInput = document.getElementById('field-name');
  const companyInput = document.getElementById('field-company');
  const emailInput = document.getElementById('field-email');
  const phoneInput = document.getElementById('field-whatsapp');
  const phoneIntlInput = document.getElementById('field-whatsapp-intl');
  const phoneIndiaRow = document.getElementById('phone-india');
  const toggleIntl = document.getElementById('toggle-intl');
  const toggleIndia = document.getElementById('toggle-india');
  const errWhatsapp = document.getElementById('err-whatsapp');
  const errWhatsappDefault = errWhatsapp ? errWhatsapp.textContent : '';
  let phoneIsInternational = false;

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // Indian number: keep only digits; drop a leading 91 or 0 when more than 10 are left; keep the first 10
  function cleanIndianDigits(raw) {
    let digits = String(raw).replace(/\D/g, '');
    if (digits.length > 10 && (digits.startsWith('91') || digits.startsWith('0'))) {
      digits = digits.startsWith('91') ? digits.slice(2) : digits.slice(1);
    }
    return digits.slice(0, 10);
  }

  function cleanIntlNumber(raw) {
    const trimmed = String(raw).trim();
    const digits = trimmed.replace(/\D/g, '').slice(0, 15);
    return (trimmed.startsWith('+') ? '+' : '') + digits;
  }

  const validators = {
    name: () => nameInput.value.trim().length > 0,
    company: () => companyInput.value.trim().length > 0,
    email: () => emailRegex.test(emailInput.value.trim()),
    whatsapp: () => {
      if (phoneIsInternational) {
        const v = phoneIntlInput.value.trim();
        return /^\+\d{8,15}$/.test(v);
      }
      return /^[6-9]\d{9}$/.test(phoneInput.value);
    }
  };

  const fieldGroups = {
    name: nameInput.closest('.form-group'),
    company: companyInput.closest('.form-group'),
    email: emailInput.closest('.form-group'),
    whatsapp: document.getElementById('group-whatsapp')
  };

  const fieldInputs = {
    name: nameInput,
    company: companyInput,
    email: emailInput,
    whatsapp: () => (phoneIsInternational ? phoneIntlInput : phoneInput)
  };

  function validateField(key) {
    const ok = validators[key]();
    fieldGroups[key].classList.toggle('has-error', !ok);
    return ok;
  }

  function focusField(key) {
    const el = typeof fieldInputs[key] === 'function' ? fieldInputs[key]() : fieldInputs[key];
    if (el) el.focus();
  }

  function setPhoneMode(international) {
    phoneIsInternational = international;
    phoneIndiaRow.hidden = international;
    phoneIntlInput.hidden = !international;
    toggleIntl.hidden = international;
    toggleIndia.hidden = !international;
    errWhatsapp.textContent = international ? msg('errPhoneIntl') : errWhatsappDefault;
    fieldGroups.whatsapp.classList.remove('has-error');
    focusField('whatsapp');
  }

  toggleIntl.addEventListener('click', () => setPhoneMode(true));
  toggleIndia.addEventListener('click', () => setPhoneMode(false));

  phoneInput.addEventListener('input', () => {
    phoneInput.value = cleanIndianDigits(phoneInput.value);
  });

  phoneIntlInput.addEventListener('input', () => {
    phoneIntlInput.value = cleanIntlNumber(phoneIntlInput.value);
  });

  // Show errors when a field loses focus, never while someone is still typing
  [['name', nameInput], ['company', companyInput], ['email', emailInput], ['whatsapp', phoneInput], ['whatsapp', phoneIntlInput]]
    .forEach(([key, el]) => {
      el.addEventListener('blur', () => {
        // A field that was never touched is not an error yet
        if (el.value.trim() === '' && !fieldGroups[key].classList.contains('has-error') && !el.dataset.touched) return;
        validateField(key);
      });
      el.addEventListener('input', () => {
        el.dataset.touched = '1';
        if (fieldGroups[key].classList.contains('has-error')) validateField(key);
      });
    });

  // Enter moves to the next field; on the last field it presses the button
  [[nameInput, companyInput], [companyInput, emailInput], [emailInput, null]].forEach(([from, to]) => {
    from.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (to) to.focus();
      else focusField('whatsapp');
    });
  });

  [phoneInput, phoneIntlInput].forEach(el => {
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      submitContactForm();
    });
  });

  // Trap and bot timer (7.2): a filled trap field, or a form sent in under 3 seconds since question 1, counts as a bot.
  // A bot sends no Lead or Schedule from the browser.
  const trapInput = document.getElementById('field-hp-note');
  const formMs = () => (formShownAt ? Date.now() - formShownAt : 0);
  const looksLikeBot = () => !!(trapInput && trapInput.value) || formMs() < 3000;

  function onLeadAccepted(data) {
    if (firedOnce.Lead || looksLikeBot() || !window.SVTrack) return;
    const id = wizardState.lead_event_id;
    window.SVTrack.config().then(cfg => {
      // On production, a test booking never reaches the live Pixel from the browser
      if (data.test && cfg.pixelKind === 'live') return;
      if (firedOnce.Lead) return;
      firedOnce.Lead = true;
      track.standard('Lead', { content_name: 'Lead Conversion Clarity Call form' }, id);
    });
  }

  // POST /api/lead with the details. Nothing waits for it. The browser's Lead fires only after an ok reply,
  // and on no reply or an error it tries again in the background (up to twice), with the same ID.
  async function sendLeadRecord(attempt) {
    if (!window.SVTrack) return;
    const body = {
      lead_event_id: wizardState.lead_event_id,
      name: wizardState.name,
      company: wizardState.company,
      email: wizardState.email,
      whatsapp_number: wizardState.whatsapp_number,
      q1_situation: wizardState.q1_situation,
      q2_urgency: wizardState.q2_urgency,
      timezone: wizardState.timezone,
      page_url: window.location.href.split('#')[0],
      sv_attrib: window.SVTrack.attribution(),
      fbp: readCookie('_fbp'),
      fbc: readCookie('_fbc'),
      hp_note: trapInput ? trapInput.value : '',
      form_ms: formMs()
    };
    try {
      const res = await fetch('/api/lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data && data.ok) { onLeadAccepted(data); return; }
      if (res.status === 400) return; // the server refused the details themselves: retrying won't help
    } catch (err) { /* no reply: try again below */ }
    if (attempt < 2) setTimeout(() => sendLeadRecord(attempt + 1), 3000 + attempt * 2000);
  }

  function submitContactForm() {
    const order = ['name', 'company', 'email', 'whatsapp'];
    let firstInvalid = null;
    order.forEach(key => {
      if (!validateField(key) && !firstInvalid) firstInvalid = key;
    });
    if (firstInvalid) {
      focusField(firstInvalid);
      return;
    }

    wizardState.name = nameInput.value.trim();
    wizardState.company = companyInput.value.trim();
    wizardState.email = emailInput.value.trim();
    wizardState.whatsapp_number = phoneIsInternational ? phoneIntlInput.value.trim() : phoneInput.value;

    // Keep this visit's checked details on the server for 24 hours, and send Lead from there too (shared event ID)
    // One Lead event ID per visit, kept through a reload (sessionStorage), as the Backend Brief 5.3 asks
    if (!wizardState.lead_event_id) {
      let kept = '';
      try { kept = sessionStorage.getItem('sv_lead_event_id') || ''; } catch (err) {}
      wizardState.lead_event_id = /^[0-9a-f-]{36}$/i.test(kept) ? kept : newId();
      try { sessionStorage.setItem('sv_lead_event_id', wizardState.lead_event_id); } catch (err) {}
    }
    wizardState.consent_at = new Date().toISOString(); // when they pressed "See open times" (consent is covered in the privacy policy, Shubhang 11 Nov)
    sendLeadRecord(0);

    leaveArmed = true;
    goToStep(4);
  }

  // Left the page at the time step without booking: tell the server once (a short switch to another app counts)
  function sendLeaveSignal() {
    if (!leaveArmed || leaveSent || resume || !wizardState.lead_event_id) return;
    const today = new Date().toISOString().slice(0, 10);
    try { if (localStorage.getItem('sv_dnb') === today) return; } catch (err) {}
    leaveSent = true;
    try { localStorage.setItem('sv_dnb', today); } catch (err) {}
    beaconJson('/api/lead-signal', { kind: 'didnt_book', lead_event_id: wizardState.lead_event_id });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') sendLeaveSignal();
  });
  window.addEventListener('pagehide', sendLeaveSignal);

  // No times in the whole 7 days: tell the server once. Shubhang WhatsApps these himself, so no nudges follow.
  function sendNoTimesSignal() {
    if (noTimesSent) return;
    if (!resume && !wizardState.lead_event_id) return;
    noTimesSent = true;
    leaveArmed = false;
    postJson('/api/lead-signal', resume
      ? { kind: 'no_times', resume_code: resume.code }
      : { kind: 'no_times', lead_event_id: wizardState.lead_event_id });
  }

  if (contactForm) {
    contactForm.addEventListener('submit', (e) => {
      e.preventDefault();
      submitContactForm();
    });
  }

  // 5. Open times
  let isSubmittingLead = false;

  const monthSlotsCache = {};

  async function preloadMonthSlots(year, month) {
    const today = new Date();
    const targetYear = year || today.getFullYear();
    const targetMonth = month !== undefined ? month : today.getMonth();
    const monthStr = `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}`;
    const tz = wizardState.timezone || 'Asia/Kolkata';
    const cacheKey = `${monthStr}_${tz}`;
    if (monthSlotsCache[cacheKey]) return monthSlotsCache[cacheKey];

    try {
      const monthRes = await fetch(`/api/available-slots?month=${monthStr}&timeZone=${encodeURIComponent(tz)}`);
      if (monthRes.ok) {
        const monthData = await monthRes.json();
        if (monthData && monthData.availableDates) {
          monthSlotsCache[cacheKey] = monthData;
          return monthData;
        }
      }
    } catch (err) {}
    return null;
  }

  function renderTimeZoneLine() {
    const line = document.getElementById('tz-line');
    if (!line) return;
    const tz = wizardState.timezone || '';
    if (tz === 'Asia/Kolkata' || tz === 'Asia/Calcutta') {
      line.textContent = msg('tzIndia');
    } else {
      const city = tz.split('/').pop().replace(/_/g, ' ') || tz;
      line.textContent = msg('tzOther').replace('{zone}', city);
    }
  }

  // Time picker state lives outside the render so a failed booking can reload the times
  const picker = {
    year: new Date().getFullYear(),
    month: new Date().getMonth(),
    selectedDate: null,
    selectedTimeStr: null,
    bookingError: false,
    loadError: false
  };

  let pickerRender = null;

  function loadCalComEmbed() {
    const container = document.getElementById('cal-embed-container');
    if (!container) return;

    isSubmittingLead = false;
    picker.monthChecked = false;
    picker.noTimesWeek = false;
    const today = new Date();
    pickerRender = fetchAndRenderCalendar;

    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];

    const pad = (n) => String(n).padStart(2, '0');
    const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

    async function fetchAndRenderCalendar(focusKey) {
      const monthStr = `${picker.year}-${pad(picker.month + 1)}`;
      const tz = wizardState.timezone || 'Asia/Kolkata';
      const cacheKey = `${monthStr}_${tz}`;
      let monthData = monthSlotsCache[cacheKey];

      if (!monthData) {
        container.innerHTML = `<p class="cal-status">${msg('msgFinding')}</p>`;
        monthData = await preloadMonthSlots(picker.year, picker.month);
        if (!monthData) {
          picker.loadError = true;
        } else {
          picker.loadError = false;
        }
      }

      if (picker.loadError && !monthData) {
        container.innerHTML = `
          <div class="cal-status">
            <p>${msg('msgLoadError')}</p>
            <button type="button" class="cal-retry" id="cal-retry">${msg('msgRetry')}</button>
          </div>`;
        container.querySelector('#cal-retry').addEventListener('click', () => {
          picker.loadError = false;
          fetchAndRenderCalendar();
        });
        return;
      }

      // First time on this screen: if the current month has no open times, open the next month if it has some.
      // If both months are empty, no times show in the whole 7 days: say so, and tell the server (once).
      if (!picker.monthChecked) {
        picker.monthChecked = true;
        if (monthData && !(monthData.availableDates || []).length) {
          const nextYear = picker.month === 11 ? picker.year + 1 : picker.year;
          const nextMonth = (picker.month + 1) % 12;
          const nextData = await preloadMonthSlots(nextYear, nextMonth);
          if (nextData && (nextData.availableDates || []).length) {
            picker.year = nextYear;
            picker.month = nextMonth;
            monthData = nextData;
          } else if (nextData) {
            picker.noTimesWeek = true;
            sendNoTimesSignal();
          }
        }
      }

      const availableDates = monthData?.availableDates || [];
      const slotsByDate = monthData?.slotsByDate || {};

      if (availableDates.length > 0 && !calendarViewTracked) {
        calendarViewTracked = true;
        track.event('CalendarView');
      }

      // Select the first day with open times, so the times show without an extra tap
      if (availableDates.length > 0) {
        const currentSelectedStr = picker.selectedDate ? dateKey(picker.selectedDate) : '';
        if (!picker.selectedDate || !availableDates.includes(currentSelectedStr)) {
          const parts = availableDates[0].split('-');
          picker.selectedDate = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
          picker.selectedTimeStr = null;
        }
      } else {
        picker.selectedDate = null;
      }

      const firstDayOfMonth = new Date(picker.year, picker.month, 1);
      const startingDayOfWeek = firstDayOfMonth.getDay();
      const daysInMonth = new Date(picker.year, picker.month + 1, 0).getDate();
      const daysInPrevMonth = new Date(picker.year, picker.month, 0).getDate();

      const dayCells = [];
      for (let i = startingDayOfWeek - 1; i >= 0; i--) {
        dayCells.push({ dayNum: daysInPrevMonth - i, isCurrentMonth: false });
      }

      const todayZero = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      for (let d = 1; d <= daysInMonth; d++) {
        const cellDate = new Date(picker.year, picker.month, d);
        const cellDateStr = `${picker.year}-${pad(picker.month + 1)}-${pad(d)}`;
        const isPast = cellDate < todayZero;
        const isSunday = cellDate.getDay() === 0; // Sundays stay off
        const hasSlots = availableDates.includes(cellDateStr);

        dayCells.push({
          dayNum: d,
          cellDateStr,
          isCurrentMonth: true,
          isDisabled: isPast || isSunday || !hasSlots,
          isSelected: !!picker.selectedDate && dateKey(picker.selectedDate) === cellDateStr
        });
      }

      const totalCells = dayCells.length > 35 ? 42 : 35;
      for (let i = 1, remaining = totalCells - dayCells.length; i <= remaining; i++) {
        dayCells.push({ dayNum: i, isCurrentMonth: false });
      }

      const daysGridHtml = dayCells.map(cell => {
        if (!cell.isCurrentMonth) return `<div class="cal-day-cell other-month">${cell.dayNum}</div>`;
        if (cell.isDisabled) return `<div class="cal-day-cell disabled">${cell.dayNum}</div>`;
        return `<button type="button" class="cal-day-cell available ${cell.isSelected ? 'selected' : ''}" data-day="${cell.dayNum}" data-date="${cell.cellDateStr}" aria-pressed="${cell.isSelected ? 'true' : 'false'}" aria-label="${monthNames[picker.month]} ${cell.dayNum}">${cell.dayNum}</button>`;
      }).join('');

      let availableSlots = [];
      const selectedKey = picker.selectedDate ? dateKey(picker.selectedDate) : null;
      if (selectedKey && slotsByDate[selectedKey]) availableSlots = slotsByDate[selectedKey];

      if (availableSlots.length > 0) {
        if (!picker.selectedTimeStr || !availableSlots.includes(picker.selectedTimeStr)) {
          picker.selectedTimeStr = availableSlots[0];
        }
      } else {
        picker.selectedTimeStr = null;
      }

      // Grouped by AM/PM only ("10:00 PM" is not morning)
      const morningSlots = availableSlots.filter(s => /\bam$/i.test(String(s).trim()));
      const afternoonSlots = availableSlots.filter(s => !morningSlots.includes(s));

      const renderSlotBtn = (timeStr) => `
        <button type="button" class="time-slot-btn js-time-slot ${timeStr === picker.selectedTimeStr ? 'selected' : ''}" data-time="${timeStr}" aria-pressed="${timeStr === picker.selectedTimeStr ? 'true' : 'false'}">${timeStr}</button>
      `;

      let slotsHtml = '';
      if (availableSlots.length > 0) {
        if (morningSlots.length > 0) {
          slotsHtml += `
            <div class="time-section-label">${msg('labelMorning')}</div>
            <div class="time-slots-grid">${morningSlots.map(renderSlotBtn).join('')}</div>`;
        }
        if (afternoonSlots.length > 0) {
          slotsHtml += `
            <div class="time-section-label">${msg('labelAfternoon')}</div>
            <div class="time-slots-grid">${afternoonSlots.map(renderSlotBtn).join('')}</div>`;
        }
      } else {
        // Both months empty: the 7-day line. Only one empty month (the other has times): "No open times this month."
        slotsHtml = `<p class="cal-status">${msg(picker.noTimesWeek ? 'msgNoneWeek' : 'msgNone')}</p>`;
      }


      const activeFullSlot = (picker.selectedDate && picker.selectedTimeStr)
        ? niceSlot(picker.selectedDate, picker.selectedTimeStr)
        : '';

      const isConfirmDisabled = !picker.selectedDate || !picker.selectedTimeStr;

      container.innerHTML = `
        ${picker.bookingError ? `<p class="cal-error" role="alert">${msg('msgBookingError')}</p>` : ''}
        <div class="month-calendar-wrapper">
          <div class="cal-layout-row">
            <div>
              <div class="month-nav-header">
                <button type="button" class="month-nav-btn" id="cal-prev-month" aria-label="Previous month">
                  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M11 3L5 9l6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
                <div class="month-title">${monthNames[picker.month]} ${picker.year}</div>
                <button type="button" class="month-nav-btn" id="cal-next-month" aria-label="Next month">
                  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M7 3l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button>
              </div>
              <div class="calendar-weekdays-grid">
                <div>SUN</div><div>MON</div><div>TUE</div><div>WED</div><div>THU</div><div>FRI</div><div>SAT</div>
              </div>
              <div class="calendar-days-grid">${daysGridHtml}</div>
            </div>
            <div class="time-slots-container">${slotsHtml}</div>
          </div>

          <div class="slot-summary-box">
            <div class="selected-slot-badge">${activeFullSlot}</div>
            <button type="button" class="btn-primary" id="btn-confirm-final-slot" ${isConfirmDisabled ? 'disabled' : ''}>${msg('msgBook')}</button>
          </div>
        </div>
      `;

      const shiftMonth = (delta) => {
        picker.month += delta;
        if (picker.month < 0) { picker.month = 11; picker.year--; }
        if (picker.month > 11) { picker.month = 0; picker.year++; }
        picker.selectedDate = null;
        picker.selectedTimeStr = null;
        picker.bookingError = false;
        fetchAndRenderCalendar('#cal-' + (delta < 0 ? 'prev' : 'next') + '-month');
      };

      container.querySelector('#cal-prev-month').addEventListener('click', () => shiftMonth(-1));
      container.querySelector('#cal-next-month').addEventListener('click', () => shiftMonth(1));

      container.querySelectorAll('.cal-day-cell.available').forEach(cell => {
        cell.addEventListener('click', () => {
          const dayNum = parseInt(cell.dataset.day, 10);
          picker.selectedDate = new Date(picker.year, picker.month, dayNum);
          picker.selectedTimeStr = null;
          picker.bookingError = false;
          fetchAndRenderCalendar(`.cal-day-cell[data-day="${dayNum}"]`);
        });
      });

      container.querySelectorAll('.js-time-slot').forEach(btn => {
        btn.addEventListener('click', () => {
          picker.selectedTimeStr = btn.dataset.time;
          picker.bookingError = false;
          fetchAndRenderCalendar(`.js-time-slot[data-time="${btn.dataset.time}"]`);
        });
      });

      const btnConfirmFinal = container.querySelector('#btn-confirm-final-slot');
      if (btnConfirmFinal && !isConfirmDisabled) {
        btnConfirmFinal.addEventListener('click', () => {
          if (isSubmittingLead) return;
          isSubmittingLead = true;
          btnConfirmFinal.disabled = true;
          btnConfirmFinal.textContent = msg('msgBooking');
          const sel = picker.selectedDate;
          wizardState.slotDate = `${sel.getFullYear()}-${pad(sel.getMonth() + 1)}-${pad(sel.getDate())}`;
          wizardState.slotTime = picker.selectedTimeStr;
          const finalSlotStr = niceSlot(sel, picker.selectedTimeStr);
          handleSlotConfirmation(finalSlotStr);
        });
      }

      if (typeof focusKey === 'string' && focusKey) {
        const toFocus = container.querySelector(focusKey);
        if (toFocus) toFocus.focus({ preventScroll: true });
      }
    }

    fetchAndRenderCalendar();
  }

  // "Thu, 12 Nov at 12:35 pm IST" ("{city} time" outside India), never "(Asia/Calcutta)"
  function niceSlot(date, timeStr) {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const tz = wizardState.timezone || 'Asia/Kolkata';
    const zone = (tz === 'Asia/Kolkata' || tz === 'Asia/Calcutta') ? 'IST' : tz.split('/').pop().replace(/_/g, ' ') + ' time';
    const time = String(timeStr || '').replace(/^0(\d)/, '$1').replace(/\s*([AP])M$/i, (m, x) => ' ' + x.toLowerCase() + 'm');
    return `${days[date.getDay()]}, ${date.getDate()} ${months[date.getMonth()]} at ${time} ${zone}`;
  }

  // The booking failed: stay on the time screen, show the message, reload the times, let the visitor pick again
  function showBookingFailure() {
    isSubmittingLead = false;
    picker.bookingError = true;
    Object.keys(monthSlotsCache).forEach(k => delete monthSlotsCache[k]);
    if (typeof pickerRender === 'function') pickerRender();
  }

  function handleSlotConfirmation(slotText) {
    wizardState.bookedSlot = slotText;
    // The Schedule event ID is made before the booking call. A retry reuses it, so Meta counts it once.
    if (!wizardState.schedule_event_id) wizardState.schedule_event_id = newId();
    const common = {
      schedule_event_id: wizardState.schedule_event_id,
      page_url: window.location.href.split('#')[0],
      sv_attrib: window.SVTrack ? window.SVTrack.attribution() : {},
      fbp: readCookie('_fbp'),
      fbc: readCookie('_fbc')
    };
    if (resume) {
      // From a nudge's link: only the code and this visit's own time and ad cookies. The server has the rest.
      submitLeadToBackend(Object.assign({
        resume_code: resume.code,
        slotDate: wizardState.slotDate,
        slotTime: wizardState.slotTime,
        bookedSlot: slotText,
        timezone: wizardState.timezone
      }, common));
      return;
    }
    submitLeadToBackend(Object.assign({}, wizardState, common, {
      hp_note: trapInput ? trapInput.value : '',
      form_ms: formMs()
    }));
  }

  async function submitLeadToBackend(payload) {
    let result = null;
    let succeeded = false;

    try {
      const response = await fetch('/api/submit-lead', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      result = await response.json();
      succeeded = response.ok && !!result && result.success === true;
    } catch (err) {
      console.error('Error submitting lead:', err);
    }

    // Open the thank-you page only when the booking went through. Anything else stays on the time screen.
    if (!succeeded) {
      showBookingFailure();
      return;
    }

    // Schedule fires once, here, after a booking succeeds, with the same ID the server uses. The /thank-you page never fires it.
    // A bot sends nothing, and on production a test booking never reaches the live Pixel from the browser.
    const scheduleId = payload.schedule_event_id;
    if (window.SVTrack) window.SVTrack.config().then(cfg => {
      const isBot = !resume && ((payload.hp_note) || !(Number(payload.form_ms) >= 3000));
      if (isBot || (result && result.test && cfg.pixelKind === 'live')) return;
      track.standard('Schedule', { content_name: 'Lead Conversion Clarity Call' }, scheduleId);
    });

    // The booking details stay in this browser's session memory, never in the page address
    leaveArmed = false; // they booked: never a "Didn't book" email
    const booked = {
      // From a nudge's link the first name comes from /api/resume's reply
      firstName: resume ? resume.firstName : ((payload.name || '').trim().split(/\s+/)[0] || ''),
      slotDate: payload.slotDate,
      slotTime: payload.slotTime,
      timezone: payload.timezone,
      rescheduleUrl: (result && result.rescheduleUrl) || ''
    };
    try { sessionStorage.setItem('sv_booked', JSON.stringify(booked)); } catch (err) {}

    // Reset the form so Back from /thank-you never shows the time step again
    endResume();
    resetBookingForm();

    // Short pause so the Schedule event leaves the browser before the page changes
    setTimeout(() => { window.location.assign('/thank-you'); }, 300);
  }

  function resetBookingForm() {
    wizardState.currentStep = 1;
    ['q1_situation', 'q2_urgency', 'name', 'company', 'email', 'whatsapp_number', 'bookedSlot', 'slotDate', 'slotTime', 'lead_event_id', 'schedule_event_id', 'consent_at'].forEach(k => {
      wizardState[k] = '';
    });
    try { sessionStorage.removeItem('sv_lead_event_id'); } catch (err) {} // after a booking, a new booking is a new visit
    leaveArmed = false;
    leaveSent = false;
    noTimesSent = false;
    formShownAt = 0;
    formStartTracked = false;
    calendarViewTracked = false;
    delete firedOnce.Lead;
    [nameInput, companyInput, emailInput, phoneInput, phoneIntlInput].forEach(el => {
      el.value = '';
      delete el.dataset.touched;
    });
    Object.values(fieldGroups).forEach(g => g.classList.remove('has-error'));
    if (phoneIsInternational) {
      phoneIsInternational = false;
      phoneIndiaRow.hidden = false;
      phoneIntlInput.hidden = true;
      toggleIntl.hidden = false;
      toggleIndia.hidden = true;
      errWhatsapp.textContent = errWhatsappDefault;
    }
    document.querySelectorAll('.js-q1-option, .js-q2-option').forEach(c => c.classList.remove('selected'));
    picker.selectedDate = null;
    picker.selectedTimeStr = null;
    picker.bookingError = false;
    picker.loadError = false;
    Object.keys(monthSlotsCache).forEach(k => delete monthSlotsCache[k]);
    isSubmittingLead = false;
    goToStep(1);
    modalBackdrop.classList.remove('active');
    document.body.classList.remove('modal-open');
  }

  // Back from /thank-you can restore this page from the browser's cache: make sure the form is at the start
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
      let booked = false;
      try { booked = !!sessionStorage.getItem('sv_booked'); } catch (err) {}
      if (booked) { endResume(); resetBookingForm(); }
    }
  });

  // ---- Opened from a nudge email's link (/?r={code}; the head script already took the code out of the address) ----
  const welcomeLine = document.getElementById('welcome-line');
  const startAgainRow = document.getElementById('start-again-row');
  const btnStartAgain = document.getElementById('btn-start-again');

  function showResumeParts(on) {
    if (welcomeLine) {
      welcomeLine.hidden = !on;
      welcomeLine.textContent = on
        ? (resume && resume.firstName ? msg('msgWelcome').replace('{name}', resume.firstName) : 'Welcome back.')
        : '';
    }
    if (startAgainRow) startAgainRow.hidden = !on;
    if (btnStep4Back) btnStep4Back.hidden = on; // no Back button: "Not you? Start again" is the only way back
  }

  function endResume() {
    resume = null;
    try { sessionStorage.removeItem('sv_resume'); } catch (err) {}
    showResumeParts(false);
  }

  async function tryResume() {
    let code = '';
    try { code = sessionStorage.getItem('sv_resume') || ''; } catch (err) {}
    if (!code) return;
    let data = null;
    try {
      const res = await fetch('/api/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      });
      data = await res.json();
    } catch (err) {
      return; // no connection: leave the normal page, keep the code for a reload
    }
    if (!data || !data.ok) {
      try { sessionStorage.removeItem('sv_resume'); } catch (err) {} // anything else: the normal page, with no error
      return;
    }
    resume = { code, firstName: String(data.firstName || '') };
    showResumeParts(true);
    wizardState.currentStep = 4;
    openModal(null);
  }

  if (btnStartAgain) {
    btnStartAgain.addEventListener('click', () => {
      // Drops the code (it stays unused) and opens the form from the first question, as a new visit
      endResume();
      delete firedOnce.Lead;
      delete firedOnce.InitiateCheckout;
      resetBookingForm();
      modalBackdrop.classList.add('active');
      document.body.classList.add('modal-open');
      goToStep(1);
    });
  }

  tryResume();

  // Video Testimonial Interactive Controller (Auto-Pause Others & Full Native Controls)
  const allVideos = document.querySelectorAll('.video-wrapper video');
  allVideos.forEach(video => {
    const wrapper = video.closest('.video-wrapper');
    const overlayBtn = wrapper ? wrapper.querySelector('.video-play-overlay') : null;

    if (overlayBtn) {
      overlayBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        video.controls = true;
        if (wrapper) wrapper.classList.add('has-controls');
        if (video.paused) {
          video.play().catch(() => {});
        } else {
          video.pause();
        }
      });
    }

    video.addEventListener('play', () => {
      if (!video.dataset.tracked) {
        video.dataset.tracked = '1';
        // The client's first name, from the poster file name (for example /videos/rahul-jain.webp -> Rahul)
        let who = '';
        try { who = new URL(video.poster, window.location.href).pathname.split('/').pop().split('.')[0].split('-')[0]; } catch (err) {}
        who = who.charAt(0).toUpperCase() + who.slice(1);
        if (who) track.event('TestimonialPlay', { name: who });
      }
      // Pause any other video testimonials on the page
      allVideos.forEach(otherVideo => {
        if (otherVideo !== video && !otherVideo.paused) {
          otherVideo.pause();
        }
      });
      if (wrapper) wrapper.classList.add('is-playing');
    });

    video.addEventListener('pause', () => {
      if (wrapper) wrapper.classList.remove('is-playing');
    });

    video.addEventListener('ended', () => {
      if (wrapper) wrapper.classList.remove('is-playing');
    });
  });

  // ---------- Sales video (Build Brief 5.2, Notion card 11 Nov) ----------
  // 1. Starts on its own, muted, captions on. 2. A big gold "Click for sound" button over it.
  // 3. On tap: restarts from 0:00 with sound, captions stay on. 4. If the phone blocks autoplay
  // (low-power mode, data saver): the poster with the same button, which plays it with sound.
  // Tracking: ViewContent when it starts with sound (a muted autoplay is not a view), then
  // VideoProgress at 25, 50, 75 and 95 percent of that watch (each once).
  const salesVideo = document.getElementById('sales-video');
  const salesBtn = document.getElementById('sales-sound-btn');
  const salesPanel = document.getElementById('sales-panel');
  if (salesVideo && salesBtn && salesPanel) {
    let withSound = false;
    let cfgUrl = '';
    const reached = {};

    // Captions on from the start, drawn by us at the very bottom of the picture (the browser's own captions
    // move up over the video whenever its control bar shows; Shubhang 15 Nov)
    // We read the .vtt file ourselves instead of using a <track>: the streaming player (hls.js) wipes a track's
    // captions, so this works the same for an MP4 or a Mux stream, in every browser.
    const capBox = document.getElementById('sales-cap');
    let capCues = [];
    const vttTime = (t) => t.split(':').reduce((sum, part) => sum * 60 + parseFloat(part), 0);
    const loadCaptions = (url) => {
      fetch(url).then(r => (r.ok ? r.text() : '')).then(vtt => {
        capCues = vtt.replace(/\r/g, '').split(/\n\n+/).map(block => {
          const lines = block.split('\n');
          const at = lines.findIndex(l => l.includes('-->'));
          if (at < 0) return null;
          const [from, to] = lines[at].split('-->').map(x => vttTime(x.trim().split(/\s+/)[0]));
          const parts = lines.slice(at + 1).map(l => l.trim()).filter(Boolean);
          // One line at a time (Shubhang, 18 Nov): a 2-line caption is shown as 2 one-line captions,
          // its time shared by the length of each line
          const total = parts.reduce((n, l) => n + l.length, 0) || 1;
          let start = from;
          return parts.map((text, i) => {
            const end = i === parts.length - 1 ? to : start + (to - from) * text.length / total;
            const cue = { from: start, to: end, text };
            start = end;
            return cue;
          });
        }).filter(Boolean).flat();
        showCaptions();
      }).catch(() => {});
    };
    let capShown = '';
    const showCaptions = () => {
      if (!capBox) return;
      const t = salesVideo.currentTime;
      let text = '';
      // Only the newest caption: two overlapping ones stacked up cover his face
      for (let i = capCues.length - 1; i >= 0; i--) {
        if (t >= capCues[i].from && t < capCues[i].to) { text = capCues[i].text; break; }
      }
      if (text === capShown) return;
      capShown = text;
      capBox.textContent = text;
      capBox.classList.toggle('is-on', !!text);
    };
    salesVideo.addEventListener('timeupdate', showCaptions);
    salesVideo.addEventListener('seeked', showCaptions);

    // The video's address: an MP4, or a streaming address ending in .m3u8 (Mux). A stream picks the quality
    // that fits the viewer's internet, so it doesn't stall on a slow phone. iPhones and Safari play it on their own;
    // other browsers get the hls.js player (the full build: Mux sends the sound as a separate track, which the light build can't play), loaded only then. Our own player, captions and tracking stay.
    let sourceReady = null; // a promise, once the address is attached
    let attached = false;   // true once it is attached (so a tap can play at once)
    const isStream = (u) => /\.m3u8(\?|$)/i.test(u);
    const attachSource = (u) => {
      // Built-in streaming only on Safari and iPhones (they do it well). Desktop Chrome says "maybe" but doesn't play it.
      const safari = /^((?!chrome|chromium|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent);
      const native = salesVideo.canPlayType('application/vnd.apple.mpegurl') && (safari || !window.MediaSource);
      if (!isStream(u) || native) {
        salesVideo.src = u;
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        const go = () => {
          const Hls = window.Hls;
          if (!Hls || !Hls.isSupported()) { salesVideo.src = u; resolve(); return; } // last resort: try it directly
          const hls = new Hls({ capLevelToPlayerSize: true });
          hls.loadSource(u);
          hls.attachMedia(salesVideo);
          resolve();
        };
        if (window.Hls) { go(); return; }
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.6.13/dist/hls.min.js';
        s.async = true;
        s.onload = go;
        s.onerror = go;
        document.head.appendChild(s);
      });
    };
    const ensureSource = () => sourceReady || (sourceReady = attachSource(cfgUrl).then(() => { attached = true; }));

    // Phones and tablets (touch, no mouse) get our own control bar
    const touch = window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches;
    const salesBar = document.getElementById('sales-bar');

    let wantSound = false;
    const startWithSound = () => {
      if (!cfgUrl) { wantSound = true; return; } // the address is still on its way: start the moment it arrives
      withSound = true;
      salesBtn.hidden = true;
      salesPanel.classList.add('has-sound');
      salesVideo.muted = false;
      // Laptops: the browser's own control bar. Phones: ours (each phone's own bar is different; an iPhone's has no pause)
      if (touch && salesBar) salesBar.hidden = false; else salesVideo.controls = true;
      showCaptions();
      track.event('ViewContent', { content_name: 'Sales video' }, false);
      const playFromStart = () => { salesVideo.currentTime = 0; salesVideo.play().catch(() => {}); };
      // Already attached: play now, inside the tap (iPhones need that). Otherwise as soon as it is attached.
      if (attached) playFromStart();
      else ensureSource().then(playFromStart);
    };

    salesBtn.addEventListener('click', startWithSound);

    // Phones: the video's own controls take every tap on the picture, so a tap never paused it.
    // An invisible layer over the picture (the bottom strip stays free for the control bar) takes the tap instead:
    // before the sound is on it starts it with sound, after that it pauses and plays.
    const tapLayer = document.getElementById('sales-tap');
    if (tapLayer) {
      tapLayer.addEventListener('click', () => {
        if (!withSound) { startWithSound(); return; }
        if (salesVideo.paused) salesVideo.play().catch(() => {}); else salesVideo.pause();
      });
    }

    // Our phone control bar
    if (salesBar) {
      const playBtn = document.getElementById('sb-play');
      const timeEl = document.getElementById('sb-time');
      const trackEl = document.getElementById('sb-track');
      const fillEl = document.getElementById('sb-fill');
      const fullBtn = document.getElementById('sb-full');
      const clock = (t) => { t = Math.max(0, Math.floor(t || 0)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
      const drawBar = () => {
        const d = isFinite(salesVideo.duration) ? salesVideo.duration : 0;
        timeEl.textContent = clock(salesVideo.currentTime) + ' / ' + clock(d);
        fillEl.style.width = (d ? (salesVideo.currentTime / d) * 100 : 0) + '%';
      };
      const drawPlay = () => {
        salesBar.classList.toggle('is-paused', salesVideo.paused);
        playBtn.setAttribute('aria-label', salesVideo.paused ? 'Play' : 'Pause');
      };
      ['timeupdate', 'durationchange', 'seeked', 'loadedmetadata'].forEach(ev => salesVideo.addEventListener(ev, drawBar));
      ['play', 'pause', 'ended'].forEach(ev => salesVideo.addEventListener(ev, drawPlay));
      playBtn.addEventListener('click', () => { if (salesVideo.paused) salesVideo.play().catch(() => {}); else salesVideo.pause(); });
      // Seek: tap or drag along the bar
      const seekTo = (x) => {
        const r = trackEl.getBoundingClientRect();
        const d = salesVideo.duration;
        if (!isFinite(d) || !r.width) return;
        salesVideo.currentTime = Math.min(1, Math.max(0, (x - r.left) / r.width)) * d;
        drawBar();
      };
      let dragging = false;
      trackEl.addEventListener('pointerdown', (e) => { dragging = true; trackEl.setPointerCapture && trackEl.setPointerCapture(e.pointerId); seekTo(e.clientX); });
      trackEl.addEventListener('pointermove', (e) => { if (dragging) seekTo(e.clientX); });
      ['pointerup', 'pointercancel'].forEach(ev => trackEl.addEventListener(ev, () => { dragging = false; }));
      // Full screen: the phone's own full-screen player (iPhones only allow that one), with its own controls
      fullBtn.addEventListener('click', () => {
        if (salesVideo.webkitEnterFullscreen && !salesVideo.requestFullscreen) { salesVideo.webkitEnterFullscreen(); return; }
        if (salesVideo.requestFullscreen) {
          salesVideo.controls = true;
          salesVideo.requestFullscreen().catch(() => { salesVideo.controls = false; if (salesVideo.webkitEnterFullscreen) salesVideo.webkitEnterFullscreen(); });
        } else if (salesVideo.webkitEnterFullscreen) salesVideo.webkitEnterFullscreen();
      });
      document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && touch) salesVideo.controls = false; });
      drawBar(); drawPlay();
    }

    // While the control bar shows (paused, or just after the mouse or a finger moved over the video),
    // the caption moves up above it, so it never covers the seek bar; then it goes back to the very bottom.
    let barTimer = 0;
    const barUp = () => {
      if (!withSound) return;
      salesPanel.classList.add('bar-up');
      clearTimeout(barTimer);
      barTimer = setTimeout(() => { if (!salesVideo.paused) salesPanel.classList.remove('bar-up'); }, 2800);
    };
    ['pointermove', 'pointerdown', 'touchstart'].forEach(ev => salesPanel.addEventListener(ev, barUp, { passive: true }));
    salesBtn.addEventListener('click', () => setTimeout(barUp, 0)); // show the bar for a moment when the sound comes on
    salesVideo.addEventListener('pause', () => { if (withSound) { clearTimeout(barTimer); salesPanel.classList.add('bar-up'); } });
    salesVideo.addEventListener('play', barUp);

    salesVideo.addEventListener('timeupdate', () => {
      if (!withSound || !salesVideo.duration || !isFinite(salesVideo.duration)) return;
      const pct = (salesVideo.currentTime / salesVideo.duration) * 100;
      [25, 50, 75, 95].forEach(mark => {
        if (pct >= mark && !reached[mark]) {
          reached[mark] = true;
          track.event('VideoProgress', { percent: mark });
        }
      });
    });

    // Only one video plays at a time: the sales video pauses when a client video starts, and the other way round
    salesVideo.addEventListener('play', () => {
      if (!withSound) return;
      document.querySelectorAll('.video-wrapper video').forEach(v => { if (!v.paused) v.pause(); });
    });
    document.querySelectorAll('.video-wrapper video').forEach(v => {
      v.addEventListener('play', () => { if (!salesVideo.paused) salesVideo.pause(); });
    });

    // Pause the muted autoplay while it is scrolled out of view (saves data), resume when it comes back
    let inView = true;
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(entries => {
        inView = entries[0].isIntersecting;
        if (withSound || salesVideo.hidden || !sourceReady) return;
        if (inView) salesVideo.play().catch(() => {}); else salesVideo.pause();
      }, { threshold: 0.25 }).observe(salesPanel);
    }

    const setUp = (cfg) => {
      const url = cfg && cfg.salesVideoUrl;
      cfgUrl = url || '';
      if (!url) {
        // No video set: only then "Video coming soon" (the poster and button show from the first paint otherwise)
        salesVideo.hidden = true;
        salesBtn.hidden = true;
        salesPanel.classList.remove('has-video');
        const ph0 = document.getElementById('sales-placeholder');
        if (ph0) ph0.hidden = false;
        return;
      }
      // Open the connection to the video host now, so the first seconds arrive without a wait
      try {
        const link = document.createElement('link');
        link.rel = 'preconnect';
        link.href = new URL(url, window.location.href).origin;
        link.crossOrigin = '';
        document.head.appendChild(link);
      } catch (err) {}
      if (cfg.salesVideoPoster) salesVideo.poster = cfg.salesVideoPoster;
      if (cfg.salesVideoCaptions) loadCaptions(cfg.salesVideoCaptions);
      // The poster shows at once; the video itself only starts downloading after the page has loaded,
      // so the landing page's own speed is not affected (Shubhang, 15 Nov)
      salesVideo.hidden = false;
      const ph = document.getElementById('sales-placeholder');
      if (ph) ph.hidden = true;
      salesPanel.classList.add('has-video');
      salesBtn.hidden = false;
      const start = () => {
        salesVideo.preload = 'auto';
        ensureSource().then(() => {
          if (!inView || withSound) return;
          // Muted autoplay; if the phone blocks it, the poster and the button stay (the button plays it with sound)
          const tryPlay = salesVideo.play();
          if (tryPlay && tryPlay.catch) tryPlay.catch(() => salesPanel.classList.add('autoplay-blocked'));
        });
      };
      if (wantSound) { start(); startWithSound(); return; }
      if (document.readyState === 'complete') start();
      else window.addEventListener('load', start, { once: true });
    };

    const cfgPromise = window.SVTrack ? window.SVTrack.config() : fetch('/api/config').then(r => r.json());
    Promise.resolve(cfgPromise).then(setUp).catch(() => {});
  }

  // ---------- Hero size: the same look on every laptop ----------
  // The "Check if you qualify" button always fits the first screen; the client faces under it may not (Shubhang, 18 Nov).
  // The hero is laid out once for the boss's Mac screen (REF_W x REF_H) and then zoomed as one piece to fit this
  // screen, so the text, video and button box keep the same sizes next to each other on every laptop
  // (an HP at 1920x1080 with Windows' 125% scaling showed a small video beside full-size text, 17 Nov).
  // Inside that layout the video takes the height that is left, up to 1000px wide; the button box gets the same width.
  // Phones and tablets (under 1024px wide) keep the normal layout; the CSS handles them.
  (function fitHero() {
    const hero = document.getElementById('hero');
    const inner = document.querySelector('.hero-inner');
    const panel = document.getElementById('sales-panel');
    const box = document.getElementById('cta-hero');
    if (!hero || !inner || !panel || !box) return;
    const MAX = 1000, MIN = 440, BOTTOM = 6;
    const fit = () => {
      const s = window.heroZoom ? window.heroZoom() : 1; // also set in the <head>, so the first paint is already right
      if (window.innerWidth < 768) { inner.style.removeProperty('--hero-w'); return; }
      // Measured with the zoom switched off for a moment (and the hero given the width the zoom would give it):
      // browsers don't agree on how they report sizes inside a zoomed box (Safari differs from Chrome), plain px they do
      const heroTop = (hero.getBoundingClientRect().top + window.scrollY) / s; // what is above the hero, in hero px
      hero.style.zoom = '1';
      hero.style.width = (window.innerWidth / s) + 'px';
      const cs = getComputedStyle(inner);
      const room = Math.min(MAX, inner.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
      let w = room;
      // Twice: the box's height depends on its width (its text can wrap)
      for (let i = 0; i < 2; i++) {
        inner.style.setProperty('--hero-w', w + 'px');
        const top = heroTop + panel.getBoundingClientRect().top - hero.getBoundingClientRect().top;
        const gap = parseFloat(getComputedStyle(box).marginTop) || 0;
        // What must fit is the box down to the "Check if you qualify" button; the client faces under it may go below
        const btn = box.querySelector('.btn-primary');
        const need = btn ? btn.getBoundingClientRect().bottom - box.getBoundingClientRect().top + 12 : box.offsetHeight;
        const height = window.innerHeight / s - top - gap - need - BOTTOM;
        w = Math.max(MIN, Math.min(room, Math.floor(height * 16 / 9)));
      }
      hero.style.removeProperty('zoom');
      hero.style.removeProperty('width');
      inner.style.setProperty('--hero-w', w + 'px');
    };
    let queued = false;
    const later = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; fit(); }); };
    fit();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit); // the headline's font changes its height
    window.addEventListener('resize', later);
    window.addEventListener('load', fit, { once: true });
  })();

  // Video carousel arrows
  const videoGrid = document.getElementById('video-grid');
  const videoPrev = document.getElementById('video-prev');
  const videoNext = document.getElementById('video-next');
  if (videoGrid && videoPrev && videoNext) {
    const step = () => {
      const card = videoGrid.querySelector('.video-card');
      return card ? card.offsetWidth + 24 : 320;
    };
    const syncNav = () => {
      videoPrev.disabled = videoGrid.scrollLeft <= 4;
      videoNext.disabled = videoGrid.scrollLeft + videoGrid.clientWidth >= videoGrid.scrollWidth - 4;
    };
    videoPrev.addEventListener('click', () => videoGrid.scrollBy({ left: -step(), behavior: 'smooth' }));
    videoNext.addEventListener('click', () => videoGrid.scrollBy({ left: step(), behavior: 'smooth' }));
    videoGrid.addEventListener('scroll', syncNav, { passive: true });
    window.addEventListener('resize', syncNav);
    syncNav();
  }

  // Sticky button (phones): shows whenever no page button is on screen, the footer is off screen and the form is closed
  const stickyCta = document.getElementById('sticky-cta');
  const stickyBtn = stickyCta ? stickyCta.querySelector('button') : null;
  const siteFooter = document.getElementById('site-footer');
  const pageButtons = Array.from(document.querySelectorAll('.js-open-modal')).filter(b => !b.closest('#sticky-cta'));
  const visibleAnchors = new Set();

  function updateStickyButton() {
    if (!stickyCta) return;
    const show = visibleAnchors.size === 0 && !modalBackdrop.classList.contains('active');
    stickyCta.classList.toggle('is-shown', show);
    stickyCta.setAttribute('aria-hidden', show ? 'false' : 'true');
    if (stickyBtn) stickyBtn.tabIndex = show ? 0 : -1;
  }

  if (stickyCta && 'IntersectionObserver' in window) {
    const stickyObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) visibleAnchors.add(entry.target);
        else visibleAnchors.delete(entry.target);
      });
      updateStickyButton();
    });
    pageButtons.forEach(b => stickyObserver.observe(b));
    if (siteFooter) stickyObserver.observe(siteFooter);
  }
  updateStickyButton();

  // Logos scroll back to the top of the page instead of reloading it
  document.querySelectorAll('.js-to-top').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

});
