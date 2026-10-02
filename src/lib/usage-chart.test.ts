import { describe, expect, it } from "vitest";
import { buildDailyChart, type DailyUsageRow } from "./usage-chart";

const DAYS = ["2026-09-29", "2026-09-30", "2026-10-01"];

const rows: DailyUsageRow[] = [
  { day: "2026-09-29", provider: "retailer", calls: 5, costMicros: 0 },
  { day: "2026-09-29", provider: "gemini", calls: 2, costMicros: 1_360 },
  { day: "2026-10-01", provider: "serpapi", calls: 2, costMicros: 0 },
];

describe("buildDailyChart", () => {
  it("returns null for an empty ledger, and when every row is outside the window or empty", () => {
    expect(buildDailyChart(DAYS, [])).toBeNull();
    expect(
      buildDailyChart(DAYS, [{ day: "2026-08-01", provider: "gemini", calls: 9, costMicros: 1 }]),
    ).toBeNull();
    expect(
      buildDailyChart(DAYS, [{ day: "2026-09-29", provider: "gemini", calls: 0, costMicros: 0 }]),
    ).toBeNull();
  });

  it("gives one bar per day, oldest first, with an empty bar for a day without calls", () => {
    const chart = buildDailyChart(DAYS, rows);
    expect(chart?.bars.every((bar) => bar.unpricedCalls === 0)).toBe(true);
    expect(chart?.totalUnpricedCalls).toBe(0);
    expect(chart?.bars.map((bar) => [bar.day, bar.calls, bar.costMicros])).toEqual([
      ["2026-09-29", 7, 1_360],
      ["2026-09-30", 0, 0],
      ["2026-10-01", 2, 0],
    ]);
    expect(chart?.bars[1].segments).toEqual([]);
  });

  it("stacks the providers in name order, each segment on top of the last", () => {
    const chart = buildDailyChart(DAYS, rows);
    expect(chart?.providers).toEqual(["gemini", "retailer", "serpapi"]);
    expect(chart?.bars[0].segments).toEqual([
      { provider: "gemini", calls: 2, costMicros: 1_360, base: 0 },
      { provider: "retailer", calls: 5, costMicros: 0, base: 2 },
    ]);
    expect(chart?.bars[2].segments).toEqual([
      { provider: "serpapi", calls: 2, costMicros: 0, base: 0 },
    ]);
  });

  it("totals the window and ignores rows outside it", () => {
    const chart = buildDailyChart(DAYS, [
      ...rows,
      { day: "2026-09-01", provider: "wayback", calls: 90, costMicros: 0 },
    ]);
    expect(chart?.totalCalls).toBe(9);
    expect(chart?.totalCostMicros).toBe(1_360);
    expect(chart?.providers).not.toContain("wayback");
  });

  it("carries the unpriced calls of each day and of the window", () => {
    const chart = buildDailyChart(DAYS, [
      { day: "2026-09-29", provider: "gemini", calls: 3, costMicros: 680, unpricedCalls: 2 },
      { day: "2026-09-29", provider: "retailer", calls: 5, costMicros: 0, unpricedCalls: 0 },
      { day: "2026-10-01", provider: "gemini", calls: 1, costMicros: 0, unpricedCalls: 1 },
    ]);
    expect(chart?.bars.map((bar) => bar.unpricedCalls)).toEqual([2, 0, 1]);
    expect(chart?.totalUnpricedCalls).toBe(3);
  });

  it("sums two rows for the same day and provider", () => {
    const chart = buildDailyChart(
      ["2026-10-01"],
      [
        { day: "2026-10-01", provider: "gemini", calls: 1, costMicros: 100 },
        { day: "2026-10-01", provider: "gemini", calls: 2, costMicros: 300 },
      ],
    );
    expect(chart?.bars[0].segments).toEqual([
      { provider: "gemini", calls: 3, costMicros: 400, base: 0 },
    ]);
  });

  it.each([
    [1, 4, [0, 1, 2, 3, 4]],
    [4, 4, [0, 1, 2, 3, 4]],
    [7, 8, [0, 2, 4, 6, 8]],
    [9, 20, [0, 5, 10, 15, 20]],
    [37, 40, [0, 10, 20, 30, 40]],
    [41, 80, [0, 20, 40, 60, 80]],
    [90, 200, [0, 50, 100, 150, 200]],
    [1_234, 2_000, [0, 500, 1_000, 1_500, 2_000]],
  ])("puts the axis top for a busiest day of %d calls at %d", (calls, yMax, yTicks) => {
    const chart = buildDailyChart(
      ["2026-10-01"],
      [{ day: "2026-10-01", provider: "retailer", calls, costMicros: 0 }],
    );
    expect(chart?.yMax).toBe(yMax);
    expect(chart?.yTicks).toEqual(yTicks);
    expect(chart?.yMax).toBeGreaterThanOrEqual(calls);
  });
});
