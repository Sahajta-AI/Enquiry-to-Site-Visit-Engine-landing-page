/**
 * SAHAJTA AI — ENQUIRY-TO-SITE-VISIT ENGINE
 * Client-side Intake Wizard, Meta Pixel Tracker & Modal Manager
 */

document.addEventListener('DOMContentLoaded', () => {
  // State variables
  const wizardState = {
    currentStep: 1,
    q1_situation: '',
    q2_urgency: '',
    name: '',
    company: '',
    email: '',
    whatsapp_number: '',
    bookedSlot: '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    whatsappConfirmed: false,
    precallVideoWatched: false
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
  const wizardThankYou = document.getElementById('wizard-thank-you');
  
  const stepPill = document.getElementById('wizard-step-pill');
  const progressFill = document.getElementById('wizard-progress-fill');
  
  // Back & Next Buttons
  const btnStep1Next = document.getElementById('btn-step-1-next');
  const btnStep2Back = document.getElementById('btn-step-2-back');
  const btnStep2Next = document.getElementById('btn-step-2-next');
  const btnStep3Back = document.getElementById('btn-step-3-back');
  const btnStep3Submit = document.getElementById('btn-step-3-submit');
  const btnSimulateBooking = document.getElementById('btn-simulate-booking');
  
  // WhatsApp & Pre-call Video buttons
  const btnWhatsappConfirm = document.getElementById('btn-whatsapp-confirm');
  const precallVideoPlayBtn = document.getElementById('precall-video-play-btn');

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

  // 1. Modal Toggle Handlers
  function openModal() {
    modalBackdrop.classList.add('active');
    document.body.classList.add('modal-open');
    goToStep(1);
  }

  function closeModal() {
    modalBackdrop.classList.remove('active');
    document.body.classList.remove('modal-open');
  }

  ctaButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      openModal();
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

  // 2. Wizard Navigation Engine
  function goToStep(stepNumber) {
    wizardState.currentStep = stepNumber;
    
    // Hide all steps
    [wizardStep1, wizardStep2, wizardStep3, wizardStep4, wizardThankYou].forEach(el => {
      if (el) el.classList.remove('active');
    });

    if (stepNumber === 1) {
      wizardStep1.classList.add('active');
      stepPill.textContent = 'Step 1 of 4 — Project Status';
      progressFill.style.width = '25%';
    } else if (stepNumber === 2) {
      wizardStep2.classList.add('active');
      stepPill.textContent = 'Step 2 of 4 — Urgency & Timeline';
      progressFill.style.width = '50%';
    } else if (stepNumber === 3) {
      wizardStep3.classList.add('active');
      stepPill.textContent = 'Step 3 of 4 — Contact Details';
      progressFill.style.width = '75%';
      // Track InitiateCheckout ONCE when user reaches Contact Details step
      trackMetaEvent('InitiateCheckout', { content_name: 'IntakeCompleted' });
    } else if (stepNumber === 4) {
      wizardStep4.classList.add('active');
      stepPill.textContent = 'Step 4 of 4 — Select Strategy Call Slot';
      progressFill.style.width = '100%';
    } else if (stepNumber === 5) {
      wizardThankYou.classList.add('active');
      stepPill.textContent = '✓ Booking Confirmed';
      progressFill.style.width = '100%';
    }
  }

  // 3. Q1 Option Selection (Step 1)
  const q1Options = document.querySelectorAll('.js-q1-option');
  q1Options.forEach(card => {
    card.addEventListener('click', () => {
      q1Options.forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      const value = card.dataset.value;
      wizardState.q1_situation = value;
      btnStep1Next.disabled = false;

      // Auto-advance after brief smooth feedback
      setTimeout(() => {
        goToStep(2);
      }, 250);
    });
  });

  if (btnStep1Next) {
    btnStep1Next.addEventListener('click', () => {
      if (wizardState.q1_situation) goToStep(2);
    });
  }

  // 4. Q2 Option Selection (Step 2)
  const q2Options = document.querySelectorAll('.js-q2-option');
  q2Options.forEach(card => {
    card.addEventListener('click', () => {
      q2Options.forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      const value = card.dataset.value;
      wizardState.q2_urgency = value;
      btnStep2Next.disabled = false;

      // Auto-advance after brief smooth feedback
      setTimeout(() => {
        goToStep(3);
      }, 250);
    });
  });

  if (btnStep2Back) {
    btnStep2Back.addEventListener('click', () => goToStep(1));
  }
  if (btnStep2Next) {
    btnStep2Next.addEventListener('click', () => {
      if (wizardState.q2_urgency) goToStep(3);
    });
  }

  // 5. Contact Form Handler (Step 3)
  if (btnStep3Back) {
    btnStep3Back.addEventListener('click', () => goToStep(2));
  }

  const contactForm = document.getElementById('intake-contact-form');
  if (contactForm) {
    contactForm.addEventListener('submit', (e) => {
      e.preventDefault();
      
      const nameInput = document.getElementById('field-name');
      const companyInput = document.getElementById('field-company');
      const emailInput = document.getElementById('field-email');
      const phoneInput = document.getElementById('field-whatsapp');

      let isValid = true;

      // Validate Name
      if (!nameInput.value.trim()) {
        nameInput.closest('.form-group').classList.add('has-error');
        isValid = false;
      } else {
        nameInput.closest('.form-group').classList.remove('has-error');
      }

      // Validate Company
      if (!companyInput.value.trim()) {
        companyInput.closest('.form-group').classList.add('has-error');
        isValid = false;
      } else {
        companyInput.closest('.form-group').classList.remove('has-error');
      }

      // Validate Email
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(emailInput.value.trim())) {
        emailInput.closest('.form-group').classList.add('has-error');
        isValid = false;
      } else {
        emailInput.closest('.form-group').classList.remove('has-error');
      }

      // Validate WhatsApp Phone
      if (!phoneInput.value.trim() || phoneInput.value.trim().length < 6) {
        phoneInput.closest('.form-group').classList.add('has-error');
        isValid = false;
      } else {
        phoneInput.closest('.form-group').classList.remove('has-error');
      }

      if (isValid) {
        wizardState.name = nameInput.value.trim();
        wizardState.company = companyInput.value.trim();
        wizardState.email = emailInput.value.trim();
        wizardState.whatsapp_number = phoneInput.value.trim();
        
        // Track Lead ONCE when Contact Form is submitted
        trackMetaEvent('Lead', { content_name: 'ContactForm' });

        loadCalComEmbed();
        goToStep(4);
      }
    });
  }

  // 6. Cal.com Dynamic Embed & Event Handling (Pre-filled URL & Frictionless Frame)
  function loadCalComEmbed() {
    const container = document.getElementById('cal-embed-container');
    if (!container) return;

    const encodedName = encodeURIComponent(wizardState.name);
    const encodedEmail = encodeURIComponent(wizardState.email);
    const encodedNotes = encodeURIComponent(wizardState.company ? `Company / Project: ${wizardState.company}` : '');
    
    // Cal.com embed URL with pre-filled parameters & clean light theme matching modal
    const calBaseUrl = window.CALENDAR_EMBED_URL || 'https://cal.com/shubhang-sethi/enquiry-to-site-visit-engine';
    const hasQuery = calBaseUrl.includes('?');
    const calIframeUrl = `${calBaseUrl}${hasQuery ? '&' : '?'}name=${encodedName}&email=${encodedEmail}&notes=${encodedNotes}&theme=light&layout=month_view`;

    container.innerHTML = `
      <iframe 
        src="${calIframeUrl}" 
        style="width: 100%; height: 620px; border: none; border-radius: 12px;"
        title="Select Strategy Call Slot"
        allow="camera; microphone; autoplay; clipboard-write;"
      ></iframe>
    `;
  }

  // Helper: Extract Date object from any Cal.com payload structure
  function extractCalComDate(data) {
    if (!data) return null;
    
    // 1. Scan JSON string representation for ISO timestamps (e.g. 2026-08-24T14:30:00 or 2026-08-24)
    try {
      const jsonStr = typeof data === 'string' ? data : JSON.stringify(data);
      const matches = jsonStr.match(/\b(202[4-9]-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?)/g);
      if (matches && matches.length > 0) {
        for (const matchStr of matches) {
          const d = new Date(matchStr);
          if (!isNaN(d.getTime())) return d;
        }
      }
    } catch (err) {}

    // 2. Direct property key lookup
    const possiblePaths = [
      data?.data?.booking?.startTime,
      data?.data?.booking?.start,
      data?.data?.booking?.date,
      data?.data?.startTime,
      data?.data?.date,
      data?.data?.start,
      data?.payload?.booking?.startTime,
      data?.payload?.booking?.start,
      data?.payload?.booking?.date,
      data?.payload?.startTime,
      data?.payload?.date,
      data?.booking?.startTime,
      data?.booking?.start,
      data?.booking?.date,
      data?.detail?.booking?.startTime,
      data?.detail?.booking?.start,
      data?.detail?.booking?.date,
      data?.detail?.startTime,
      data?.detail?.date,
      data?.date,
      data?.startTime,
      data?.start
    ];

    for (const val of possiblePaths) {
      if (val) {
        const d = new Date(val);
        if (!isNaN(d.getTime())) return d;
      }
    }
    return null;
  }

  function formatSlotString(dateObj) {
    return dateObj.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    }) + ' at ' + dateObj.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) + ' (' + wizardState.timezone + ')';
  }

  // Listen for Cal.com window postMessage events
  window.addEventListener('message', (e) => {
    try {
      const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
      
      // Log all Cal.com postMessage events for debugging
      if (data && (data.type?.startsWith('CAL:') || data.action || data.event)) {
        console.log('🗓️ [Cal.com Message Event]:', data);
      }

      const dataType = String(data?.type || data?.action || data?.event || '').toLowerCase();
      const isBookingSuccess = (
        dataType === 'cal:booking_successful' ||
        dataType === 'bookingsuccessful' ||
        dataType.includes('booking_successful') ||
        dataType.includes('bookingsuccessful') ||
        dataType.includes('scheduled')
      );

      if (data && isBookingSuccess) {
        console.log('🎉 [Cal.com Booking Successful]:', data);
        
        const extractedDate = extractCalComDate(data);
        if (extractedDate) {
          const formatted = formatSlotString(extractedDate);
          handleSlotConfirmation(formatted);
        } else {
          handleSlotConfirmation();
        }
      }
    } catch (err) {
      // Ignore non-JSON postMessages
    }
  });

  // Official Cal.com JS SDK Event Callback binding
  if (window.Cal) {
    try {
      window.Cal("on", {
        action: "bookingSuccessful",
        callback: (e) => {
          console.log('🎉 [Cal.com SDK Callback]:', e);
          const extractedDate = extractCalComDate(e);
          if (extractedDate) {
            handleSlotConfirmation(formatSlotString(extractedDate));
          } else {
            handleSlotConfirmation();
          }
        }
      });
    } catch (err) {
      console.warn('Cal SDK listener notice:', err);
    }
  }

  function handleSlotConfirmation(overrideSlotText) {
    let formattedSlot = '';
    if (typeof overrideSlotText === 'string' && overrideSlotText.length > 5) {
      formattedSlot = overrideSlotText;
    } else {
      // Clean, accurate fallback label if date timestamp was not sent in postMessage
      formattedSlot = 'Confirmed Strategy Call Slot';
    }

    wizardState.bookedSlot = formattedSlot;
    submitLeadToBackend(wizardState);
  }

  async function submitLeadToBackend(payload) {
    try {
      if (btnSimulateBooking) {
        btnSimulateBooking.disabled = true;
        btnSimulateBooking.textContent = 'Confirming Slot...';
      }

      const response = await fetch('/api/submit-lead', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const result = await response.json();
      
      if (result.success) {
        // Track Schedule event on Meta Pixel ONCE for final conversion stage
        trackMetaEvent('Schedule', {
          content_name: 'StrategyCallBooked',
          value: 1.00,
          currency: 'USD'
        });

        // Update Thank-You View details
        document.getElementById('ty-first-name').textContent = payload.name.split(' ')[0] || payload.name;
        document.getElementById('ty-booked-slot').textContent = payload.bookedSlot;
        
        // Setup WhatsApp link with pre-filled confirmation text
        const waNumber = result.whatsappNumber || '';
        const waMsg = encodeURIComponent('Hi, I have booked my Enquiry-to-Site-Visit Engine strategy call and confirm that I will attend');
        const waUrl = `https://wa.me/${waNumber}?text=${waMsg}`;
        
        if (btnWhatsappConfirm) {
          btnWhatsappConfirm.setAttribute('href', waUrl);
          btnWhatsappConfirm.setAttribute('target', '_blank');
        }

        goToStep(5);
      } else {
        alert('Submission error: ' + (result.error || 'Please try again.'));
        if (btnSimulateBooking) {
          btnSimulateBooking.disabled = false;
          btnSimulateBooking.textContent = 'Simulate Booking Slot →';
        }
      }
    } catch (err) {
      console.error('Error submitting lead:', err);
      // Fallback display if network issue occurs
      document.getElementById('ty-first-name').textContent = payload.name.split(' ')[0] || payload.name;
      document.getElementById('ty-booked-slot').textContent = payload.bookedSlot;
      goToStep(5);
    }
  }

  // 7. Interactive Step 1 & Step 2 Confirmation Handlers in Thank-You State
  if (btnWhatsappConfirm) {
    btnWhatsappConfirm.addEventListener('click', () => {
      const step1Card = document.getElementById('precall-step-1-card');
      if (step1Card) {
        step1Card.classList.add('completed');
        step1Card.querySelector('.step-status-badge').textContent = '✓ Completed';
      }
      wizardState.whatsappConfirmed = true;
      trackMetaEvent('WhatsAppConfirmClick');
    });
  }

  if (precallVideoPlayBtn) {
    precallVideoPlayBtn.addEventListener('click', () => {
      alert('▶ Pre-Call Strategy Overview Video Playing...');
      const step2Card = document.getElementById('precall-step-2-card');
      if (step2Card) {
        step2Card.classList.add('completed');
        step2Card.querySelector('.step-status-badge').textContent = '✓ Completed';
      }
      wizardState.precallVideoWatched = true;
      trackMetaEvent('PreCallVideoWatched');
    });
  }

  // Video Testimonial Interactive Controller (Auto-Pause Others & Full Native Controls)
  const allVideos = document.querySelectorAll('.video-wrapper video');
  allVideos.forEach(video => {
    const wrapper = video.closest('.video-wrapper');
    const overlayBtn = wrapper ? wrapper.querySelector('.video-play-overlay') : null;

    if (overlayBtn) {
      overlayBtn.addEventListener('click', (e) => {
        e.stopPropagation();
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

  // Initial Meta Pixel PageView trigger
  trackMetaEvent('PageView');
});
