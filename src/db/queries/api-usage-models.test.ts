import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../test-db";
import { dailyApiUsage, insertApiUsage, type ApiUsageInsert } from "./api-usage";
import { modelCallsByDay } from "./api-usage-models";

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

const gemini = (model: string, calledAt: string): ApiUsageInsert => ({
  provider: "gemini",
  operation: "generate_content",
  outcome: "ok",
  durationMs: 1_000,
  model,
  calledAt: at(calledAt),
});

const page = (calledAt: string): ApiUsageInsert => ({
  provider: "retailer",
  operation: "page",
  outcome: "ok",
  durationMs: 100,
  calledAt: at(calledAt),
});

const wide = { from: at("2026-09-01T00:00:00Z"), to: at("2026-11-01T00:00:00Z") };

async function seed(...rows: ApiUsageInsert[]) {
  for (const row of rows) await insertApiUsage(t.db, row);
}

describe("modelCallsByDay", () => {
  it("counts calls per day, provider and model, with a null model for a provider without one", async () => {
    await seed(
      gemini("gemini-3.5-flash-lite", "2026-09-29T01:00:00Z"),
      gemini("gemini-3.5-flash-lite", "2026-09-29T02:00:00Z"),
      gemini("gemini-9-ultra", "2026-09-29T03:00:00Z"),
      page("2026-09-29T04:00:00Z"),
      gemini("gemini-9-ultra", "2026-09-30T03:00:00Z"),
    );

    expect(await modelCallsByDay(t.db, { ...wide, timeZone: "UTC" })).toEqual([
      { day: "2026-09-29", provider: "gemini", model: "gemini-3.5-flash-lite", calls: 2 },
      { day: "2026-09-29", provider: "gemini", model: "gemini-9-ultra", calls: 1 },
      { day: "2026-09-29", provider: "retailer", model: null, calls: 1 },
      { day: "2026-09-30", provider: "gemini", model: "gemini-9-ultra", calls: 1 },
    ]);
  });

  it("buckets by the days of the timezone, across the Sydney daylight-saving change", async () => {
    await seed(
      page("2026-10-03T13:30:00Z"), // 23:30 AEST on the 3rd
      page("2026-10-03T14:30:00Z"), // 00:30 AEST on the 4th
      page("2026-10-04T13:30:00Z"), // 00:30 AEDT on the 5th
    );
    const rows = await modelCallsByDay(t.db, { ...wide, timeZone: "Australia/Sydney" });
    expect(rows.map((row) => [row.day, row.calls])).toEqual([
      ["2026-10-03", 1],
      ["2026-10-04", 1],
      ["2026-10-05", 1],
    ]);
  });

  it("lines up with dailyApiUsage: the same days and the same call counts", async () => {
    await seed(
      gemini("gemini-3.5-flash-lite", "2026-09-30T23:30:00Z"),
      gemini("gemini-9-ultra", "2026-09-30T23:45:00Z"),
      page("2026-09-30T12:00:00Z"),
    );
    const period = { ...wide, timeZone: "Australia/Sydney" };
    const byModel = await modelCallsByDay(t.db, period);
    const byDay = await dailyApiUsage(t.db, period);
    for (const row of byDay) {
      const calls = byModel
        .filter((m) => m.day === row.day && m.provider === row.provider)
        .reduce((sum, m) => sum + m.calls, 0);
      expect(calls).toBe(row.calls);
    }
    expect(byDay.map((row) => row.day)).toEqual(["2026-09-30", "2026-10-01"]);
  });

  it("keeps from inclusive and to exclusive, and returns nothing for an empty period", async () => {
    await seed(page("2026-09-01T00:00:00Z"), page("2026-11-01T00:00:00Z"));
    expect(await modelCallsByDay(t.db, { ...wide, timeZone: "UTC" })).toHaveLength(1);
    expect(
      await modelCallsByDay(t.db, {
        from: at("2025-01-01T00:00:00Z"),
        to: at("2025-02-01T00:00:00Z"),
        timeZone: "UTC",
      }),
    ).toEqual([]);
  });

  it("rejects an unknown timezone", async () => {
    await seed(page("2026-09-29T04:00:00Z"));
    await expect(modelCallsByDay(t.db, { ...wide, timeZone: "Mars/Olympus" })).rejects.toThrow();
  });
});
