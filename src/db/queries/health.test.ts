import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../test-db";
import { countAppliedMigrations, EXPECTED_MIGRATION_COUNT, pingDatabase } from "./health";

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
});

afterAll(async () => {
  await t.close();
});

describe("pingDatabase", () => {
  it("resolves against a database that answers", async () => {
    await expect(pingDatabase(t.db)).resolves.toBeUndefined();
  });
});

describe("EXPECTED_MIGRATION_COUNT", () => {
  it("is the number of entries in the journal, one per migration file", () => {
    const journal = JSON.parse(readFileSync("./drizzle/migrations/meta/_journal.json", "utf8")) as {
      entries: unknown[];
    };
    const files = readdirSync("./drizzle/migrations").filter((name) => name.endsWith(".sql"));
    expect(EXPECTED_MIGRATION_COUNT).toBe(journal.entries.length);
    expect(EXPECTED_MIGRATION_COUNT).toBe(files.length);
  });
});

describe("countAppliedMigrations", () => {
  it("counts one row per migration in the journal", async () => {
    const journal = JSON.parse(readFileSync("./drizzle/migrations/meta/_journal.json", "utf8")) as {
      entries: unknown[];
    };
    expect(await countAppliedMigrations(t.db)).toBe(journal.entries.length);
  });

  it("rejects when the migrator's table is missing", async () => {
    const empty = await createTestDb();
    await empty.exec('DROP TABLE "drizzle"."__drizzle_migrations"');
    await expect(countAppliedMigrations(empty.db)).rejects.toThrow();
    await empty.close();
  });
});
