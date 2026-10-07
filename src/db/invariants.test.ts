// Breaking tests for the database invariants. Each test tries to violate one
// rule and asserts the named constraint or trigger message. The matrix is in
// docs/TESTING.md. api_usage and catalogue_candidate are covered so far; the
// rest of the matrix joins this file as further describe blocks on the same
// harness.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  searchCatalogueCandidates,
  upsertCatalogueCandidates,
} from "./queries/catalogue-candidates";
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
const UNIQUE_VIOLATION = "23505";
const INVALID_ENUM_VALUE = "22P02";

describe("migrations", () => {
  it("applies drizzle/migrations to an empty PGlite without error", async () => {
    const result = await t.exec(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'",
    );
    expect(result.rows).toEqual([{ n: 9 }]);
  });

  it("installs pg_trgm and the trigram index on catalogue_candidate.title", async () => {
    const extension = await t.exec("SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'");
    expect(extension.rows).toEqual([{ extname: "pg_trgm" }]);

    const index = await t.exec(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'catalogue_candidate_title_trgm_idx'",
    );
    expect(index.rows).toHaveLength(1);
    expect(String((index.rows[0] as { indexdef: string }).indexdef)).toContain(
      "USING gin (title gin_trgm_ops)",
    );
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

describe("catalogue_candidate", () => {
  // A valid row with one column overridden, so each test breaks exactly one rule.
  const insert = (overrides: Record<string, string> = {}) => {
    const row: Record<string, string> = {
      retailer_slug: "'jb-hi-fi'",
      handle: "'lg-65-oled-evo-ai-c6-4k-smart-tv-2026'",
      canonical_url: "'https://www.jbhifi.com.au/products/lg-65-oled-evo-ai-c6-4k-smart-tv-2026'",
      title: `'LG 65" OLED EVO AI C6 4K Smart TV [2026]'`,
      source: "'search'",
      ...overrides,
    };
    const columns = Object.keys(row).join(", ");
    return `INSERT INTO catalogue_candidate (${columns}) VALUES (${Object.values(row).join(", ")})`;
  };

  const lgC6 = {
    retailerSlug: "jb-hi-fi",
    handle: "lg-65-oled-evo-ai-c6-4k-smart-tv-2026",
    canonicalUrl: "https://www.jbhifi.com.au/products/lg-65-oled-evo-ai-c6-4k-smart-tv-2026",
    title: 'LG 65" OLED EVO AI C6 4K Smart TV [2026]',
    gtin: "08806096123456",
    source: "search",
  };

  beforeEach(async () => {
    await t.truncate("catalogue_candidate");
  });

  it("accepts a valid row with a 14-digit gtin and each known source", async () => {
    await t.exec(insert({ gtin: "'08806096123456'" }));
    await t.exec(insert({ handle: "'b'", source: "'listing'" }));
    await t.exec(insert({ handle: "'c'", source: "'inspect'" }));
    const result = await t.exec("SELECT count(*)::int AS n FROM catalogue_candidate");
    expect(result.rows).toEqual([{ n: 3 }]);
  });

  it("rejects a second row for the same retailer and handle", async () => {
    await t.exec(insert());
    const error = await failure(insert({ title: "'another title'" }));
    expect(error.constraint).toBe("catalogue_candidate_retailer_handle_uq");
    expect(error.code).toBe(UNIQUE_VIOLATION);
  });

  it("allows the same handle at another retailer", async () => {
    await t.exec(insert());
    await t.exec(insert({ retailer_slug: "'powerland'" }));
    const result = await t.exec("SELECT count(*)::int AS n FROM catalogue_candidate");
    expect(result.rows).toEqual([{ n: 2 }]);
  });

  it.each([
    ["a 13-digit gtin", { gtin: "'8806096123456'" }, "catalogue_candidate_gtin_is_14_digits"],
    ["a negative price", { price_cents: "-1" }, "catalogue_candidate_price_non_negative"],
    [
      "a negative compare-at price",
      { compare_at_cents: "-1" },
      "catalogue_candidate_compare_at_non_negative",
    ],
    [
      "a retailer slug that is not a slug",
      { retailer_slug: "'JB Hi-Fi'" },
      "catalogue_candidate_retailer_slug_format",
    ],
    ["a two-letter currency", { currency: "'AU'" }, "catalogue_candidate_currency_iso4217"],
    [
      "a source outside listing, search, inspect",
      { source: "'scrape'" },
      "catalogue_candidate_source_known",
    ],
  ])("rejects %s", async (_what, overrides, constraint) => {
    const error = await failure(insert(overrides));
    expect(error.constraint).toBe(constraint);
    expect(error.code).toBe(CHECK_VIOLATION);
  });

  it("moves updated_at when a candidate's title changes", async () => {
    await t.exec(insert());
    const before = await t.exec("SELECT updated_at FROM catalogue_candidate");
    await t.exec("SELECT pg_sleep(0.01)");
    await t.exec("UPDATE catalogue_candidate SET title = 'renamed'");
    const after = await t.exec("SELECT updated_at FROM catalogue_candidate");
    const at = (r: { rows: unknown[] }) =>
      new Date((r.rows[0] as { updated_at: string }).updated_at);
    expect(at(after).getTime()).toBeGreaterThan(at(before).getTime());
  });

  it("keeps first_seen_at and a stored gtin when the upsert sees the row again without one", async () => {
    await upsertCatalogueCandidates(t.db, [lgC6]);
    const [before] = await t.db.query.catalogueCandidate.findMany();
    await t.exec("SELECT pg_sleep(0.01)");

    await upsertCatalogueCandidates(t.db, [{ ...lgC6, gtin: null, title: "LG C6 again" }]);
    const [after] = await t.db.query.catalogueCandidate.findMany();

    expect(after.id).toBe(before.id);
    expect(after.firstSeenAt).toEqual(before.firstSeenAt);
    expect(after.lastSeenAt.getTime()).toBeGreaterThan(before.lastSeenAt.getTime());
    expect(after.gtin).toBe("08806096123456");
    expect(after.title).toBe("LG C6 again");
  });

  it("finds LG 65 C6 by trigram from the full title", async () => {
    await upsertCatalogueCandidates(t.db, [lgC6]);
    const found = await searchCatalogueCandidates(t.db, { query: "LG 65 C6", limit: 10 });
    expect(found.map((r) => r.title)).toEqual([lgC6.title]);
  });

  it("finds a row by exact gtin", async () => {
    await upsertCatalogueCandidates(t.db, [lgC6]);
    const found = await searchCatalogueCandidates(t.db, { query: "08806096123456", limit: 10 });
    expect(found.map((r) => r.handle)).toEqual([lgC6.handle]);
  });
});
