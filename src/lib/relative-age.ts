// How long ago an instant was, as a short label for a list: "today",
// "yesterday", "3d ago", "2w ago", "3mo ago", "1y ago". Counted in whole
// elapsed days between the two instants, not calendar days in a zone, so
// the helper needs no time zone and a row seen 23 hours ago is "today".
// A date after `now` is clamped to "today": clock skew between the
// database and the application is never shown as the future.

const DAY_MS = 86_400_000;
const DAYS_PER_WEEK = 7;
const DAYS_PER_MONTH = 30;
const DAYS_PER_YEAR = 365;
/** Months are capped so "12mo ago" never shows; from a year on, years do. */
const MAX_MONTHS = 11;

/** Whole days elapsed from `date` to `now`, never negative. */
function daysBetween(date: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / DAY_MS));
}

/**
 * The age of `date` at `now` as a label: "today" under a day, "yesterday"
 * under two, then "Nd ago" under a week, "Nw ago" under 30 days, "Nmo ago"
 * under a year and "Ny ago" from there.
 */
export function relativeAge(date: Date, now: Date): string {
  const days = daysBetween(date, now);
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < DAYS_PER_WEEK) return `${days}d ago`;
  if (days < DAYS_PER_MONTH) return `${Math.floor(days / DAYS_PER_WEEK)}w ago`;
  if (days < DAYS_PER_YEAR) {
    return `${Math.min(MAX_MONTHS, Math.floor(days / DAYS_PER_MONTH))}mo ago`;
  }
  return `${Math.floor(days / DAYS_PER_YEAR)}y ago`;
}
