// Display strings for the usage dashboard: estimated cost, counts, shares,
// durations, ages and timestamps. Pure; the current instant is passed in.

const MICROS_PER_DOLLAR = 1_000_000;
/** The smallest amount four decimal places can show: a hundredth of a cent. */
const SMALLEST_SHOWN_MICROS = 100;

function grouped(whole: number): string {
  return String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** "1,234" for a count. */
export function formatCount(count: number): string {
  return grouped(Math.round(count));
}

/**
 * US dollars from millionths of a dollar. A dollar or more shows cents
 * ("$12.35"); less shows four decimal places so a fraction of a cent is still
 * a number ("$0.0012"); anything positive below that is "<$0.0001", never a
 * zero. Zero is "$0.00".
 */
export function formatUsdMicros(micros: number): string {
  const amount = Math.max(0, Math.round(micros));
  if (amount === 0) return "$0.00";
  if (amount < SMALLEST_SHOWN_MICROS) return "<$0.0001";
  if (amount < MICROS_PER_DOLLAR) {
    // Rounded to four places in integers, so 0.99996 does not print as "$0.10000".
    const tenThousandths = Math.round(amount / SMALLEST_SHOWN_MICROS);
    if (tenThousandths < 10_000) return `$0.${String(tenThousandths).padStart(4, "0")}`;
  }
  const cents = Math.round(amount / 10_000);
  return `$${grouped(Math.floor(cents / 100))}.${String(cents % 100).padStart(2, "0")}`;
}

export interface CostCellInput {
  costMicros: number;
  calls: number;
  /** Every call counted here went to a provider the price table charges nothing for. */
  free: boolean;
  /** How many of the calls the price table cannot price. Defaults to none. */
  unpricedCalls?: number;
}

/**
 * What a cost cell says. No calls is a dash, not a price. Calls the price
 * table cannot price are never shown as a zero: all of them unpriced is
 * "unpriced", some of them makes the figure a lower bound, "≥ $0.0014". A
 * free provider is "free", so its zero does not read as a measurement.
 * Anything else is the estimate in dollars.
 */
export function formatCostCell({
  costMicros,
  calls,
  free,
  unpricedCalls = 0,
}: CostCellInput): string {
  if (calls <= 0) return "–";
  if (unpricedCalls >= calls) return "unpriced";
  if (unpricedCalls > 0) return `≥ ${formatUsdMicros(costMicros)}`;
  if (costMicros > 0) return formatUsdMicros(costMicros);
  return free ? "free" : formatUsdMicros(0);
}

/** "15%" for part of a whole, rounded; null when the whole is not positive. */
export function formatPercent(part: number, whole: number): string | null {
  if (!(whole > 0) || !Number.isFinite(part)) return null;
  return `${Math.round((part / whole) * 100)}%`;
}

/** "850 ms" under a second, "1.4 s" under a minute, "2 min 5 s" beyond. */
export function formatDurationMs(durationMs: number): string {
  const ms = Math.max(0, Math.round(durationMs));
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1_000);
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/**
 * How long ago `then` was: "just now" under a minute, then whole minutes,
 * hours and days, rounded down. An instant in the future is "just now".
 */
export function formatAge(then: Date, now: Date): string {
  const minutes = Math.floor((now.getTime() - then.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/** "1 Oct 2026, 11:03:07 am" in the zone. */
export function formatDateTimeIn(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone,
  }).format(instant);
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * "2 Sep" for an ISO calendar date, read as that date and nothing else. The
 * month names are fixed here, not taken from the runtime's locale data, which
 * differs between Node versions. Anything that is not an ISO date comes back
 * unchanged.
 */
export function formatShortDate(isoDate: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(isoDate);
  const month = match === null ? undefined : MONTHS[Number(match[1]) - 1];
  if (match === null || month === undefined) return isoDate;
  return `${Number(match[2])} ${month}`;
}
