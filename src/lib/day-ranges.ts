// Calendar periods as half-open instant ranges, for reading the usage ledger.
// "Today", "month to date" and "the last 30 days" are a person's days, so
// they are computed in a named time zone. Pure: the current instant is always
// passed in.

/** The one zone DealZ shows dates and days in. Defined here and nowhere else. */
export const SYDNEY = "Australia/Sydney";

/** `from` is included, `to` is not. */
export interface InstantRange {
  from: Date;
  to: Date;
}

interface CalendarDate {
  year: number;
  /** 1 to 12. */
  month: number;
  day: number;
}

function wallClockIn(instant: Date, timeZone: string): CalendarDate & { asUtcMs: number } {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((candidate) => candidate.type === type)?.value);
  const year = part("year");
  const month = part("month");
  const day = part("day");
  return {
    year,
    month,
    day,
    asUtcMs: Date.UTC(year, month - 1, day, part("hour"), part("minute"), part("second")),
  };
}

/** How far the zone's wall clock is ahead of UTC at `instant`, in milliseconds. */
function offsetMs(instant: Date, timeZone: string): number {
  // The wall clock has no milliseconds, so compare against the whole second.
  const wholeSecond = Math.floor(instant.getTime() / 1_000) * 1_000;
  return wallClockIn(instant, timeZone).asUtcMs - wholeSecond;
}

function isoDateOf({ year, month, day }: CalendarDate): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** The calendar date at `instant` in the zone, "2026-10-01". */
export function isoDateIn(instant: Date, timeZone: string): string {
  return isoDateOf(wallClockIn(instant, timeZone));
}

/**
 * The instant a calendar date starts in the zone. Date.UTC normalises an
 * overflowing day or month, so "day 32" and "month 13" roll over.
 */
export function startOfDayIn(date: CalendarDate, timeZone: string): Date {
  const asUtc = Date.UTC(date.year, date.month - 1, date.day);
  // The offset at midnight is not known until midnight is: guess with the
  // offset at the UTC reading, then correct once with the offset at the guess.
  // Two passes settle it wherever the daylight-saving change is not at midnight.
  const guess = asUtc - offsetMs(new Date(asUtc), timeZone);
  return new Date(asUtc - offsetMs(new Date(guess), timeZone));
}

/** The zone's calendar day containing `now`: its midnight to the next. */
export function dayRangeIn(now: Date, timeZone: string = SYDNEY): InstantRange {
  const today = wallClockIn(now, timeZone);
  return {
    from: startOfDayIn(today, timeZone),
    to: startOfDayIn({ ...today, day: today.day + 1 }, timeZone),
  };
}

/** From the first of the zone's current month to the end of today in the zone. */
export function monthToDateRangeIn(now: Date, timeZone: string = SYDNEY): InstantRange {
  const today = wallClockIn(now, timeZone);
  return {
    from: startOfDayIn({ ...today, day: 1 }, timeZone),
    to: startOfDayIn({ ...today, day: today.day + 1 }, timeZone),
  };
}

export interface DaysRange extends InstantRange {
  /** Every calendar day in the range, oldest first, "2026-09-02". */
  days: string[];
}

/**
 * The last `count` calendar days in the zone, ending with the day containing
 * `now`: from the first day's midnight to the midnight after today. Each
 * boundary is that day's own midnight, so a day that is 23 or 25 hours long
 * across a daylight-saving change is still one day.
 */
export function lastDaysIn(now: Date, count: number, timeZone: string = SYDNEY): DaysRange {
  const whole = Math.max(1, Math.floor(count));
  const today = wallClockIn(now, timeZone);
  const first = today.day - (whole - 1);
  return {
    from: startOfDayIn({ ...today, day: first }, timeZone),
    to: startOfDayIn({ ...today, day: today.day + 1 }, timeZone),
    // Date.UTC normalises a day below 1 into the month before.
    days: Array.from({ length: whole }, (_, index) =>
      new Date(Date.UTC(today.year, today.month - 1, first + index)).toISOString().slice(0, 10),
    ),
  };
}

/** True for an IANA zone name the runtime knows, such as "Australia/Sydney" or "UTC". */
export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en-AU", { timeZone });
    return true;
  } catch {
    return false;
  }
}
