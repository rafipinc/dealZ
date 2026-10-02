// Validation only: every case here is refused before the database is asked,
// so the handle is one that fails the test if it is ever touched. The ledger
// itself is tested against PGlite in usage.integration.test.ts.

import { describe, expect, it } from "vitest";
import type { QueryDb } from "@/db/queries/db";
import { ValidationError } from "./errors";
import {
  daily,
  dashboard,
  MAX_DASHBOARD_DAYS,
  MAX_RECENT_CALLS,
  recentCalls,
  record,
  summary,
  type DailyUsageInput,
  type RecordUsageInput,
  type UsageDashboardInput,
  type UsagePeriodInput,
} from "./usage";

const untouchable = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`The database was used: ${String(property)}`);
    },
  },
) as QueryDb;
const deps = { db: untouchable };

const okCall: RecordUsageInput = {
  provider: "retailer",
  operation: "page",
  startedAt: new Date("2026-10-01T01:00:00.000Z"),
  durationMs: 120,
  outcome: "ok",
  errorKind: null,
  httpStatus: 200,
  model: null,
  inputTokens: null,
  outputTokens: null,
  retailerSlug: "jb-hi-fi",
  variantSlug: "samsung-s85h-65-au",
};

async function validationErrorFrom(promise: Promise<unknown>): Promise<ValidationError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw new Error(`Expected a ValidationError, got ${String(error)}`);
  }
  throw new Error("Expected a rejection");
}

describe("record validation", () => {
  it.each<[string, Partial<Record<keyof RecordUsageInput, unknown>>]>([
    ["a provider outside the known set", { provider: "openai" }],
    ["an empty operation", { operation: "" }],
    ["a start that is not a date", { startedAt: "2026-10-01" }],
    ["an invalid date", { startedAt: new Date("nope") }],
    ["a negative duration", { durationMs: -1 }],
    ["a fractional duration", { durationMs: 1.5 }],
    ["an outcome outside ok and failed", { outcome: "timeout" }],
    ["an ok call with an error kind", { errorKind: "http" }],
    ["a failed call with no error kind", { outcome: "failed" }],
    ["an error kind outside the known set", { outcome: "failed", errorKind: "timeout" }],
    ["negative input tokens", { inputTokens: -1 }],
    ["negative output tokens", { outputTokens: -1 }],
    ["an empty model", { model: "" }],
    ["a retailer that is not a slug", { retailerSlug: "JB Hi-Fi" }],
    ["a variant that is not a slug", { variantSlug: "https://example.com/tv" }],
  ])("rejects %s without touching the database", async (_name, patch) => {
    const error = await validationErrorFrom(
      record({ ...okCall, ...patch } as RecordUsageInput, deps),
    );
    expect(error.code).toBe("validation");
    expect(error.issues).toBeDefined();
  });

  it("rejects a call with required fields missing", async () => {
    await validationErrorFrom(record({} as RecordUsageInput, deps));
  });
});

describe("period validation", () => {
  const from = new Date("2026-09-01T00:00:00.000Z");
  const to = new Date("2026-10-01T00:00:00.000Z");

  it.each<[string, unknown]>([
    ["a period that ends before it starts", { from: to, to: from }],
    ["an empty period", { from, to: from }],
    ["a bound that is not a date", { from: "2026-09-01", to }],
    ["a missing bound", { from }],
  ])("summary and daily reject %s", async (_name, period) => {
    await validationErrorFrom(summary(period as UsagePeriodInput, deps));
    await validationErrorFrom(
      daily({ ...(period as UsagePeriodInput), timeZone: "Australia/Sydney" }, deps),
    );
  });

  it.each<[string, unknown]>([
    ["an unknown zone", "Mars/Olympus"],
    ["a city without its region", "Sydney"],
    ["an empty zone", ""],
    ["a zone that is not a string", 10],
    ["a missing zone", undefined],
  ])("daily rejects %s without touching the database", async (_name, timeZone) => {
    const error = await validationErrorFrom(daily({ from, to, timeZone } as DailyUsageInput, deps));
    expect(error.message).toBe("Invalid daily time zone");
  });
});

describe("dashboard validation", () => {
  const now = new Date("2026-10-01T02:00:00.000Z");
  const timeZone = "Australia/Sydney";

  it.each<[string, unknown]>([
    ["an unknown zone", { now, timeZone: "Mars/Olympus" }],
    ["a missing zone", { now }],
    ["an instant that is not a date", { now: "2026-10-01", timeZone }],
    ["an invalid date", { now: new Date("nope"), timeZone }],
    ["no days", { now, timeZone, days: 0 }],
    ["a fractional number of days", { now, timeZone, days: 1.5 }],
    ["more days than the maximum", { now, timeZone, days: MAX_DASHBOARD_DAYS + 1 }],
    ["no recent calls", { now, timeZone, recentLimit: 0 }],
    ["more recent calls than the maximum", { now, timeZone, recentLimit: MAX_RECENT_CALLS + 1 }],
  ])("rejects %s without touching the database", async (_name, input) => {
    const error = await validationErrorFrom(dashboard(input as UsageDashboardInput, deps));
    expect(error.message).toBe("Invalid dashboard input");
  });
});

describe("recentCalls validation", () => {
  it.each([0, -1, 1.5, MAX_RECENT_CALLS + 1, Number.NaN])(
    "rejects a limit of %d",
    async (limit) => {
      await validationErrorFrom(recentCalls(limit, deps));
    },
  );
});
