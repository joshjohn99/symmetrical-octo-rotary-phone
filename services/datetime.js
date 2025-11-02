function getCurrentDateTimeISO() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// Normalize an ISO-like datetime string to be in the current or next year and future relative to now
function ensureFutureIso(inputIso) {
  if (!inputIso) return inputIso;
  // Use the user's function as the source of "now"
  const nowStr = getCurrentDateTimeISO(); // e.g. "YYYY-MM-DD HH:mm:ss"
  // Convert to a Date by swapping space for 'T' (assumes local time)
  const now = new Date(nowStr.replace(' ', 'T'));

  const parsed = new Date(inputIso);
  if (Number.isNaN(parsed.getTime())) return inputIso;

  let candidate = new Date(parsed.getTime());
  const currentYear = now.getFullYear();
  if (candidate.getFullYear() < currentYear) {
    candidate.setFullYear(currentYear);
  }
  if (candidate < now) {
    candidate.setFullYear(candidate.getFullYear() + 1);
  }
  return candidate.toISOString();
}

console.log(getCurrentDateTimeISO());

module.exports = { getCurrentDateTimeISO, ensureFutureIso };


