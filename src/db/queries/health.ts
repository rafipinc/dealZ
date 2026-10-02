// Health helpers for the status service: is the database there, and how many
// migrations has it had applied. Read-only.

import { count, sql } from "drizzle-orm";
import { pgSchema, serial } from "drizzle-orm/pg-core";
import journal from "../../../drizzle/migrations/meta/_journal.json";
import type { QueryDb } from "./db";

/**
 * How many migrations the repository holds, from drizzle-kit's journal. The
 * database layer owns the migrations, so it is the one that reads the journal;
 * a service compares this with countAppliedMigrations.
 */
export const EXPECTED_MIGRATION_COUNT: number = journal.entries.length;

// The migrator's own bookkeeping table: one row per applied migration, in
// schema "drizzle". Declared here, not in ../schema.ts, so drizzle-kit never
// tries to manage it. Only the column the count needs is named.
const drizzleMigrations = pgSchema("drizzle").table("__drizzle_migrations", {
  id: serial("id").primaryKey(),
});

/** Resolves when the database answers a trivial query; rejects when it does not. */
export async function pingDatabase(db: QueryDb): Promise<void> {
  await db.execute(sql`select 1`);
}

/** How many migrations the database records as applied. Rejects when none was ever run. */
export async function countAppliedMigrations(db: QueryDb): Promise<number> {
  const [row] = await db.select({ applied: count() }).from(drizzleMigrations);
  return row.applied;
}
