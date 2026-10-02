import { describe, expect, it } from "vitest";
import { SYDNEY } from "./day-ranges";
import {
  toUsageView,
  type UsageCallInput,
  type UsageDashboardInput,
  type UsageSummaryInput,
} from "./usage-view";

const NOW = new Date("2026-10-01T01:00:00.000Z");
const at = (iso: string) => new Date(iso);

const noUsage: UsageSummaryInput = {
  providers: [],
  totals: {
    calls: 0,
    ok: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    costMicros: 0,
    unpricedCalls: 0,
  },
};

const retailerUsage = {
  provider: "retailer",
  calls: 1_200,
  ok: 1_200,
  failed: 0,
  inputTokens: 0,
  outputTokens: 0,
  costMicros: 0,
  unpricedCalls: 0,
};

const monthUsage: UsageSummaryInput = {
  providers: [
    {
      provider: "gemini",
      calls: 2,
      ok: 1,
      failed: 1,
      inputTokens: 1_532,
      outputTokens: 360,
      costMicros: 1_360,
      unpricedCalls: 0,
    },
    retailerUsage,
  ],
  totals: {
    calls: 1_202,
    ok: 1_201,
    failed: 1,
    inputTokens: 1_532,
    outputTokens: 360,
    costMicros: 1_360,
    unpricedCalls: 0,
  },
};

const geminiCall: UsageCallInput = {
  id: "a",
  provider: "gemini",
  operation: "generate_content",
  calledAt: at("2026-09-30T23:30:00.000Z"),
  outcome: "ok",
  errorKind: null,
  httpStatus: 200,
  durationMs: 1_440,
  model: "gemini-3.5-flash-lite",
  inputTokens: 766,
  outputTokens: 180,
  costMicros: 680,
  priced: true,
  retailerSlug: "the-good-guys",
};

const blockedCall: UsageCallInput = {
  ...geminiCall,
  id: "b",
  provider: "retailer",
  operation: "page",
  outcome: "failed",
  errorKind: "blocked",
  httpStatus: 403,
  durationMs: 90,
  model: null,
  inputTokens: null,
  outputTokens: null,
  costMicros: 0,
  retailerSlug: "bing-lee",
};

const searchCall: UsageCallInput = {
  ...blockedCall,
  id: "c",
  provider: "serpapi",
  operation: "google_shopping",
  errorKind: "network",
  httpStatus: null,
  retailerSlug: null,
};

const DAYS = ["2026-09-29", "2026-09-30", "2026-10-01"];

const dashboard: UsageDashboardInput = {
  now: NOW,
  timeZone: SYDNEY,
  today: noUsage,
  monthToDate: monthUsage,
  daily: {
    days: DAYS,
    rows: [
      { day: "2026-09-30", provider: "gemini", calls: 2, costMicros: 1_360, unpricedCalls: 0 },
      { day: "2026-09-30", provider: "retailer", calls: 5, costMicros: 0, unpricedCalls: 0 },
      { day: "2026-10-01", provider: "retailer", calls: 1, costMicros: 0, unpricedCalls: 0 },
    ],
  },
  recent: [geminiCall, blockedCall, searchCall],
  lastOk: [
    { provider: "retailer", retailerSlug: "jb-hi-fi", lastOkAt: at("2026-09-30T22:00:00.000Z") },
    { provider: "serpapi", retailerSlug: null, lastOkAt: at("2026-09-28T01:00:00.000Z") },
  ],
};

const empty: UsageDashboardInput = {
  ...dashboard,
  today: noUsage,
  monthToDate: noUsage,
  daily: { days: DAYS, rows: [] },
  recent: [],
  lastOk: [],
};

describe("toUsageView", () => {
  it("reports an empty ledger as empty, with no chart and no totals", () => {
    expect(toUsageView(empty)).toEqual({
      empty: true,
      timeZone: SYDNEY,
      dayCount: 3,
      today: { rows: [], totals: null, unpricedNote: null },
      monthToDate: { rows: [], totals: null, unpricedNote: null },
      chart: null,
      recent: [],
      lastOk: [],
    });
  });

  it("is not empty when only older calls exist", () => {
    const view = toUsageView({ ...empty, recent: dashboard.recent });
    expect(view.empty).toBe(false);
    expect(view.chart).toBeNull();
    expect(view.today.totals).toBeNull();
  });

  it("gives a row per provider and a totals row, free providers as free and sub-cent costs in full", () => {
    const { monthToDate } = toUsageView(dashboard);
    expect(monthToDate.rows).toEqual([
      {
        key: "gemini",
        label: "Gemini",
        calls: "2",
        ok: "1",
        failed: "1",
        hasFailures: true,
        tokensIn: "1,532",
        tokensOut: "360",
        cost: "$0.0014",
      },
      {
        key: "retailer",
        label: "Retailer pages",
        calls: "1,200",
        ok: "1,200",
        failed: "0",
        hasFailures: false,
        tokensIn: "–",
        tokensOut: "–",
        cost: "free",
      },
    ]);
    expect(monthToDate.totals).toMatchObject({
      label: "Total",
      calls: "1,202",
      failed: "1",
      tokensIn: "1,532",
      cost: "$0.0014",
    });
    expect(monthToDate.unpricedNote).toBeNull();
  });

  it("totals a period of only free providers as free, and keeps an unknown provider's name", () => {
    const wayback = { ...retailerUsage, provider: "wayback", calls: 3, ok: 3 };
    const unknown = { ...retailerUsage, provider: "openai", calls: 1, ok: 1 };
    const totals = { ...noUsage.totals, calls: 4, ok: 4 };

    const freeOnly = toUsageView({ ...dashboard, today: { providers: [wayback], totals } });
    expect(freeOnly.today.rows[0].label).toBe("Wayback Machine");
    expect(freeOnly.today.totals?.cost).toBe("free");

    const mixed = toUsageView({ ...dashboard, today: { providers: [wayback, unknown], totals } });
    expect(mixed.today.rows[1]).toMatchObject({ label: "openai", cost: "$0.00" });
    expect(mixed.today.totals?.cost).toBe("$0.00");
  });

  describe("unpriced calls", () => {
    const gemini = monthUsage.providers[0];

    it("shows a provider whose every call is unpriced as unpriced, and the total as a lower bound", () => {
      const { monthToDate } = toUsageView({
        ...dashboard,
        monthToDate: {
          providers: [{ ...gemini, costMicros: 0, unpricedCalls: 2 }, retailerUsage],
          totals: { ...monthUsage.totals, costMicros: 0, unpricedCalls: 2 },
        },
      });
      expect(monthToDate.rows[0].cost).toBe("unpriced");
      expect(monthToDate.rows[1].cost).toBe("free");
      expect(monthToDate.totals?.cost).toBe("≥ $0.00");
      expect(monthToDate.unpricedNote).toBe(
        "2 calls used a model with no price in the price table. They are counted but add nothing to the cost, so a figure marked ≥ is a lower bound.",
      );
    });

    it("shows a provider with some unpriced calls as a lower bound, and counts one call in the singular", () => {
      const { monthToDate } = toUsageView({
        ...dashboard,
        monthToDate: {
          providers: [{ ...gemini, costMicros: 680, unpricedCalls: 1 }, retailerUsage],
          totals: { ...monthUsage.totals, costMicros: 680, unpricedCalls: 1 },
        },
      });
      expect(monthToDate.rows[0].cost).toBe("≥ $0.0007");
      expect(monthToDate.totals?.cost).toBe("≥ $0.0007");
      expect(monthToDate.unpricedNote).toMatch(/^1 call used a model/);
    });

    it("shows an unpriced recent call as unpriced, never as a zero or free", () => {
      const [call] = toUsageView({
        ...dashboard,
        recent: [{ ...geminiCall, model: "gemini-9-ultra", costMicros: 0, priced: false }],
      }).recent;
      expect(call.cost).toBe("unpriced");
      expect(call.model).toBe("gemini-9-ultra");
    });

    it("marks a chart day and the window as a lower bound, or as unpriced when nothing was priced", () => {
      const { chart } = toUsageView({
        ...dashboard,
        daily: {
          days: DAYS,
          rows: [
            { day: "2026-09-29", provider: "gemini", calls: 1, costMicros: 0, unpricedCalls: 1 },
            { day: "2026-09-30", provider: "gemini", calls: 3, costMicros: 680, unpricedCalls: 2 },
            { day: "2026-09-30", provider: "retailer", calls: 5, costMicros: 0, unpricedCalls: 0 },
          ],
        },
      });
      expect(chart?.bars.map((bar) => bar.title)).toEqual([
        "29 Sep: 1 call, unpriced",
        "30 Sep: 8 calls, at least $0.0007 estimated",
        "1 Oct: no calls",
      ]);
      expect(chart?.summary).toBe("9 calls, at least $0.0007 estimated over the last 3 days.");
      expect(chart?.activeDays.map((day) => [day.label, day.cost])).toEqual([
        ["30 Sep", "≥ $0.0007"],
        ["29 Sep", "unpriced"],
      ]);
      expect(chart?.unpricedNote).toMatch(/^3 calls used a model/);
    });

    it("says a window of nothing but unpriced calls is unpriced", () => {
      const { chart } = toUsageView({
        ...dashboard,
        daily: {
          days: ["2026-10-01"],
          rows: [
            { day: "2026-10-01", provider: "gemini", calls: 2, costMicros: 0, unpricedCalls: 2 },
          ],
        },
      });
      expect(chart?.summary).toBe("2 calls, unpriced over the last 1 day.");
    });
  });

  it("shapes each recent call: outcome or error kind, status, duration, tokens and cost", () => {
    const [gemini, blocked, search] = toUsageView(dashboard).recent;
    expect(gemini).toMatchObject({
      id: "a",
      calledAt: "2026-09-30T23:30:00.000Z",
      provider: "Gemini",
      operation: "generate_content",
      retailer: "the-good-guys",
      ok: true,
      outcome: "ok",
      httpStatus: "200",
      duration: "1.4 s",
      tokens: "766 in, 180 out",
      model: "gemini-3.5-flash-lite",
      cost: "$0.0007",
    });
    // 23:30 UTC on 30 September is 9:30 am on 1 October in Sydney.
    expect(gemini.calledAtLabel).toMatch(/9:30:00/);
    expect(blocked).toMatchObject({
      ok: false,
      outcome: "blocked",
      httpStatus: "403",
      duration: "90 ms",
      tokens: "–",
      cost: "free",
      retailer: "bing-lee",
    });
    expect(search).toMatchObject({ outcome: "network", httpStatus: "–", retailer: "–" });
  });

  it("prints times in the dashboard's zone, whichever it is", () => {
    const [call] = toUsageView({ ...dashboard, timeZone: "UTC" }).recent;
    expect(call.calledAtLabel).toMatch(/11:30:00/);
    expect(toUsageView({ ...dashboard, timeZone: "UTC" }).timeZone).toBe("UTC");
  });

  it("falls back to failed for a failed call with no kind, and counts a missing token side as zero", () => {
    const [call] = toUsageView({
      ...dashboard,
      recent: [{ ...geminiCall, outcome: "failed", errorKind: null, outputTokens: null }],
    }).recent;
    expect(call.outcome).toBe("failed");
    expect(call.tokens).toBe("766 in, 0 out");
  });

  it("gives the last successful call per provider and retailer with its age", () => {
    expect(toUsageView(dashboard).lastOk).toEqual([
      expect.objectContaining({
        key: "retailer/jb-hi-fi",
        provider: "Retailer pages",
        retailer: "jb-hi-fi",
        lastOkAt: "2026-09-30T22:00:00.000Z",
        age: "3 h ago",
      }),
      expect.objectContaining({
        key: "serpapi/",
        provider: "SerpApi",
        retailer: "any",
        age: "3 days ago",
      }),
    ]);
  });

  it("builds the daily chart with a bar per day of the window", () => {
    const { chart, dayCount } = toUsageView(dashboard);
    expect(dayCount).toBe(3);
    expect(chart?.bars.map((bar) => bar.title)).toEqual([
      "29 Sep: no calls",
      "30 Sep: 7 calls, $0.0014 estimated",
      "1 Oct: 1 call, no cost",
    ]);
    expect(chart?.bars[1].segments).toEqual([
      { provider: "gemini", colourIndex: 0, base: 0, calls: 2 },
      { provider: "retailer", colourIndex: 1, base: 2, calls: 5 },
    ]);
    expect(chart?.legend).toEqual([
      { provider: "gemini", label: "Gemini", colourIndex: 0 },
      { provider: "retailer", label: "Retailer pages", colourIndex: 1 },
    ]);
    expect(chart?.yTicks.map((tick) => tick.label)).toEqual(["0", "2", "4", "6", "8"]);
    expect([chart?.firstDayLabel, chart?.lastDayLabel]).toEqual(["29 Sep", "1 Oct"]);
    expect(chart?.summary).toBe("8 calls, $0.0014 estimated over the last 3 days.");
    expect(chart?.ariaLabel).toBe(
      "Calls per day, stacked by provider. 8 calls, $0.0014 estimated over the last 3 days.",
    );
    expect(chart?.unpricedNote).toBeNull();
    expect(chart?.activeDays).toEqual([
      {
        day: "2026-10-01",
        label: "1 Oct",
        calls: "1",
        cost: "free",
        breakdown: "Retailer pages 1",
      },
      {
        day: "2026-09-30",
        label: "30 Sep",
        calls: "7",
        cost: "$0.0014",
        breakdown: "Gemini 2, Retailer pages 5",
      },
    ]);
  });

  it("leaves the cost out of the chart summary when the window cost nothing", () => {
    const { chart } = toUsageView({
      ...dashboard,
      daily: {
        days: DAYS,
        rows: [
          { day: "2026-10-01", provider: "wayback", calls: 1, costMicros: 0, unpricedCalls: 0 },
        ],
      },
    });
    expect(chart?.summary).toBe("1 call over the last 3 days.");
    expect(chart?.activeDays[0].cost).toBe("free");
  });
});
