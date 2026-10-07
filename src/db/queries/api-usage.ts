// Thin helpers over the api_usage ledger: one row per outbound call to an
// external service. Insert and read only; the table is append-only, so there is
// no update or delete helper and there never will be.

import { and, count, desc, eq, gte, lt, max, ne, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { apiUsage } from "../schema";
import type { QueryDb } from "./db";

export type ApiUsageRow = typeof apiUsage.$inferSelect;
export type ApiUsageInsert = typeof apiUsage.$inferInsert;

/** A half-open period: `from` is included, `to` is not. */
export interface UsagePeriod {
  from: Date;
  to: Date;
}

/** A period plus the IANA timezone whose calendar days the rows are bucketed by. */
export interface DailyUsagePeriod extends UsagePeriod {
  timeZone: string;
}

export interface ProviderUsageSummary {
  provider: string;
  calls: number;
  ok: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
}

export interface DailyProviderUsage {
  /** Calendar day in the requested timezone, `YYYY-MM-DD`. */
  day: string;
  provider: string;
  calls: number;
  costMicros: number;
}

export interface LastOkForTarget {
  provider: string;
  retailerSlug: string | null;
  lastOkAt: Date;
}

/** A period narrowed to one provider's calls. */
export interface ProviderPeriod extends UsagePeriod {
  provider: string;
}

export interface OkCallsByOperation {
  operation: string;
  count: number;
}

const inPeriod = ({ from, to }: UsagePeriod) =>
  and(gte(apiUsage.calledAt, from), lt(apiUsage.calledAt, to));

// sum() over integers is a bigint, which drivers hand back as a string.
const total = (column: AnyPgColumn) => sql<number>`coalesce(sum(${column}), 0)`.mapWith(Number);

export async function insertApiUsage(db: QueryDb, row: ApiUsageInsert): Promise<ApiUsageRow> {
  const [inserted] = await db.insert(apiUsage).values(row).returning();
  return inserted;
}

/** Per provider over the period: calls, outcomes, tokens and estimated cost. */
export async function summariseApiUsage(
  db: QueryDb,
  period: UsagePeriod,
): Promise<ProviderUsageSummary[]> {
  return db
    .select({
      provider: apiUsage.provider,
      calls: count(),
      ok: sql<number>`count(*) filter (where ${apiUsage.outcome} = 'ok')`.mapWith(Number),
      failed: sql<number>`count(*) filter (where ${apiUsage.outcome} = 'failed')`.mapWith(Number),
      inputTokens: total(apiUsage.inputTokens),
      outputTokens: total(apiUsage.outputTokens),
      costMicros: total(apiUsage.costMicros),
    })
    .from(apiUsage)
    .where(inPeriod(period))
    .groupBy(apiUsage.provider)
    .orderBy(apiUsage.provider);
}

/**
 * Successful calls per operation for one provider over the period, ordered by
 * operation. The budget check reads this: a failed call is not spent quota, so
 * only `ok` rows count. An operation with no successful calls has no row.
 */
export async function countOkCallsByOperation(
  db: QueryDb,
  { provider, ...period }: ProviderPeriod,
): Promise<OkCallsByOperation[]> {
  return db
    .select({ operation: apiUsage.operation, count: count() })
    .from(apiUsage)
    .where(and(eq(apiUsage.provider, provider), eq(apiUsage.outcome, "ok"), inPeriod(period)))
    .groupBy(apiUsage.operation)
    .orderBy(apiUsage.operation);
}

/**
 * Per calendar day and provider over the period: calls and estimated cost.
 * Oldest day first. Days are those of `timeZone`, an IANA name such as
 * `Australia/Sydney`, so the buckets match the days the caller shows. An
 * unknown zone is an error from Postgres, never a silent fall back to UTC.
 */
export async function dailyApiUsage(
  db: QueryDb,
  { timeZone, ...period }: DailyUsagePeriod,
): Promise<DailyProviderUsage[]> {
  // The zone travels as a bound parameter. The day leaves Postgres as text, so
  // no JavaScript Date can shift it into another zone on the way out.
  const day = sql<string>`to_char((${apiUsage.calledAt} at time zone ${timeZone})::date, 'YYYY-MM-DD')`;
  // Group and order by position: repeating the expression would bind the zone
  // again under a new parameter number, and Postgres would not see it as the
  // same expression as the one selected.
  const dayColumn = sql`1`;
  return db
    .select({
      day,
      provider: apiUsage.provider,
      calls: count(),
      costMicros: total(apiUsage.costMicros),
    })
    .from(apiUsage)
    .where(inPeriod(period))
    .groupBy(dayColumn, apiUsage.provider)
    .orderBy(dayColumn, apiUsage.provider);
}

/** The newest calls first. */
export async function recentApiUsage(db: QueryDb, limit: number): Promise<ApiUsageRow[]> {
  return db
    .select()
    .from(apiUsage)
    .orderBy(desc(apiUsage.calledAt), desc(apiUsage.id))
    .limit(limit);
}

/**
 * When each provider last answered for each retailer. Calls with no retailer group under null.
 * The SerpApi account call is left out: the status check makes it on every page load, so
 * counting it would show the provider as answering while every search fails.
 */
export async function lastOkPerTarget(db: QueryDb): Promise<LastOkForTarget[]> {
  const rows = await db
    .select({
      provider: apiUsage.provider,
      retailerSlug: apiUsage.retailerSlug,
      lastOkAt: max(apiUsage.calledAt),
    })
    .from(apiUsage)
    .where(and(eq(apiUsage.outcome, "ok"), ne(apiUsage.operation, "account")))
    .groupBy(apiUsage.provider, apiUsage.retailerSlug)
    .orderBy(apiUsage.provider, apiUsage.retailerSlug);
  // max() is typed nullable, but a group always holds at least one row.
  return rows.flatMap((r) => (r.lastOkAt ? [{ ...r, lastOkAt: r.lastOkAt }] : []));
}
