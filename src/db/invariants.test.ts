// Breaking tests for the database invariants. Each test tries to violate one
// rule and asserts the named constraint or trigger message. The matrix is in
// docs/TESTING.md. Only api_usage is covered so far; the rest of the matrix
// joins this file as further describe blocks on the same harness.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./test-db";

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
});

afterAll(async () => {
  await t.close();
});

/** Runs a statement that must fail and returns the Postgres error it raised. */
async function failure(
  statement: string,
): Promise<{ code?: string; constraint?: string; message: string }> {
  try {
    await t.exec(statement);
  } catch (error) {
    return error as { code?: string; constraint?: string; message: string };
  }
  throw new Error(`expected the statement to be rejected: ${statement}`);
}

const CHECK_VIOLATION = "23514";
const RESTRICT_VIOLATION = "23001";
const INVALID_ENUM_VALUE = "22P02";

describe("migrations", () => {
  it("applies drizzle/migrations to an empty PGlite without error", async () => {
    const result = await t.exec(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'",
    );
    expect(result.rows).toEqual([{ n: 8 }]);
  });
});

describe("api_usage", () => {
  // A valid row with one column overridden, so each test breaks exactly one rule.
  const insert = (overrides: Record<string, string> = {}) => {
    const row: Record<string, string> = {
      provider: "'serpapi'",
      operation: "'google_shopping'",
      outcome: "'ok'",
      duration_ms: "120",
      ...overrides,
    };
    const columns = Object.keys(row).join(", ");
    return `INSERT INTO api_usage (${columns}) VALUES (${Object.values(row).join(", ")})`;
  };

  beforeEach(async () => {
    await t.truncate("api_usage");
  });

  it("accepts a valid ok row and a valid failed row", async () => {
    await t.exec(insert());
    await t.exec(insert({ outcome: "'failed'", error_kind: "'blocked'" }));
    const result = await t.exec("SELECT count(*)::int AS n FROM api_usage");
    expect(result.rows).toEqual([{ n: 2 }]);
  });

  it("rejects UPDATE on api_usage", async () => {
    await t.exec(insert());
    const error = await failure("UPDATE api_usage SET cost_micros = 1");
    expect(error.message).toContain("api_usage is append-only (UPDATE not allowed)");
    expect(error.code).toBe(RESTRICT_VIOLATION);
  });

  it("rejects DELETE on api_usage", async () => {
    await t.exec(insert());
    const error = await failure("DELETE FROM api_usage");
    expect(error.message).toContain("api_usage is append-only (DELETE not allowed)");
    expect(error.code).toBe(RESTRICT_VIOLATION);
  });

  it("rejects a provider that is not a slug", async () => {
    const error = await failure(insert({ provider: "'Serp Api'" }));
    expect(error.constraint).toBe("api_usage_provider_format");
    expect(error.code).toBe(CHECK_VIOLATION);
  });

  it("rejects an outcome outside the enum", async () => {
    const error = await failure(insert({ outcome: "'timeout'" }));
    expect(error.message).toContain("api_call_outcome");
    expect(error.code).toBe(INVALID_ENUM_VALUE);
  });

  it("rejects a failed call with no error_kind", async () => {
    const error = await failure(insert({ outcome: "'failed'" }));
    expect(error.constraint).toBe("api_usage_error_kind_only_when_failed");
    expect(error.code).toBe(CHECK_VIOLATION);
  });

  it("rejects an ok call with an error_kind", async () => {
    const error = await failure(insert({ error_kind: "'http'" }));
    expect(error.constraint).toBe("api_usage_error_kind_only_when_failed");
    expect(error.code).toBe(CHECK_VIOLATION);
  });

  it("rejects a negative duration", async () => {
    const error = await failure(insert({ duration_ms: "-1" }));
    expect(error.constraint).toBe("api_usage_duration_non_negative");
    expect(error.code).toBe(CHECK_VIOLATION);
  });

  it("rejects negative input tokens", async () => {
    const error = await failure(insert({ input_tokens: "-1" }));
    expect(error.constraint).toBe("api_usage_input_tokens_non_negative");
    expect(error.code).toBe(CHECK_VIOLATION);
  });

  it("rejects negative output tokens", async () => {
    const error = await failure(insert({ output_tokens: "-1" }));
    expect(error.constraint).toBe("api_usage_output_tokens_non_negative");
    expect(error.code).toBe(CHECK_VIOLATION);
  });

  it("rejects a negative cost", async () => {
    const error = await failure(insert({ cost_micros: "-1" }));
    expect(error.constraint).toBe("api_usage_cost_non_negative");
    expect(error.code).toBe(CHECK_VIOLATION);
  });
});
