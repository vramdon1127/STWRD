// lib/task-dates.mjs — pure due-date helpers extracted from index.html.
// Both functions take the caller's "today" as an explicit YYYY-MM-DD string
// instead of reading the clock (new Date() / todayStr()) internally, so
// they're deterministic and unit-testable without mocking time.
//
// Browser bridge (no build step): index.html loads this as a module and
// exposes it to the classic inline script, e.g. near the top of <head>:
//   <script type="module">
//     import { humanDueLabel, daysBetween } from './lib/task-dates.mjs';
//     window.humanDueLabel = humanDueLabel;
//     window.daysBetween = daysBetween;
//   </script>

const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Day-of-week short name for a YYYY-MM-DD string (UTC-anchored to avoid
// browser-local TZ drift; the string already encodes a specific calendar day).
function dowShort(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return DOW_SHORT[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/**
 * Whole-day difference between two YYYY-MM-DD strings (UTC-anchored).
 * @param {string} fromStr
 * @param {string} toStr
 * @returns {number} toStr minus fromStr, in days.
 */
export function daysBetween(fromStr, toStr) {
  const [y1, m1, d1] = fromStr.split('-').map(Number);
  const [y2, m2, d2] = toStr.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

/**
 * Human-readable "when" label — Today/Tomorrow/Yesterday, day-of-week,
 * Next <day>, then MM/DD.
 * @param {string} dueStr YYYY-MM-DD due date.
 * @param {string} today  YYYY-MM-DD "today", supplied by the caller.
 */
export function humanDueLabel(dueStr, today) {
  const delta = daysBetween(today, dueStr);
  const [yy, mm, dd] = dueStr.split('-');
  const mmdd = `${mm}/${dd}`;
  if (delta < 0) {
    const abs = -delta;
    if (abs === 1) return 'Yesterday';
    if (abs <= 6) return `${abs} days overdue`;
    return `${mmdd} overdue`;
  }
  if (delta === 0) return 'Today';
  if (delta === 1) return 'Tomorrow';
  if (delta <= 6) return dowShort(dueStr);
  if (delta <= 13) return `Next ${dowShort(dueStr)}`;
  if (yy === today.slice(0, 4)) return mmdd;
  return `${mmdd}/${yy.slice(2)}`;
}
