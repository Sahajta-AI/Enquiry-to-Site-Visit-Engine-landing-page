// Times, written one way everywhere (Thank-you Page Brief v1, part 1): "12:25 pm", "IST" or "Dubai time".

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function isIndia(tz) {
  return !tz || tz === 'Asia/Kolkata' || tz === 'Asia/Calcutta';
}

function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
}

function zoneLabel(tz) {
  if (isIndia(tz)) return 'IST';
  return String(tz).split('/').pop().replace(/_/g, ' ') + ' time';
}

// Turns a wall-clock date and time in a named time zone into the real moment (UTC).
function zonedTimeToUtc(dateStr, hours, minutes, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const wallAsUtc = Date.UTC(y, m - 1, d, hours, minutes, 0);
  const offsetAt = (ms) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(new Date(ms)).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    return asUtc - ms;
  };
  let guess = wallAsUtc - offsetAt(wallAsUtc);
  guess = wallAsUtc - offsetAt(guess);
  return new Date(guess);
}

function zoneParts(date, tz) {
  const zone = isValidTimeZone(tz) ? tz : 'Asia/Kolkata';
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: '2-digit', weekday: 'long'
  }).formatToParts(date).reduce((o, x) => { o[x.type] = x.value; return o; }, {});
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, weekday: p.weekday };
}

// { dayLong: "Wednesday, 28 October", dayShort: "Wed 28 Oct", time: "4:05 pm", zone: "IST", weekday: "Wednesday" }
function describe(date, tz) {
  const z = zoneParts(date, tz);
  const h12 = z.hour % 12 === 0 ? 12 : z.hour % 12;
  const mm = String(z.minute).padStart(2, '0');
  return {
    weekday: z.weekday,
    dayLong: `${z.weekday}, ${z.day} ${MONTHS[z.month - 1]}`,
    dayShort: `${z.weekday.slice(0, 3)} ${z.day} ${MONTHS[z.month - 1].slice(0, 3)}`,
    time: `${h12}:${mm} ${z.hour >= 12 ? 'pm' : 'am'}`,
    zone: zoneLabel(tz)
  };
}

// The same wall clock, on a given local day, at hour:00
function localAt(date, tz, hour, addDays) {
  const z = zoneParts(date, tz);
  const base = new Date(Date.UTC(z.year, z.month - 1, z.day + (addDays || 0)));
  return zonedTimeToUtc(base.toISOString().slice(0, 10), hour, 0, isValidTimeZone(tz) ? tz : 'Asia/Kolkata');
}

// Due between 9 pm and 8 am in the lead's own time zone: hold it until 8 am there
function holdToMorning(date, tz) {
  const h = zoneParts(date, tz).hour;
  if (h >= 21) return localAt(date, tz, 8, 1);
  if (h < 8) return localAt(date, tz, 8, 0);
  return date;
}

// 10 am on the local day after `date`
function nextDayTenAm(date, tz) {
  return localAt(date, tz, 10, 1);
}

// Calendar day in India time, "2026-11-05" (the daily limits are counted by IST day)
function istDay(date) {
  return new Date((date || new Date()).getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

module.exports = { MONTHS, DAYS, isIndia, isValidTimeZone, zoneLabel, zonedTimeToUtc, zoneParts, describe, localAt, holdToMorning, nextDayTenAm, istDay };
