const chrono = require('chrono-node');
const { DateTime } = require('luxon');

function pickDefaultHourByHint(text) {
  const t = (text || '').toLowerCase();
  if (t.includes('morning')) return 9; // 9 AM
  if (t.includes('afternoon')) return 14; // 2 PM
  if (t.includes('evening')) return 18; // 6 PM
  return null;
}

function ensureFuture(dt, now, weekdayBias = false) {
  let future = dt;
  if (future <= now) {
    future = weekdayBias ? future.plus({ days: 7 }) : future.plus({ days: 1 });
    if (future <= now) future = now.plus({ minutes: 5 });
  }
  return future;
}

function parseRelativeDateToISO({ text, timezone = 'America/Chicago', now }) {
  const ref = now && DateTime.isDateTime(now) ? now : DateTime.now().setZone(timezone);
  const results = chrono.casual.parse(text, ref.toJSDate(), { forwardDate: true });
  if (!results || results.length === 0) return null;

  const r = results[0];
  let dt = DateTime.fromJSDate(r.start.date(), { zone: timezone }).setZone(timezone);

  // If time not certain, apply default hour by common hints
  const hourCertain = r.start.isCertain('hour');
  if (!hourCertain) {
    const defaultHour = pickDefaultHourByHint(text);
    if (defaultHour !== null) dt = dt.set({ hour: defaultHour, minute: 0, second: 0, millisecond: 0 });
  }

  // Ensure future
  const weekdayBias = !!r.start.get('weekday');
  dt = ensureFuture(dt, ref, weekdayBias);

  return dt.toISO();
}

module.exports = { parseRelativeDateToISO };


