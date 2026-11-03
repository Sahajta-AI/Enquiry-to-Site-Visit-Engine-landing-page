/**
 * SAHAJTA AI — ENQUIRY-TO-SITE-VISIT ENGINE
 * Client-side booking form, Meta Pixel tracker and page behaviour
 */

document.addEventListener('DOMContentLoaded', () => {
  // State variables (this whole object is posted to /api/submit-lead: do not add keys)
  const wizardState = {
    currentStep: 1,
    q1_situation: '',
    q2_urgency: '',
    name: '',
    company: '',
    email: '',
    whatsapp_number: '',
    bookedSlot: '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  };

  // Dynamic Meta Pixel Script Loader & Funnel Configuration
  fetch('/api/config')
    .then(res => res.json())
    .then(data => {
      if (data.calendarEmbedUrl) window.CALENDAR_EMBED_URL = data.calendarEmbedUrl;
      if (data.whatsappNumber) window.WHATSAPP_NUMBER = data.whatsappNumber;

      if (data.metaPixelId && data.metaPixelId.trim() !== '') {
        initMetaPixel(data.metaPixelId.trim());
      }
    })
    .catch(() => {});

  function initMetaPixel(pixelId) {
    if (typeof window.fbq === 'function') {
      window.fbq('set', 'autoConfig', false, pixelId);
      window.fbq('init', pixelId);
      window.fbq('track', 'PageView');
      console.log(`✅ [Meta Pixel Active]: Initialized with ID ${pixelId}`);
    }
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

  // Helper: Meta Pixel Tracker Safe Trigger (Standard + Custom Funnel Tracking)
  function trackMetaEvent(eventName, params = {}, isCustom = false) {
    if (typeof window.fbq === 'function') {
      try {
        if (isCustom) {
          window.fbq('trackCustom', eventName, params);
        } else {
          window.fbq('track', eventName, params);
        }
        console.log(`[Meta Pixel Event]: ${eventName}`, params);
      } catch (err) {
        console.warn('[Meta Pixel Error]:', err.message);
      }
    }
  }

  function trackOnce(eventName, params) {
    if (firedOnce[eventName]) return;
    firedOnce[eventName] = true;
    trackMetaEvent(eventName, params);
  }

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

  ctaButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
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

    [wizardStep1, wizardStep2, wizardStep3, wizardStep4].forEach(el => {
      if (el) el.classList.remove('active');
    });

    const stepEl = { 1: wizardStep1, 2: wizardStep2, 3: wizardStep3, 4: wizardStep4 }[stepNumber];
    if (stepEl) stepEl.classList.add('active');

    progressFill.style.width = progressByStep[stepNumber] || '25%';
    stepPill.textContent = (stepEl && stepEl.dataset.progressLabel) || '';
    if (modalBody) modalBody.scrollTop = 0;

    if (stepNumber === 3) {
      // Track InitiateCheckout once, when the visitor reaches the contact details step
      trackOnce('InitiateCheckout', { content_name: 'IntakeCompleted' });
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

    // Track Lead once, when the contact details are submitted
    try {
      trackOnce('Lead', { content_name: 'ContactForm' });
    } catch (err) {
      console.warn('Meta pixel lead tracking notice:', err);
    }

    goToStep(4);
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

      // First time on this screen: if the current month has no open times, open the next month if it has some
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
          }
        }
      }

      const availableDates = monthData?.availableDates || [];
      const slotsByDate = monthData?.slotsByDate || {};

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

      const morningSlots = availableSlots.filter(s => s.toLowerCase().includes('am') || s.startsWith('10:') || s.startsWith('11:'));
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
        slotsHtml = `<p class="cal-status">${msg('msgNone')}</p>`;
      }

      const formattedSelectedDate = picker.selectedDate ? picker.selectedDate.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      }) : '';

      const activeFullSlot = (picker.selectedDate && picker.selectedTimeStr)
        ? `${formattedSelectedDate} at ${picker.selectedTimeStr} (${wizardState.timezone})`
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
          const finalSlotStr = `${sel.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })} at ${picker.selectedTimeStr} (${wizardState.timezone})`;
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

  // The booking failed: stay on the time screen, show the message, reload the times, let the visitor pick again
  function showBookingFailure() {
    isSubmittingLead = false;
    picker.bookingError = true;
    Object.keys(monthSlotsCache).forEach(k => delete monthSlotsCache[k]);
    if (typeof pickerRender === 'function') pickerRender();
  }

  function handleSlotConfirmation(slotText) {
    wizardState.bookedSlot = slotText;
    submitLeadToBackend(wizardState);
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

    // Schedule fires once, here, after a booking succeeds. The /thank-you page never fires it.
    trackMetaEvent('Schedule', {
      content_name: 'LeadConversionClarityCallBooked',
      value: 1.00,
      currency: 'USD'
    });

    // The booking details stay in this browser's session memory, never in the page address
    const booked = {
      firstName: (payload.name || '').trim().split(/\s+/)[0] || '',
      slotDate: payload.slotDate,
      slotTime: payload.slotTime,
      timezone: payload.timezone,
      rescheduleUrl: (result && result.rescheduleUrl) || ''
    };
    try { sessionStorage.setItem('sv_booked', JSON.stringify(booked)); } catch (err) {}

    // Reset the form so Back from /thank-you never shows the time step again
    resetBookingForm();

    // Short pause so the Schedule event leaves the browser before the page changes
    setTimeout(() => { window.location.assign('/thank-you'); }, 300);
  }

  function resetBookingForm() {
    wizardState.currentStep = 1;
    ['q1_situation', 'q2_urgency', 'name', 'company', 'email', 'whatsapp_number', 'bookedSlot', 'slotDate', 'slotTime'].forEach(k => {
      wizardState[k] = '';
    });
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
      if (booked) resetBookingForm();
    }
  });

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

  // Initial Meta Pixel PageView trigger
  trackMetaEvent('PageView');
});
