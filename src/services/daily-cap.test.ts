import { describe, expect, it, vi } from "vitest";
import { countOkCallsByOperation } from "@/db/queries/api-usage";
import type { QueryDb } from "@/db/queries/db";
import { countOkCallsInLedger, dailyCapOf, usedTodayOf } from "./daily-cap";

vi.mock("@/db/queries/api-usage", () => ({
  countOkCallsByOperation: vi.fn(async () => [{ operation: "responses", count: 2 }]),
}));

const applicationDb = { application: true } as unknown as QueryDb;
vi.mock("./default-db", () => ({ defaultDb: vi.fn(async () => applicationDb) }));

describe("dailyCapOf", () => {
  it("reads a whole non-negative number from the variable", () => {
    expect(dailyCapOf("5", 10)).toEqual({ cap: 5, capSource: "env" });
    expect(dailyCapOf(" 0 ", 10)).toEqual({ cap: 0, capSource: "env" });
  });

  it("falls back to the default when the variable is unset or blank", () => {
    expect(dailyCapOf(undefined, 10)).toEqual({ cap: 10, capSource: "default" });
    expect(dailyCapOf("", 20)).toEqual({ cap: 20, capSource: "default" });
    expect(dailyCapOf("   ", 20)).toEqual({ cap: 20, capSource: "default" });
  });

  it.each(["lots", "-1", "1.5", "1e2x"])("marks %j as invalid and uses the default", (value) => {
    expect(dailyCapOf(value, 10)).toEqual({ cap: 10, capSource: "invalid" });
  });
});

describe("usedTodayOf", () => {
  it("sums the rows of the operations that count and ignores the rest", () => {
    const rows = [
      { operation: "responses", count: 3 },
      { operation: "web_search_call", count: 9 },
      { operation: "account", count: 1 },
    ];
    expect(usedTodayOf(rows, (operation) => operation === "responses")).toBe(3);
    expect(usedTodayOf(rows, () => true)).toBe(13);
    expect(usedTodayOf([], () => true)).toBe(0);
  });
});

describe("countOkCallsInLedger", () => {
  it("runs the ledger query against the handle it is given", async () => {
    const db = {} as QueryDb;
    const period = {
      provider: "openai",
      from: new Date("2026-10-13T00:00:00Z"),
      to: new Date("2026-10-14T00:00:00Z"),
    };
    const rows = await countOkCallsInLedger(period, { db });
    expect(rows).toEqual([{ operation: "responses", count: 2 }]);
    expect(vi.mocked(countOkCallsByOperation)).toHaveBeenCalledWith(db, period);
  });

  it("opens the application database when no handle is given", async () => {
    const period = {
      provider: "serpapi",
      from: new Date("2026-10-13T00:00:00Z"),
      to: new Date("2026-10-14T00:00:00Z"),
    };
    await countOkCallsInLedger(period, {});
    expect(vi.mocked(countOkCallsByOperation)).toHaveBeenCalledWith(applicationDb, period);
  });
});
