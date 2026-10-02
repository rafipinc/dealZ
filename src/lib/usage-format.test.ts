import { describe, expect, it } from "vitest";
import {
  formatAge,
  formatCostCell,
  formatCount,
  formatDateTimeIn,
  formatDurationMs,
  formatPercent,
  formatShortDate,
  formatUsdMicros,
} from "./usage-format";

describe("formatCount", () => {
  it.each([
    [0, "0"],
    [999, "999"],
    [1_000, "1,000"],
    [1_234_567, "1,234,567"],
    [12.6, "13"],
  ])("%d is %s", (count, expected) => {
    expect(formatCount(count)).toBe(expected);
  });
});

describe("formatUsdMicros", () => {
  it.each([
    [0, "$0.00"],
    // Below a hundredth of a cent: never shown as zero.
    [1, "<$0.0001"],
    [99, "<$0.0001"],
    [100, "$0.0001"],
    // One recorded Gemini page read.
    [680, "$0.0007"],
    [1_200, "$0.0012"],
    [1_250, "$0.0013"],
    // A cent, and a SerpApi call on the paid tier.
    [10_000, "$0.0100"],
    [15_000, "$0.0150"],
    [512_345, "$0.5123"],
    // Rounds up to a dollar rather than printing five digits.
    [999_960, "$1.00"],
    [1_000_000, "$1.00"],
    [1_234_567, "$1.23"],
    [12_345_678, "$12.35"],
    [1_234_567_890, "$1,234.57"],
    // Never negative, always whole micros.
    [-500, "$0.00"],
    [680.4, "$0.0007"],
  ])("%d micro-dollars is %s", (micros, expected) => {
    expect(formatUsdMicros(micros)).toBe(expected);
  });
});

describe("formatCostCell", () => {
  it.each([
    ["a dash when there were no calls", { costMicros: 0, calls: 0, free: true }, "–"],
    [
      "a dash with no calls even for a paid provider",
      { costMicros: 0, calls: 0, free: false },
      "–",
    ],
    ["free for a free provider that was called", { costMicros: 0, calls: 12, free: true }, "free"],
    ["the estimate for a paid provider", { costMicros: 680, calls: 1, free: false }, "$0.0007"],
    [
      "a zero in dollars for a paid provider whose calls cost nothing",
      { costMicros: 0, calls: 3, free: false },
      "$0.00",
    ],
    [
      "the estimate when a provider marked free has a cost recorded",
      { costMicros: 15_000, calls: 1, free: true },
      "$0.0150",
    ],
    [
      "unpriced when every call is on a model with no price",
      { costMicros: 0, calls: 3, free: false, unpricedCalls: 3 },
      "unpriced",
    ],
    [
      "unpriced, never free, even for a provider marked free",
      { costMicros: 0, calls: 1, free: true, unpricedCalls: 1 },
      "unpriced",
    ],
    [
      "a lower bound when some calls are unpriced",
      { costMicros: 1_360, calls: 5, free: false, unpricedCalls: 2 },
      "≥ $0.0014",
    ],
    [
      "a lower bound of zero when the priced calls cost nothing",
      { costMicros: 0, calls: 5, free: true, unpricedCalls: 1 },
      "≥ $0.00",
    ],
    [
      "a dash with no calls, whatever the unpriced count says",
      { costMicros: 0, calls: 0, free: false, unpricedCalls: 2 },
      "–",
    ],
  ])("is %s", (_name, input, expected) => {
    expect(formatCostCell(input)).toBe(expected);
  });
});

describe("formatPercent", () => {
  it.each([
    [38, 250, "15%"],
    [0, 250, "0%"],
    [250, 250, "100%"],
    [1, 3, "33%"],
    [300, 250, "120%"],
  ])("%d of %d is %s", (part, whole, expected) => {
    expect(formatPercent(part, whole)).toBe(expected);
  });

  it.each([
    [5, 0],
    [5, -1],
    [Number.NaN, 10],
    [5, Number.NaN],
  ])("%d of %d has no percentage", (part, whole) => {
    expect(formatPercent(part, whole)).toBeNull();
  });
});

describe("formatDurationMs", () => {
  it.each([
    [0, "0 ms"],
    [850, "850 ms"],
    [999, "999 ms"],
    [1_000, "1.0 s"],
    [1_440, "1.4 s"],
    [59_940, "59.9 s"],
    [60_000, "1 min 0 s"],
    [125_400, "2 min 5 s"],
    [-5, "0 ms"],
  ])("%d is %s", (ms, expected) => {
    expect(formatDurationMs(ms)).toBe(expected);
  });
});

describe("formatAge", () => {
  const now = new Date("2026-10-01T12:00:00.000Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  it.each([
    [0, "just now"],
    [59_999, "just now"],
    [MIN, "1 min ago"],
    [59 * MIN + 59_000, "59 min ago"],
    [HOUR, "1 h ago"],
    [23 * HOUR + 59 * MIN, "23 h ago"],
    [DAY, "1 day ago"],
    [2 * DAY + 5 * HOUR, "2 days ago"],
    [40 * DAY, "40 days ago"],
    // A clock a little ahead is not "minus one minute ago".
    [-5 * MIN, "just now"],
  ])("%d ms ago is %s", (ms, expected) => {
    expect(formatAge(ago(ms), now)).toBe(expected);
  });
});

describe("formatDateTimeIn", () => {
  it("prints the instant on Sydney's clock", () => {
    const text = formatDateTimeIn(new Date("2026-10-01T01:03:07.000Z"), "Australia/Sydney");
    expect(text).toContain("2026");
    expect(text).toContain("Oct");
    expect(text).toMatch(/11:03:07/);
  });
});

describe("formatShortDate", () => {
  it.each([
    ["2026-09-02", "2 Sep"],
    ["2026-10-01", "1 Oct"],
    ["2026-12-31", "31 Dec"],
    ["2026-13-01", "2026-13-01"],
    ["yesterday", "yesterday"],
  ])("%s is %s", (isoDate, expected) => {
    expect(formatShortDate(isoDate)).toBe(expected);
  });
});
