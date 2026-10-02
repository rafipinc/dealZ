// Which models the ledger's calls used, per day and provider. The usage
// service needs this to say which calls its price table cannot price; the
// cost stored on a row cannot tell an unpriced call from a free one.

import { and, count, gte, lt, sql } from "drizzle-orm";
import { apiUsage } from "../schema";
import type { DailyUsagePeriod } from "./api-usage";
import type { QueryDb } from "./db";

export interface ModelCallsOnDay {
  /** Calendar day in the requested timezone, `YYYY-MM-DD`. */
  day: string;
  provider: string;
  /** Null for every provider that has no model. */
  model: string | null;
  calls: number;
}

/**
 * Calls per calendar day, provider and model over the period, oldest day
 * first. Days are those of `timeZone`, bucketed exactly as dailyApiUsage
 * buckets them, so the two line up row for row.
 */
export async function modelCallsByDay(
  db: QueryDb,
  { timeZone, from, to }: DailyUsagePeriod,
): Promise<ModelCallsOnDay[]> {
  const day = sql<string>`to_char((${apiUsage.calledAt} at time zone ${timeZone})::date, 'YYYY-MM-DD')`;
  // Grouped and ordered by position, for the reason given in dailyApiUsage.
  const dayColumn = sql`1`;
  return db
    .select({ day, provider: apiUsage.provider, model: apiUsage.model, calls: count() })
    .from(apiUsage)
    .where(and(gte(apiUsage.calledAt, from), lt(apiUsage.calledAt, to)))
    .groupBy(dayColumn, apiUsage.provider, apiUsage.model)
    .orderBy(dayColumn, apiUsage.provider, apiUsage.model);
}
