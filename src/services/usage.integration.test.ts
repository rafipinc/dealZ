// The usage service against the real schema in PGlite: what record writes,
// what the reads return, and that the table's own rules still hold behind
// the service.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/db/test-db";
import { DEFAULT_PRICES } from "@/lib/api-prices";
import { SYDNEY } from "@/lib/day-ranges";
import {
  daily,
  dashboard,
  DEFAULT_DASHBOARD_DAYS,
  DEFAULT_DASHBOARD_RECENT_CALLS,
  DEFAULT_RECENT_CALLS,
  lastOk,
  recentCalls,
  record,
  summary,
  type RecordUsageInput,
  type UsageDeps,
} from "./usage";

let t: TestDb;
let deps: UsageDeps;

// The application client, for the one test of the default handle. A getter,
// because the mock is hoisted above the harness being built.
vi.mock("@/db/client", () => ({
  get db() {
    return t.db;
  },
}));

beforeAll(async () => {
  t = await createTestDb();
  deps = { db: t.db };
});

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await t.truncate("api_usage");
});

const at = (iso: string) => new Date(iso);
const VARIANT = "samsung-s85h-65-au";

const pageOk: RecordUsageInput = {
  provider: "retailer",
  operation: "page",
  startedAt: at("2026-09-29T01:00:00.000Z"),
  durationMs: 120,
  outcome: "ok",
  errorKind: null,
  httpStatus: 200,
  model: null,
  inputTokens: null,
  outputTokens: null,
  retailerSlug: "jb-hi-fi",
  variantSlug: VARIANT,
};

const pageBlocked: RecordUsageInput = {
  ...pageOk,
  startedAt: at("2026-09-29T02:00:00.000Z"),
  outcome: "failed",
  errorKind: "blocked",
  httpStatus: 403,
  retailerSlug: "bing-lee",
};

const geminiOk: RecordUsageInput = {
  provider: "gemini",
  operation: "generate_content",
  startedAt: at("2026-09-30T03:00:00.000Z"),
  durationMs: 1_400,
  outcome: "ok",
  errorKind: null,
  httpStatus: 200,
  model: "gemini-3.5-flash-lite",
  inputTokens: 766,
  outputTokens: 180,
  retailerSlug: "the-good-guys",
  variantSlug: VARIANT,
};

const searchOk: RecordUsageInput = {
  provider: "serpapi",
  operation: "google_shopping",
  startedAt: at("2026-09-30T04:00:00.000Z"),
  durationMs: 900,
  outcome: "ok",
  errorKind: null,
  httpStatus: 200,
  model: null,
  inputTokens: null,
  outputTokens: null,
  retailerSlug: null,
  variantSlug: VARIANT,
};

async function seed(...calls: RecordUsageInput[]) {
  for (const call of calls) await record(call, deps);
}

const september = { from: at("2026-09-01T00:00:00.000Z"), to: at("2026-10-01T00:00:00.000Z") };

describe("record", () => {
  it("writes a Gemini call with its estimated cost and returns the stored row", async () => {
    const { call, priced } = await record(geminiOk, deps);

    expect(priced).toBe(true);
    expect(call).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      provider: "gemini",
      operation: "generate_content",
      calledAt: geminiOk.startedAt,
      outcome: "ok",
      errorKind: null,
      httpStatus: 200,
      durationMs: 1_400,
      model: "gemini-3.5-flash-lite",
      inputTokens: 766,
      outputTokens: 180,
      // 766 x 0.30 + 180 x 2.50 micro-dollars, rounded.
      costMicros: 680,
      priced: true,
      retailerSlug: "the-good-guys",
      variantSlug: VARIANT,
    });
    expect(await recentCalls(10, deps)).toEqual([call]);
  });

  it("writes an unknown model at zero cost and says it is unpriced", async () => {
    const { call, priced } = await record({ ...geminiOk, model: "gemini-9-ultra" }, deps);
    expect(priced).toBe(false);
    expect(call.costMicros).toBe(0);
    expect(call.priced).toBe(false);
  });

  it("prices a call by the day it started: gemini-3.8-flash doubles on 2027-01-01", async () => {
    const flash = { ...geminiOk, model: "gemini-3.8-flash", inputTokens: 1_000, outputTokens: 100 };
    const before = await record({ ...flash, startedAt: at("2026-12-31T23:59:59.000Z") }, deps);
    const after = await record({ ...flash, startedAt: at("2027-01-01T00:00:00.000Z") }, deps);
    // 1,000 x 0.75 + 100 x 3.75 = 1,125; then 1,000 x 1.50 + 100 x 7.50 = 2,250.
    expect([before.call.costMicros, after.call.costMicros]).toEqual([1_125, 2_250]);
  });

  it("still prices a failed Gemini call that reported tokens", async () => {
    const { call } = await record(
      { ...geminiOk, outcome: "failed", errorKind: "unparseable" },
      deps,
    );
    expect(call.costMicros).toBe(680);
  });

  it("writes a failed call with its error kind and status", async () => {
    const { call, priced } = await record(pageBlocked, deps);
    expect(call).toMatchObject({
      outcome: "failed",
      errorKind: "blocked",
      httpStatus: 403,
      costMicros: 0,
    });
    expect(priced).toBe(true);
  });

  describe("at the paid SerpApi rate", () => {
    const paid = () => ({
      ...deps,
      prices: { ...DEFAULT_PRICES, serpApiMicrosPerCall: 15_000 },
    });

    it("costs a successful search, on either hop", async () => {
      const hop1 = await record(searchOk, paid());
      const hop2 = await record({ ...searchOk, operation: "google_immersive_product" }, paid());
      expect([hop1.call.costMicros, hop2.call.costMicros]).toEqual([15_000, 15_000]);
      expect((await summary(september, deps)).totals.costMicros).toBe(30_000);
    });

    it("costs a failed search nothing", async () => {
      const { call, priced } = await record(
        { ...searchOk, outcome: "failed", errorKind: "http", httpStatus: 500 },
        paid(),
      );
      expect(call.costMicros).toBe(0);
      expect(priced).toBe(true);
    });

    it("costs the Account API nothing", async () => {
      const { call } = await record({ ...searchOk, operation: "account" }, paid());
      expect(call.costMicros).toBe(0);
    });
  });

  it("stores the fields a call leaves out as null", async () => {
    const { call } = await record(
      {
        provider: "wayback",
        operation: "cdx",
        startedAt: at("2026-09-30T05:00:00.000Z"),
        durationMs: 0,
        outcome: "ok",
      },
      deps,
    );
    expect(call).toMatchObject({
      errorKind: null,
      httpStatus: null,
      model: null,
      inputTokens: null,
      outputTokens: null,
      retailerSlug: null,
      variantSlug: null,
      costMicros: 0,
    });
  });

  it("accepts a SourceCall as a source's meter reports it, with the variant added", async () => {
    const sourceCall = {
      provider: "serpapi" as const,
      operation: "google_immersive_product" as const,
      startedAt: at("2026-09-30T06:00:00.000Z"),
      durationMs: 640,
      outcome: "failed" as const,
      errorKind: "http" as const,
      httpStatus: 500,
      model: null,
      inputTokens: null,
      outputTokens: null,
      retailerSlug: null,
    };
    const { call } = await record({ ...sourceCall, variantSlug: VARIANT }, deps);
    expect(call).toMatchObject({ provider: "serpapi", errorKind: "http", variantSlug: VARIANT });
  });

  it("propagates a database failure as it is", async () => {
    const closed = await createTestDb();
    await closed.close();
    await expect(record(pageOk, { db: closed.db })).rejects.toThrow();
  });

  it("uses the application database when none is injected", async () => {
    const { call } = await record(pageOk);
    expect(await recentCalls()).toEqual([call]);
    expect((await summary(september)).totals.calls).toBe(1);
    expect(await daily({ ...september, timeZone: "UTC" })).toHaveLength(1);
    const board = await dashboard({ now: at("2026-09-29T05:00:00.000Z"), timeZone: SYDNEY });
    expect(board.recent).toEqual([call]);
    expect(await lastOk()).toHaveLength(1);
  });
});

describe("summary", () => {
  it("totals calls, outcomes, tokens and cost per provider and overall", async () => {
    await seed(pageOk, pageBlocked, geminiOk, searchOk);

    expect(await summary(september, deps)).toEqual({
      from: september.from,
      to: september.to,
      providers: [
        {
          provider: "gemini",
          calls: 1,
          ok: 1,
          failed: 0,
          inputTokens: 766,
          outputTokens: 180,
          costMicros: 680,
          unpricedCalls: 0,
        },
        {
          provider: "retailer",
          calls: 2,
          ok: 1,
          failed: 1,
          inputTokens: 0,
          outputTokens: 0,
          costMicros: 0,
          unpricedCalls: 0,
        },
        {
          provider: "serpapi",
          calls: 1,
          ok: 1,
          failed: 0,
          inputTokens: 0,
          outputTokens: 0,
          costMicros: 0,
          unpricedCalls: 0,
        },
      ],
      totals: {
        calls: 4,
        ok: 3,
        failed: 1,
        inputTokens: 766,
        outputTokens: 180,
        costMicros: 680,
        unpricedCalls: 0,
      },
    });
  });

  it("includes `from`, excludes `to`, and is all zeros for an empty period", async () => {
    await seed({ ...pageOk, startedAt: september.from }, { ...pageOk, startedAt: september.to });
    expect((await summary(september, deps)).totals.calls).toBe(1);

    const august = { from: at("2026-08-01T00:00:00.000Z"), to: september.from };
    expect(await summary(august, deps)).toEqual({
      ...august,
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
    });
  });

  it("leaves unpriced calls in the totals and says how many there are", async () => {
    await seed(geminiOk, { ...geminiOk, model: "gemini-9-ultra" }, pageOk);
    const { providers, totals } = await summary(september, deps);

    expect(providers.find((p) => p.provider === "gemini")).toMatchObject({
      calls: 2,
      inputTokens: 1_532,
      costMicros: 680,
      unpricedCalls: 1,
    });
    expect(providers.find((p) => p.provider === "retailer")?.unpricedCalls).toBe(0);
    expect(totals).toMatchObject({ calls: 3, costMicros: 680, unpricedCalls: 1 });
  });

  it("decides what is unpriced from the price table it is given, at read time", async () => {
    await seed({ ...geminiOk, model: "gemini-9-ultra" });
    const known = {
      ...DEFAULT_PRICES,
      geminiTokenPrices: {
        "gemini-9-ultra": [
          { effectiveFrom: null, inputMicrosPerMillion: 1, outputMicrosPerMillion: 1 },
        ],
      },
    };
    expect((await summary(september, deps)).totals.unpricedCalls).toBe(1);
    expect((await summary(september, { ...deps, prices: known })).totals.unpricedCalls).toBe(0);
    expect((await recentCalls(1, { ...deps, prices: known }))[0].priced).toBe(true);
  });
});

describe("daily", () => {
  it("groups by day and provider, oldest day first", async () => {
    await seed(pageOk, pageBlocked, geminiOk, searchOk);
    expect(await daily({ ...september, timeZone: "UTC" }, deps)).toEqual([
      { day: "2026-09-29", provider: "retailer", calls: 2, costMicros: 0, unpricedCalls: 0 },
      { day: "2026-09-30", provider: "gemini", calls: 1, costMicros: 680, unpricedCalls: 0 },
      { day: "2026-09-30", provider: "serpapi", calls: 1, costMicros: 0, unpricedCalls: 0 },
    ]);
  });

  it("buckets by the days of the zone it is given", async () => {
    // 23:30 UTC on 30 September is 09:30 on 1 October in Sydney.
    await seed({ ...pageOk, startedAt: at("2026-09-30T23:30:00.000Z") });
    const wide = { from: at("2026-09-01T00:00:00.000Z"), to: at("2026-11-01T00:00:00.000Z") };
    expect((await daily({ ...wide, timeZone: SYDNEY }, deps)).map((row) => row.day)).toEqual([
      "2026-10-01",
    ]);
    expect((await daily({ ...wide, timeZone: "UTC" }, deps)).map((row) => row.day)).toEqual([
      "2026-09-30",
    ]);
  });

  it("counts the unpriced calls of each day and provider", async () => {
    await seed(
      geminiOk,
      { ...geminiOk, model: "gemini-9-ultra" },
      { ...geminiOk, model: "gemini-9-ultra", startedAt: at("2026-09-29T03:00:00.000Z") },
    );
    expect(await daily({ ...september, timeZone: "UTC" }, deps)).toEqual([
      { day: "2026-09-29", provider: "gemini", calls: 1, costMicros: 0, unpricedCalls: 1 },
      { day: "2026-09-30", provider: "gemini", calls: 2, costMicros: 680, unpricedCalls: 1 },
    ]);
  });

  it("returns nothing for a period without calls", async () => {
    expect(await daily({ ...september, timeZone: SYDNEY }, deps)).toEqual([]);
  });
});

describe("dashboard", () => {
  // 12:00 on 1 October in Sydney (UTC+10: daylight saving starts on the 4th).
  const NOW = at("2026-10-01T02:00:00.000Z");

  it("returns today, month to date, the daily window, recent calls and last ok, all in one zone", async () => {
    await seed(
      // 23:00 on 30 September in Sydney: last month, inside the 30 days.
      { ...pageOk, startedAt: at("2026-09-30T13:00:00.000Z") },
      // 00:30 on 1 October in Sydney: today and this month, though still September in UTC.
      { ...geminiOk, startedAt: at("2026-09-30T14:30:00.000Z") },
      // 11:00 on 1 October in Sydney.
      { ...searchOk, startedAt: at("2026-10-01T01:00:00.000Z") },
      // 1 September in Sydney: outside the 30 days, which begin on the 2nd.
      { ...pageOk, startedAt: at("2026-09-01T02:00:00.000Z") },
    );

    const board = await dashboard({ now: NOW, timeZone: SYDNEY }, deps);

    expect(board.now).toBe(NOW);
    expect(board.timeZone).toBe(SYDNEY);
    expect([board.today.from.toISOString(), board.today.to.toISOString()]).toEqual([
      "2026-09-30T14:00:00.000Z",
      "2026-10-01T14:00:00.000Z",
    ]);
    expect(board.today.providers.map((p) => [p.provider, p.calls])).toEqual([
      ["gemini", 1],
      ["serpapi", 1],
    ]);
    expect(board.monthToDate.from.toISOString()).toBe("2026-09-30T14:00:00.000Z");
    expect(board.monthToDate.totals).toMatchObject({ calls: 2, costMicros: 680 });

    expect(board.daily.days).toHaveLength(30);
    expect([board.daily.days[0], board.daily.days[29]]).toEqual(["2026-09-02", "2026-10-01"]);
    expect(board.daily.from.toISOString()).toBe("2026-09-01T14:00:00.000Z");
    expect(board.daily.to).toEqual(board.today.to);
    expect(board.daily.rows).toEqual([
      { day: "2026-09-30", provider: "retailer", calls: 1, costMicros: 0, unpricedCalls: 0 },
      { day: "2026-10-01", provider: "gemini", calls: 1, costMicros: 680, unpricedCalls: 0 },
      { day: "2026-10-01", provider: "serpapi", calls: 1, costMicros: 0, unpricedCalls: 0 },
    ]);
    // Every row's day is one of the window's days.
    expect(board.daily.rows.every((row) => board.daily.days.includes(row.day))).toBe(true);

    expect(board.recent.map((call) => call.provider)).toEqual([
      "serpapi",
      "gemini",
      "retailer",
      "retailer",
    ]);
    expect(board.lastOk).toEqual([
      {
        provider: "gemini",
        retailerSlug: "the-good-guys",
        lastOkAt: at("2026-09-30T14:30:00.000Z"),
      },
      { provider: "retailer", retailerSlug: "jb-hi-fi", lastOkAt: at("2026-09-30T13:00:00.000Z") },
      { provider: "serpapi", retailerSlug: null, lastOkAt: at("2026-10-01T01:00:00.000Z") },
    ]);
  });

  it("takes the number of days and of recent calls", async () => {
    await seed(pageOk, pageBlocked, geminiOk);
    const board = await dashboard({ now: NOW, timeZone: SYDNEY, days: 2, recentLimit: 1 }, deps);
    expect(board.daily.days).toEqual(["2026-09-30", "2026-10-01"]);
    expect(board.recent).toHaveLength(1);
  });

  it("defaults to thirty days and twenty calls", () => {
    expect([DEFAULT_DASHBOARD_DAYS, DEFAULT_DASHBOARD_RECENT_CALLS]).toEqual([30, 20]);
  });

  it("is all empty for an empty ledger, with the window's days still listed", async () => {
    const board = await dashboard({ now: NOW, timeZone: SYDNEY }, deps);
    expect(board.today.totals.calls).toBe(0);
    expect(board.monthToDate.providers).toEqual([]);
    expect(board.daily.rows).toEqual([]);
    expect(board.daily.days).toHaveLength(30);
    expect(board.recent).toEqual([]);
    expect(board.lastOk).toEqual([]);
  });

  it("marks unpriced calls in every part", async () => {
    await seed({ ...geminiOk, model: "gemini-9-ultra", startedAt: at("2026-10-01T01:00:00.000Z") });
    const board = await dashboard({ now: NOW, timeZone: SYDNEY }, deps);
    expect(board.today.totals.unpricedCalls).toBe(1);
    expect(board.monthToDate.totals.unpricedCalls).toBe(1);
    expect(board.daily.rows[0].unpricedCalls).toBe(1);
    expect(board.recent[0].priced).toBe(false);
  });

  it("propagates a database failure as it is", async () => {
    const closed = await createTestDb();
    await closed.close();
    await expect(dashboard({ now: NOW, timeZone: SYDNEY }, { db: closed.db })).rejects.toThrow();
  });
});

describe("recentCalls", () => {
  it("returns the newest calls first, up to the limit", async () => {
    await seed(pageOk, pageBlocked, geminiOk, searchOk);
    const calls = await recentCalls(3, deps);
    expect(calls.map((call) => call.provider)).toEqual(["serpapi", "gemini", "retailer"]);
    expect(calls[2].retailerSlug).toBe("bing-lee");
  });

  it("defaults to fifty", async () => {
    expect(DEFAULT_RECENT_CALLS).toBe(50);
    await seed(pageOk);
    expect(await recentCalls(undefined, deps)).toHaveLength(1);
  });
});

describe("lastOk", () => {
  it("gives the last ok call per provider and retailer, and nothing for one that never answered", async () => {
    await seed(
      pageOk,
      { ...pageOk, startedAt: at("2026-09-30T09:00:00.000Z") },
      pageBlocked,
      searchOk,
    );
    expect(await lastOk(deps)).toEqual([
      { provider: "retailer", retailerSlug: "jb-hi-fi", lastOkAt: at("2026-09-30T09:00:00.000Z") },
      { provider: "serpapi", retailerSlug: null, lastOkAt: searchOk.startedAt },
    ]);
  });
});

describe("the ledger behind the service", () => {
  it("still rejects an UPDATE of a recorded call", async () => {
    await record(pageOk, deps);
    await expect(t.exec("UPDATE api_usage SET cost_micros = 1")).rejects.toThrow();
  });
});
