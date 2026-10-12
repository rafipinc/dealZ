import { describe, expect, it } from "vitest";
import { relativeAge } from "./relative-age";

const NOW = new Date("2026-10-08T10:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

describe("relativeAge", () => {
  it.each([
    [hoursAgo(0), "today"],
    [hoursAgo(23), "today"],
    [daysAgo(1), "yesterday"],
    [hoursAgo(47), "yesterday"],
    [daysAgo(2), "2d ago"],
    [daysAgo(3), "3d ago"],
    [daysAgo(6), "6d ago"],
    [daysAgo(7), "1w ago"],
    [daysAgo(13), "1w ago"],
    [daysAgo(14), "2w ago"],
    [daysAgo(29), "4w ago"],
    [daysAgo(30), "1mo ago"],
    [daysAgo(90), "3mo ago"],
    [daysAgo(364), "11mo ago"],
    [daysAgo(365), "1y ago"],
    [daysAgo(800), "2y ago"],
  ])("labels %s at the fixed now as %j", (date, expected) => {
    expect(relativeAge(date, NOW)).toBe(expected);
  });

  it("clamps a date after now to today, so clock skew never shows as the future", () => {
    expect(relativeAge(new Date(NOW.getTime() + 60_000), NOW)).toBe("today");
    expect(relativeAge(daysAgo(-3), NOW)).toBe("today");
  });

  it("counts elapsed days, not calendar days: a row seen under a day ago is today whatever the date", () => {
    // 22:00 the day before, at 10:00: twelve hours, one calendar day.
    expect(relativeAge(new Date("2026-10-07T22:00:00.000Z"), NOW)).toBe("today");
  });
});
