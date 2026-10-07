import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../test-db";
import {
  type ApiUsageInsert,
  countOkCallsByOperation,
  dailyApiUsage,
  insertApiUsage,
  lastOkPerTarget,
  recentApiUsage,
  summariseApiUsage,
} from "./api-usage";

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
});

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await t.truncate("api_usage");
});

const at = (iso: string) => new Date(iso);

const serpOk: ApiUsageInsert = {
  provider: "serpapi",
  operation: "google_shopping",
  outcome: "ok",
  durationMs: 800,
  httpStatus: 200,
  costMicros: 15_000,
  calledAt: at("2026-09-30T02:00:00Z"),
};

const geminiOk: ApiUsageInsert = {
  provider: "gemini",
  operation: "generate_content",
  outcome: "ok",
  durationMs: 1_500,
  httpStatus: 200,
  model: "gemini-flash",
  inputTokens: 4_000,
  outputTokens: 200,
  costMicros: 380,
  retailerSlug: "jb-hi-fi",
  variantSlug: "65-au",
  calledAt: at("2026-09-30T03:00:00Z"),
};

const retailerFailed: ApiUsageInsert = {
  provider: "retailer",
  operation: "page",
  outcome: "failed",
  errorKind: "blocked",
  httpStatus: 403,
  durationMs: 90,
  retailerSlug: "harvey-norman",
  variantSlug: "65-au",
  calledAt: at("2026-09-30T04:00:00Z"),
};

async function seed(...rows: ApiUsageInsert[]) {
  for (const row of rows) await insertApiUsage(t.db, row);
}

const september = { from: at("2026-09-01T00:00:00Z"), to: at("2026-10-01T00:00:00Z") };

describe("insertApiUsage", () => {
  it("returns the stored row with the database defaults filled in", async () => {
    const row = await insertApiUsage(t.db, {
      provider: "wayback",
      operation: "cdx",
      outcome: "ok",
      durationMs: 300,
    });

    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.costMicros).toBe(0);
    expect(row.calledAt).toBeInstanceOf(Date);
    expect(row.errorKind).toBeNull();
    expect(row.retailerSlug).toBeNull();
  });

  it("surfaces a constraint violation instead of swallowing it", async () => {
    await expect(insertApiUsage(t.db, { ...serpOk, durationMs: -1 })).rejects.toThrow();
    expect(await recentApiUsage(t.db, 10)).toEqual([]);
  });
});

describe("summariseApiUsage", () => {
  it("counts calls, outcomes, tokens and cost per provider", async () => {
    await seed(
      serpOk,
      geminiOk,
      { ...geminiOk, inputTokens: 1_000, outputTokens: 50, costMicros: 120 },
      {
        ...geminiOk,
        outcome: "failed",
        errorKind: "http",
        httpStatus: 500,
        costMicros: 0,
        inputTokens: null,
        outputTokens: null,
      },
      retailerFailed,
    );

    expect(await summariseApiUsage(t.db, september)).toEqual([
      {
        provider: "gemini",
        calls: 3,
        ok: 2,
        failed: 1,
        inputTokens: 5_000,
        outputTokens: 250,
        costMicros: 500,
      },
      {
        provider: "retailer",
        calls: 1,
        ok: 0,
        failed: 1,
        inputTokens: 0,
        outputTokens: 0,
        costMicros: 0,
      },
      {
        provider: "serpapi",
        calls: 1,
        ok: 1,
        failed: 0,
        inputTokens: 0,
        outputTokens: 0,
        costMicros: 15_000,
      },
    ]);
  });

  it("includes from and excludes to", async () => {
    await seed(
      { ...serpOk, calledAt: september.from },
      { ...serpOk, calledAt: september.to },
      { ...serpOk, calledAt: at("2026-08-31T23:59:59Z") },
    );

    const summary = await summariseApiUsage(t.db, september);
    expect(summary).toHaveLength(1);
    expect(summary[0].calls).toBe(1);
  });

  it("returns nothing for an empty period", async () => {
    expect(await summariseApiUsage(t.db, september)).toEqual([]);
  });
});

describe("dailyApiUsage", () => {
  const wide = { from: at("2026-09-01T00:00:00Z"), to: at("2026-11-01T00:00:00Z") };

  it("groups by day and provider, oldest day first", async () => {
    await seed(
      { ...serpOk, calledAt: at("2026-09-29T23:59:59Z") },
      { ...serpOk, calledAt: at("2026-09-30T00:00:00Z") },
      { ...serpOk, calledAt: at("2026-09-30T10:00:00Z") },
      geminiOk,
      { ...serpOk, calledAt: at("2026-10-01T00:00:00Z") }, // outside the period
    );

    expect(await dailyApiUsage(t.db, { ...september, timeZone: "UTC" })).toEqual([
      { day: "2026-09-29", provider: "serpapi", calls: 1, costMicros: 15_000 },
      { day: "2026-09-30", provider: "gemini", calls: 1, costMicros: 380 },
      { day: "2026-09-30", provider: "serpapi", calls: 2, costMicros: 30_000 },
    ]);
  });

  it("puts a late-evening UTC call on the next day in Australia/Sydney", async () => {
    await seed({ ...serpOk, calledAt: at("2026-09-30T23:30:00Z") });

    const sydney = await dailyApiUsage(t.db, { ...wide, timeZone: "Australia/Sydney" });
    const utc = await dailyApiUsage(t.db, { ...wide, timeZone: "UTC" });

    expect(sydney.map((r) => r.day)).toEqual(["2026-10-01"]);
    expect(utc.map((r) => r.day)).toEqual(["2026-09-30"]);
  });

  it("follows the Sydney daylight-saving change on 2026-10-04", async () => {
    // Midnight in Sydney is 14:00Z before the change and 13:00Z after it.
    await seed(
      { ...serpOk, calledAt: at("2026-10-03T13:30:00Z") }, // 23:30 AEST on the 3rd
      { ...serpOk, calledAt: at("2026-10-03T14:30:00Z") }, // 00:30 AEST on the 4th
      { ...serpOk, calledAt: at("2026-10-04T12:30:00Z") }, // 23:30 AEDT on the 4th
      { ...serpOk, calledAt: at("2026-10-04T13:30:00Z") }, // 00:30 AEDT on the 5th
    );

    const rows = await dailyApiUsage(t.db, { ...wide, timeZone: "Australia/Sydney" });

    expect(rows.map((r) => [r.day, r.calls])).toEqual([
      ["2026-10-03", 1],
      ["2026-10-04", 2],
      ["2026-10-05", 1],
    ]);
  });

  it("keeps from inclusive and to exclusive as instants, whatever the timezone", async () => {
    await seed({ ...serpOk, calledAt: september.from }, { ...serpOk, calledAt: september.to });

    const rows = await dailyApiUsage(t.db, { ...september, timeZone: "Australia/Sydney" });

    expect(rows).toEqual([
      { day: "2026-09-01", provider: "serpapi", calls: 1, costMicros: 15_000 },
    ]);
  });

  it("rejects an unknown timezone instead of falling back to UTC", async () => {
    await seed(serpOk);

    const error = await dailyApiUsage(t.db, { ...wide, timeZone: "Mars/Olympus" }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).not.toBeNull();
    // Drizzle wraps the driver error; the Postgres message is on the cause.
    const messages = [error, (error as { cause?: unknown }).cause].map((e) =>
      String((e as Error | undefined)?.message),
    );
    expect(messages.join(" ")).toContain('time zone "Mars/Olympus" not recognized');
  });
});

describe("countOkCallsByOperation", () => {
  const serpSeptember = { provider: "serpapi", ...september };

  it("counts successful calls per operation, ordered by operation", async () => {
    await seed(
      serpOk,
      serpOk,
      { ...serpOk, operation: "account" },
      { ...serpOk, operation: "google_product" },
    );

    expect(await countOkCallsByOperation(t.db, serpSeptember)).toEqual([
      { operation: "account", count: 1 },
      { operation: "google_product", count: 1 },
      { operation: "google_shopping", count: 2 },
    ]);
  });

  it("leaves failed calls out, so a failure does not count as spent quota", async () => {
    await seed(
      serpOk,
      { ...serpOk, outcome: "failed", errorKind: "http", httpStatus: 500 },
      {
        ...serpOk,
        operation: "account",
        outcome: "failed",
        errorKind: "network",
        httpStatus: null,
      },
    );

    expect(await countOkCallsByOperation(t.db, serpSeptember)).toEqual([
      { operation: "google_shopping", count: 1 },
    ]);
  });

  it("leaves other providers out", async () => {
    await seed(serpOk, geminiOk, { ...geminiOk, operation: "google_shopping" });

    expect(await countOkCallsByOperation(t.db, serpSeptember)).toEqual([
      { operation: "google_shopping", count: 1 },
    ]);
  });

  it("includes a call at from and excludes a call at to", async () => {
    await seed(
      { ...serpOk, calledAt: september.from },
      { ...serpOk, calledAt: september.to },
      { ...serpOk, calledAt: at("2026-08-31T23:59:59Z") },
    );

    expect(await countOkCallsByOperation(t.db, serpSeptember)).toEqual([
      { operation: "google_shopping", count: 1 },
    ]);
  });

  it("returns nothing for an empty period", async () => {
    await seed({ ...serpOk, calledAt: at("2026-10-02T00:00:00Z") });

    expect(await countOkCallsByOperation(t.db, serpSeptember)).toEqual([]);
  });
});

describe("recentApiUsage", () => {
  it("returns the newest calls first, up to the limit", async () => {
    await seed(serpOk, retailerFailed, geminiOk);

    const recent = await recentApiUsage(t.db, 2);
    expect(recent.map((r) => r.provider)).toEqual(["retailer", "gemini"]);
    expect(recent[0].errorKind).toBe("blocked");
  });
});

describe("lastOkPerTarget", () => {
  it("returns the latest ok call per provider and retailer, ignoring failures", async () => {
    await seed(
      { ...geminiOk, calledAt: at("2026-09-28T03:00:00Z") },
      geminiOk,
      { ...geminiOk, retailerSlug: "the-good-guys", calledAt: at("2026-09-29T03:00:00Z") },
      {
        ...geminiOk,
        outcome: "failed",
        errorKind: "network",
        calledAt: at("2026-09-30T09:00:00Z"),
      },
      retailerFailed,
      serpOk,
    );

    expect(await lastOkPerTarget(t.db)).toEqual([
      { provider: "gemini", retailerSlug: "jb-hi-fi", lastOkAt: at("2026-09-30T03:00:00Z") },
      { provider: "gemini", retailerSlug: "the-good-guys", lastOkAt: at("2026-09-29T03:00:00Z") },
      { provider: "serpapi", retailerSlug: null, lastOkAt: at("2026-09-30T02:00:00Z") },
    ]);
  });

  it("ignores the status check's own account call, which says nothing about searches", async () => {
    await seed(serpOk, { ...serpOk, operation: "account", calledAt: at("2026-10-01T05:00:00Z") });

    expect(await lastOkPerTarget(t.db)).toEqual([
      { provider: "serpapi", retailerSlug: null, lastOkAt: at("2026-09-30T02:00:00Z") },
    ]);
  });
});
