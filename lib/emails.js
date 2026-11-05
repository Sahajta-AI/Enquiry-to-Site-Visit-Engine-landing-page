// The words of the automatic emails (Thank-you Page Brief v1, part 8). Use the words exactly.
const t = require('./time');

const CALL = 'Lead Conversion Clarity Call';

// Message the page's confirm buttons type, also used in the email's WhatsApp link (part 4 and part 6)
function confirmMessage(first, d, tz) {
  return `YES, confirming my ${CALL} on ${d.dayShort} at ${d.time}${t.isIndia(tz) ? '' : ' ' + d.zone}.${first ? ' ' + first : ''}`;
}

function whatsappLink(number, message) {
  const n = String(number || '919731173205').replace(/\D/g, '');
  return `https://wa.me/${n}?text=${encodeURIComponent(message)}`;
}

const MEET_FALLBACK = 'The Google Meet link is in your calendar invite.';

// 8.1 The booking email
function bookingEmail(c) {
  const when = `${c.d.time} ${c.d.zone}`;
  const first = c.videoSet
    ? `1. Watch the 2-minute video: ${c.preCallLink}`
    : `1. See what to expect: ${c.preCallLink}`;
  const meet = c.meetLink || MEET_FALLBACK;
  const text = [
    `Hi ${c.first}, it’s Shubhang from Sahajta AI. Thanks for booking your ${CALL}.`,
    '',
    `It’s scheduled for ${c.d.dayLong}, at ${when} (45 minutes), on Google Meet:`,
    meet,
    '',
    'On this call, we’ll do three things:',
    '',
    '1. Map your lead journey',
    '   How leads come in today, and what happens between “new lead” and “site visit”.',
    '',
    '2. Find where leads go cold',
    '   Whether it’s late replies, too few follow-ups, no-shows or the handover: where your leads are slipping away.',
    '',
    '3. Build a plan to fix it',
    '   A clear path to close those gaps, so more of the leads you’ve already paid for turn into site visits.',
    '',
    'Before we meet:',
    first,
    `2. Confirm your spot on WhatsApp, if you haven’t already: ${c.waLink}`,
    '3. Have three numbers from last month ready: your ad spend, how many leads you got, and how many became site visits.',
    '',
    'If you need to move the time, please reschedule before the call here:',
    c.reschedLink,
    '',
    `See you on ${c.d.weekday},`,
    'Shubhang'
  ].join('\n');
  return {
    subject: `Your ${CALL} is scheduled for ${c.d.dayShort}, ${when}`,
    text,
    boldLines: ['1. Map your lead journey', '2. Find where leads go cold', '3. Build a plan to fix it']
  };
}

// 8.2 The second email, a reply under the first
function secondEmail(c) {
  const when = `${c.d.time} ${c.d.zone}`;
  const meetLine = c.meetLink ? `Here’s the Google Meet link: ${c.meetLink}` : MEET_FALLBACK;
  const text = [
    `Hi ${c.first},`,
    '',
    `Shubhang here. I’ll be on the call with you myself, on ${c.d.dayLong}, at ${when}. Looking forward to it.`,
    '',
    meetLine,
    '',
    'If you have any questions before then, just reply here.',
    '',
    'See you then,',
    'Shubhang'
  ].join('\n');
  return { subject: 'Re: ' + c.firstSubject, text, boldLines: [] };
}

// 8.3 The first nudge
function nudge1Email(c) {
  const text = [
    `Hi ${c.first}, it’s Shubhang from Sahajta AI.`,
    '',
    `You started booking your ${CALL}, but didn’t pick a time.`,
    '',
    'It takes 30 seconds. Pick yours here:',
    c.link,
    '',
    'On the call, we’ll:',
    '1. Map your lead journey',
    '2. Find where leads go cold',
    '3. Build a plan to fix it',
    '',
    'If none of the times work for you, just reply with one that does.',
    '',
    'Shubhang'
  ].join('\n');
  return { subject: 'One step left: pick a time for your call', text, boldLines: [] };
}

// 8.3 The second nudge, a reply under the first
function nudge2Email(c) {
  const text = [
    `Hi ${c.first},`,
    '',
    'Quick one.',
    '',
    'Every lead that waits is ad money you’ve already spent. On the call, we’ll find where yours go cold, and how to fix it.',
    '',
    'Pick a time here:',
    c.link,
    '',
    'Not the right time? Just reply and tell me. No problem at all.',
    '',
    'Shubhang'
  ].join('\n');
  return { subject: 'Re: One step left: pick a time for your call', text, boldLines: [] };
}

// The email to Shubhang about someone who didn't book (part 7)
function leaveEmail(kind, lead, nudgeLine) {
  const subject = kind === 'no_times'
    ? `No times shown: ${lead.name}, ${lead.company}`
    : `Didn’t book: ${lead.name}, ${lead.company}`;
  const lines = [
    `Name: ${lead.name}`,
    `Company: ${lead.company}`,
    `Email: ${lead.email}`,
    `WhatsApp: ${lead.whatsapp_number}`,
    `What’s happening right now: ${lead.q1_situation || 'N/A'}`,
    `When they’d want it running: ${lead.q2_urgency || 'N/A'}`
  ];
  if (nudgeLine) lines.push('', nudgeLine);
  return { subject, text: lines.join('\n'), boldLines: [] };
}

const NUDGE_STARTED_LINE = 'They get our two nudge emails unless they book or reply.';
const NUDGE_NONE_LINE = 'No nudge emails for them: WhatsApp them yourself.';

// ---- HTML copy: no design, no images; only the named lines in bold; the WhatsApp link shown short ----
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function toHtml(text, boldLines) {
  const bold = new Set(boldLines || []);
  const body = text.split('\n').map(line => {
    let h = esc(line);
    h = h.replace(/https?:\/\/[^\s<]+/g, (u) => {
      const shown = /^https:\/\/wa\.me\/(\d+)/.test(u) ? 'wa.me/' + u.match(/^https:\/\/wa\.me\/(\d+)/)[1] : u;
      return `<a href="${u}">${shown}</a>`;
    });
    h = h.replace(/^( +)/, (m) => '&nbsp;'.repeat(m.length));
    if (bold.has(line)) h = `<b>${h}</b>`;
    return h;
  }).join('<br>\n');
  return `<div>${body}</div>`;
}

module.exports = {
  CALL, MEET_FALLBACK, confirmMessage, whatsappLink, bookingEmail, secondEmail, nudge1Email, nudge2Email,
  leaveEmail, NUDGE_STARTED_LINE, NUDGE_NONE_LINE, toHtml, esc
};
