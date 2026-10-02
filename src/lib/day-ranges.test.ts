import { describe, expect, it } from "vitest";
import {
  SYDNEY,
  dayRangeIn,
  isoDateIn,
  isValidTimeZone,
  lastDaysIn,
  monthToDateRangeIn,
  startOfDayIn,
} from "./day-ranges";

const at = (iso: string) => new Date(iso);
const iso = (range: { from: Date; to: Date }) => [range.from.toISOString(), range.to.toISOString()];

describe("isoDateIn", () => {
  it.each([
    // Sydney is UTC+10 in winter: 13:59 UTC is still the same day, 14:00 is the next.
    ["2026-07-01T13:59:59.000Z", "2026-07-01"],
    ["2026-07-01T14:00:00.000Z", "2026-07-02"],
    // UTC+11 in summer: the day turns at 13:00 UTC.
    ["2026-12-31T12:59:59.000Z", "2026-12-31"],
    ["2026-12-31T13:00:00.000Z", "2027-01-01"],
  ])("%s is %s in Sydney", (instant, expected) => {
    expect(isoDateIn(at(instant), SYDNEY)).toBe(expected);
  });

  it("reads the date in UTC when asked", () => {
    expect(isoDateIn(at("2026-07-01T23:59:59.999Z"), "UTC")).toBe("2026-07-01");
  });
});

describe("startOfDayIn", () => {
  it.each([
    // Standard time, UTC+10.
    [{ year: 2026, month: 7, day: 1 }, "2026-06-30T14:00:00.000Z"],
    // Daylight time, UTC+11.
    [{ year: 2026, month: 1, day: 15 }, "2026-01-14T13:00:00.000Z"],
    // The day daylight saving starts (4 October 2026, at 2 am): midnight is still UTC+10.
    [{ year: 2026, month: 10, day: 4 }, "2026-10-03T14:00:00.000Z"],
    // The day after: UTC+11.
    [{ year: 2026, month: 10, day: 5 }, "2026-10-04T13:00:00.000Z"],
    // The day daylight saving ends (5 April 2026, at 3 am): midnight is still UTC+11.
    [{ year: 2026, month: 4, day: 5 }, "2026-04-04T13:00:00.000Z"],
    [{ year: 2026, month: 4, day: 6 }, "2026-04-05T14:00:00.000Z"],
    // Overflow rolls over: 32 December is 1 January.
    [{ year: 2026, month: 12, day: 32 }, "2026-12-31T13:00:00.000Z"],
  ])("%j starts at %s in Sydney", (date, expected) => {
    expect(startOfDayIn(date, SYDNEY).toISOString()).toBe(expected);
  });

  it("is plain midnight in UTC", () => {
    expect(startOfDayIn({ year: 2026, month: 10, day: 1 }, "UTC").toISOString()).toBe(
      "2026-10-01T00:00:00.000Z",
    );
  });
});

describe("dayRangeIn", () => {
  it("is Sydney's day, not UTC's: early morning in Sydney is still yesterday in UTC", () => {
    // 08:30 on 1 October in Sydney.
    expect(iso(dayRangeIn(at("2026-09-30T22:30:00.000Z")))).toEqual([
      "2026-09-30T14:00:00.000Z",
      "2026-10-01T14:00:00.000Z",
    ]);
  });

  it("contains the instant it was asked about, to the millisecond", () => {
    const now = at("2026-10-01T13:59:59.999Z");
    const range = dayRangeIn(now);
    expect(range.from.getTime()).toBeLessThanOrEqual(now.getTime());
    expect(range.to.getTime()).toBeGreaterThan(now.getTime());
    expect(iso(dayRangeIn(at("2026-10-01T14:00:00.000Z")))[0]).toBe("2026-10-01T14:00:00.000Z");
  });

  it("is 23 hours long the day daylight saving starts and 25 the day it ends", () => {
    const hours = (range: { from: Date; to: Date }) =>
      (range.to.getTime() - range.from.getTime()) / 3_600_000;
    expect(hours(dayRangeIn(at("2026-10-04T02:00:00.000Z")))).toBe(23);
    expect(hours(dayRangeIn(at("2026-04-05T02:00:00.000Z")))).toBe(25);
    expect(hours(dayRangeIn(at("2026-07-01T02:00:00.000Z")))).toBe(24);
  });

  it("takes another zone", () => {
    expect(iso(dayRangeIn(at("2026-10-01T05:00:00.000Z"), "UTC"))).toEqual([
      "2026-10-01T00:00:00.000Z",
      "2026-10-02T00:00:00.000Z",
    ]);
  });
});

describe("monthToDateRangeIn", () => {
  it("runs from the first of Sydney's month to the end of Sydney's today", () => {
    // 11:00 on 15 October in Sydney, daylight time; the month began in standard time.
    expect(iso(monthToDateRangeIn(at("2026-10-15T00:00:00.000Z")))).toEqual([
      "2026-09-30T14:00:00.000Z",
      "2026-10-15T13:00:00.000Z",
    ]);
  });

  it("is in Sydney's new month while UTC is still in the old one", () => {
    // 01:00 on 1 October in Sydney is 15:00 on 30 September in UTC.
    expect(iso(monthToDateRangeIn(at("2026-09-30T15:00:00.000Z")))).toEqual([
      "2026-09-30T14:00:00.000Z",
      "2026-10-01T14:00:00.000Z",
    ]);
  });

  it("ends in the next year on 31 December", () => {
    expect(iso(monthToDateRangeIn(at("2026-12-31T02:00:00.000Z")))).toEqual([
      "2026-11-30T13:00:00.000Z",
      "2026-12-31T13:00:00.000Z",
    ]);
  });

  it("ends at the same instant as today", () => {
    const now = at("2026-10-15T00:00:00.000Z");
    expect(monthToDateRangeIn(now).to).toEqual(dayRangeIn(now).to);
  });
});

describe("lastDaysIn", () => {
  it("lists whole Sydney days ending with Sydney's today, oldest first", () => {
    // 08:30 on 1 October in Sydney; still 30 September in UTC.
    const range = lastDaysIn(at("2026-09-30T22:30:00.000Z"), 3);
    expect(range.days).toEqual(["2026-09-29", "2026-09-30", "2026-10-01"]);
    expect(iso(range)).toEqual(["2026-09-28T14:00:00.000Z", "2026-10-01T14:00:00.000Z"]);
  });

  it("gives thirty days for thirty, reaching back into the month before", () => {
    const range = lastDaysIn(at("2026-10-01T02:00:00.000Z"), 30);
    expect(range.days).toHaveLength(30);
    expect(range.days[0]).toBe("2026-09-02");
    expect(range.days[29]).toBe("2026-10-01");
    expect(range.from.toISOString()).toBe("2026-09-01T14:00:00.000Z");
  });

  it("starts and ends on Sydney midnights on both sides of the start of daylight saving", () => {
    // 12:00 on 10 October in Sydney (UTC+11); the window began in standard time (UTC+10).
    const range = lastDaysIn(at("2026-10-10T01:00:00.000Z"), 30);
    expect(iso(range)).toEqual(["2026-09-10T14:00:00.000Z", "2026-10-10T13:00:00.000Z"]);
    expect(range.days).toHaveLength(30);
    expect(range.days).toContain("2026-10-04");
    // One hour short of thirty 24-hour days: the 4th is 23 hours long.
    expect((range.to.getTime() - range.from.getTime()) / 3_600_000).toBe(30 * 24 - 1);
  });

  it("is an hour longer across the end of daylight saving", () => {
    const range = lastDaysIn(at("2026-04-10T02:00:00.000Z"), 30);
    expect(iso(range)).toEqual(["2026-03-11T13:00:00.000Z", "2026-04-10T14:00:00.000Z"]);
    expect((range.to.getTime() - range.from.getTime()) / 3_600_000).toBe(30 * 24 + 1);
  });

  it("crosses a year boundary", () => {
    expect(lastDaysIn(at("2027-01-01T02:00:00.000Z"), 3).days).toEqual([
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
    ]);
  });

  it("ends where today ends, and covers today alone for a count of one", () => {
    const now = at("2026-10-15T00:00:00.000Z");
    expect(lastDaysIn(now, 30).to).toEqual(dayRangeIn(now).to);
    expect(iso(lastDaysIn(now, 1))).toEqual(iso(dayRangeIn(now)));
  });

  it("never gives less than one day, and takes another zone", () => {
    expect(lastDaysIn(at("2026-10-01T05:30:00.000Z"), 0, "UTC").days).toEqual(["2026-10-01"]);
    expect(lastDaysIn(at("2026-10-01T05:30:00.000Z"), 2.9, "UTC").days).toEqual([
      "2026-09-30",
      "2026-10-01",
    ]);
  });
});

describe("isValidTimeZone", () => {
  it.each([
    ["Australia/Sydney", true],
    ["UTC", true],
    ["America/New_York", true],
    ["Mars/Olympus", false],
    ["Sydney", false],
    ["", false],
    ["   ", false],
  ])("%j is %s", (timeZone, expected) => {
    expect(isValidTimeZone(timeZone)).toBe(expected);
  });
});
