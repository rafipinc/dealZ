// usage: the ledger of outbound calls. Every request a source makes to an
// external service becomes one api_usage row, written here, and the local
// dashboard reads the ledger back through here. Decided by Rafi: the ledger
// lives in local Postgres, there are no budget caps, and it is local-only.
//
// The ledger is append-only (a trigger rejects UPDATE and DELETE), so there
// is a `record` and five reads, nothing else. Cost is an estimate from
// src/lib/api-prices, fixed at write time.

import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import {
  dailyApiUsage,
  insertApiUsage,
  lastOkPerTarget,
  recentApiUsage,
  summariseApiUsage,
  type ApiUsageRow,
} from "@/db/queries/api-usage";
import { modelCallsByDay, type ModelCallsOnDay } from "@/db/queries/api-usage-models";
import type { QueryDb } from "@/db/queries/db";
import { apiUsage } from "@/db/schema";
import { estimateCostMicros, isPriced, type PriceTable } from "@/lib/api-prices";
import { dayRangeIn, isValidTimeZone, lastDaysIn, monthToDateRangeIn } from "@/lib/day-ranges";
import { defaultDb } from "./default-db";
import { ValidationError } from "./errors";

/** The services DealZ calls. Mirrors SourceProvider in src/sources/types.ts. */
export const USAGE_PROVIDERS = ["serpapi", "gemini", "wayback", "retailer"] as const;
export type UsageProvider = (typeof USAGE_PROVIDERS)[number];

export type UsageOutcome = "ok" | "failed";
export type UsageErrorKind = "blocked" | "http" | "unparseable" | "network";

/** Injected so tests run against PGlite. Defaults to the application database. */
export interface UsageDeps {
  db?: QueryDb;
  /**
   * The rates `record` estimates cost at, and the table the reads consult to
   * say which calls are unpriced. Defaults to the table in src/lib/api-prices.
   */
  prices?: PriceTable;
}

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const slug = z.string().regex(SLUG_RE, "Expected a kebab-case slug");

// The insert shape comes from the table, so a column is defined once. The
// overrides only narrow: they repeat the table's checks so a bad call is a
// ValidationError here, before the database has to refuse it.
const tokenCount = z.int().nonnegative().nullable().optional();

const insertSchema = createInsertSchema(apiUsage, {
  provider: z.enum(USAGE_PROVIDERS),
  operation: (column) => column.min(1),
  errorKind: z.enum(["blocked", "http", "unparseable", "network"]).nullable().optional(),
  durationMs: (column) => column.nonnegative(),
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  model: z.string().min(1).nullable().optional(),
  retailerSlug: slug.nullable().optional(),
  variantSlug: slug.nullable().optional(),
});

const recordInputSchema = insertSchema
  .pick({
    provider: true,
    operation: true,
    outcome: true,
    errorKind: true,
    httpStatus: true,
    durationMs: true,
    model: true,
    inputTokens: true,
    outputTokens: true,
    retailerSlug: true,
    variantSlug: true,
  })
  .extend({ startedAt: z.date() })
  .refine((call) => (call.outcome === "failed") === (call.errorKind != null), {
    message: "A failed call names its error kind; an ok call has none",
    path: ["errorKind"],
  });

/**
 * One outbound call, as a source's meter reports it (SourceCall), plus the
 * variant it was made for. Nullable fields may be left out.
 */
export type RecordUsageInput = z.input<typeof recordInputSchema>;

/** One ledger row, as a page shows it. */
export interface UsageCall {
  id: string;
  provider: string;
  operation: string;
  calledAt: Date;
  outcome: UsageOutcome;
  errorKind: string | null;
  httpStatus: number | null;
  durationMs: number;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Estimated, in millionths of a US dollar. */
  costMicros: number;
  /**
   * False when the price table has no price for this provider or model, so
   * `costMicros` of zero is not a fact. Decided when the row is read, from the
   * table as it is now.
   */
  priced: boolean;
  retailerSlug: string | null;
  variantSlug: string | null;
}

export interface RecordedUsage {
  call: UsageCall;
  /** The same as `call.priced`, kept at the top for a caller that only wants to know. */
  priced: boolean;
}

function toUsageCall(row: ApiUsageRow, prices: PriceTable | undefined): UsageCall {
  return {
    id: row.id,
    provider: row.provider,
    operation: row.operation,
    calledAt: row.calledAt,
    outcome: row.outcome,
    errorKind: row.errorKind,
    httpStatus: row.httpStatus,
    durationMs: row.durationMs,
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costMicros: row.costMicros,
    priced: isPriced(row.provider, row.model, prices),
    retailerSlug: row.retailerSlug,
    variantSlug: row.variantSlug,
  };
}

async function dbOf(deps: UsageDeps): Promise<QueryDb> {
  return deps.db ?? defaultDb();
}

/**
 * Appends one call to the ledger with its estimated cost. Throws
 * ValidationError for a malformed call. A database failure propagates as it
 * is; a caller for whom the ledger is best effort (quotes) catches it.
 */
export async function record(call: RecordUsageInput, deps: UsageDeps = {}): Promise<RecordedUsage> {
  const parsed = recordInputSchema.safeParse(call);
  if (!parsed.success) {
    throw new ValidationError("Invalid usage record", parsed.error.issues);
  }
  const { startedAt, ...columns } = parsed.data;
  const { costMicros, priced } = estimateCostMicros(
    {
      provider: columns.provider,
      operation: columns.operation,
      outcome: columns.outcome,
      startedAt,
      model: columns.model ?? null,
      inputTokens: columns.inputTokens ?? null,
      outputTokens: columns.outputTokens ?? null,
    },
    deps.prices,
  );
  const row = await insertApiUsage(await dbOf(deps), {
    ...columns,
    calledAt: startedAt,
    costMicros,
  });
  return { call: toUsageCall(row, deps.prices), priced };
}

// ---------- Reads ----------

/** A half-open period: `from` is included, `to` is not. */
export interface UsagePeriodInput {
  from: Date;
  to: Date;
}

const periodSchema = z
  .object({ from: z.date(), to: z.date() })
  .refine((period) => period.from.getTime() < period.to.getTime(), {
    message: "`from` must be before `to`",
    path: ["to"],
  });

function periodOf(input: UsagePeriodInput, name: string): UsagePeriodInput {
  const parsed = periodSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(`Invalid ${name} period`, parsed.error.issues);
  }
  return parsed.data;
}

export interface UsageTotals {
  calls: number;
  ok: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  /** Estimated. A lower bound when `unpricedCalls` is above zero. */
  costMicros: number;
  /**
   * Calls counted here that the price table cannot price. They are in `calls`
   * and add nothing to `costMicros`, so with any of them the cost is a lower
   * bound, and with nothing but them it is unknown.
   */
  unpricedCalls: number;
}

export interface ProviderUsage extends UsageTotals {
  provider: string;
}

export interface UsageSummary {
  from: Date;
  to: Date;
  /** One entry per provider that was called in the period, by name. */
  providers: ProviderUsage[];
  /** The sum over every provider. All zeros for an empty period. */
  totals: UsageTotals;
}

/** Calls the price table cannot price, among rows already filtered to one day or provider. */
function unpricedAmong(rows: readonly ModelCallsOnDay[], prices: PriceTable | undefined): number {
  return rows
    .filter((row) => !isPriced(row.provider, row.model, prices))
    .reduce((sum, row) => sum + row.calls, 0);
}

async function summaryFrom(
  db: QueryDb,
  { from, to }: UsagePeriodInput,
  prices: PriceTable | undefined,
): Promise<UsageSummary> {
  const [rows, models] = await Promise.all([
    summariseApiUsage(db, { from, to }),
    // The days are not used here, only the models, so any zone will do.
    modelCallsByDay(db, { from, to, timeZone: "UTC" }),
  ]);
  const providers: ProviderUsage[] = rows.map((row) => ({
    provider: row.provider,
    calls: row.calls,
    ok: row.ok,
    failed: row.failed,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costMicros: row.costMicros,
    unpricedCalls: unpricedAmong(
      models.filter((model) => model.provider === row.provider),
      prices,
    ),
  }));
  const totals: UsageTotals = {
    calls: 0,
    ok: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    costMicros: 0,
    unpricedCalls: 0,
  };
  for (const provider of providers) {
    totals.calls += provider.calls;
    totals.ok += provider.ok;
    totals.failed += provider.failed;
    totals.inputTokens += provider.inputTokens;
    totals.outputTokens += provider.outputTokens;
    totals.costMicros += provider.costMicros;
    totals.unpricedCalls += provider.unpricedCalls;
  }
  return { from, to, providers, totals };
}

/**
 * Per provider over the period: calls, outcomes, tokens and estimated cost,
 * with totals. Nothing is left out of a total; a total that includes calls
 * the price table cannot price says how many, so it reads as a lower bound.
 */
export async function summary(
  period: UsagePeriodInput,
  deps: UsageDeps = {},
): Promise<UsageSummary> {
  const parsed = periodOf(period, "summary");
  return summaryFrom(await dbOf(deps), parsed, deps.prices);
}

const timeZoneSchema = z
  .string()
  .refine(isValidTimeZone, "Expected an IANA time zone such as Australia/Sydney");

/** A period plus the IANA time zone whose calendar days the rows are bucketed by. */
export interface DailyUsageInput extends UsagePeriodInput {
  timeZone: string;
}

export interface DailyUsage {
  /** Calendar day in the requested time zone, `YYYY-MM-DD`. */
  day: string;
  provider: string;
  calls: number;
  /** Estimated. A lower bound when `unpricedCalls` is above zero. */
  costMicros: number;
  /** Calls that day the price table cannot price. */
  unpricedCalls: number;
}

async function dailyFrom(
  db: QueryDb,
  period: DailyUsageInput,
  prices: PriceTable | undefined,
): Promise<DailyUsage[]> {
  const [rows, models] = await Promise.all([
    dailyApiUsage(db, period),
    modelCallsByDay(db, period),
  ]);
  return rows.map((row) => ({
    day: row.day,
    provider: row.provider,
    calls: row.calls,
    costMicros: row.costMicros,
    unpricedCalls: unpricedAmong(
      models.filter((model) => model.day === row.day && model.provider === row.provider),
      prices,
    ),
  }));
}

/**
 * Per calendar day and provider over the period, oldest day first. The days
 * are those of `timeZone`. Days without calls are absent.
 */
export async function daily(period: DailyUsageInput, deps: UsageDeps = {}): Promise<DailyUsage[]> {
  const { from, to } = periodOf(period, "daily");
  const timeZone = timeZoneSchema.safeParse(period.timeZone);
  if (!timeZone.success) {
    throw new ValidationError("Invalid daily time zone", timeZone.error.issues);
  }
  return dailyFrom(await dbOf(deps), { from, to, timeZone: timeZone.data }, deps.prices);
}

export const DEFAULT_RECENT_CALLS = 50;
export const MAX_RECENT_CALLS = 500;

const limitSchema = z.number().int().min(1).max(MAX_RECENT_CALLS);

/** The newest calls first. `limit` is 1 to MAX_RECENT_CALLS. */
export async function recentCalls(
  limit: number = DEFAULT_RECENT_CALLS,
  deps: UsageDeps = {},
): Promise<UsageCall[]> {
  const parsed = limitSchema.safeParse(limit);
  if (!parsed.success) {
    throw new ValidationError("Invalid recentCalls limit", parsed.error.issues);
  }
  const rows = await recentApiUsage(await dbOf(deps), parsed.data);
  return rows.map((row) => toUsageCall(row, deps.prices));
}

export interface LastOk {
  provider: string;
  /** Null for calls made for no one retailer, such as a search. */
  retailerSlug: string | null;
  lastOkAt: Date;
}

/** When each provider last answered for each retailer. A pair that never answered is absent. */
export async function lastOk(deps: UsageDeps = {}): Promise<LastOk[]> {
  const rows = await lastOkPerTarget(await dbOf(deps));
  return rows.map((row) => ({
    provider: row.provider,
    retailerSlug: row.retailerSlug,
    lastOkAt: row.lastOkAt,
  }));
}

// ---------- Dashboard: everything the status page shows, in one call ----------

export const DEFAULT_DASHBOARD_DAYS = 30;
export const MAX_DASHBOARD_DAYS = 366;
export const DEFAULT_DASHBOARD_RECENT_CALLS = 20;

export interface UsageDashboardInput {
  /** The instant "today" is read from. */
  now: Date;
  /** The IANA time zone every period and every day in the result is in. */
  timeZone: string;
  /** How many calendar days the daily rows cover, ending today. Defaults to 30. */
  days?: number;
  /** How many recent calls to return. Defaults to 20. */
  recentLimit?: number;
}

export interface UsageDashboard {
  now: Date;
  timeZone: string;
  /** From midnight today in the zone to the next midnight. */
  today: UsageSummary;
  /** From the first of the zone's month to the end of today. */
  monthToDate: UsageSummary;
  daily: {
    from: Date;
    to: Date;
    /** Every calendar day in the window, oldest first, including days with no calls. */
    days: string[];
    /** One row per day and provider that had calls. */
    rows: DailyUsage[];
  };
  /** Newest first. */
  recent: UsageCall[];
  lastOk: LastOk[];
}

const dashboardInputSchema = z.object({
  now: z.date(),
  timeZone: timeZoneSchema,
  days: z.number().int().min(1).max(MAX_DASHBOARD_DAYS).default(DEFAULT_DASHBOARD_DAYS),
  recentLimit: limitSchema.default(DEFAULT_DASHBOARD_RECENT_CALLS),
});

/**
 * Reads the ledger once for a dashboard: today, month to date, the last
 * `days` days, the newest calls and the last success per provider and
 * retailer. One time zone throughout. A database failure propagates as it is.
 */
export async function dashboard(
  input: UsageDashboardInput,
  deps: UsageDeps = {},
): Promise<UsageDashboard> {
  const parsed = dashboardInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Invalid dashboard input", parsed.error.issues);
  }
  const { now, timeZone, days, recentLimit } = parsed.data;
  const window = lastDaysIn(now, days, timeZone);
  const db = await dbOf(deps);
  const resolved: UsageDeps = { ...deps, db };

  const [today, monthToDate, rows, recent, lastOkRows] = await Promise.all([
    summaryFrom(db, dayRangeIn(now, timeZone), deps.prices),
    summaryFrom(db, monthToDateRangeIn(now, timeZone), deps.prices),
    dailyFrom(db, { from: window.from, to: window.to, timeZone }, deps.prices),
    recentCalls(recentLimit, resolved),
    lastOk(resolved),
  ]);
  return {
    now,
    timeZone,
    today,
    monthToDate,
    daily: { from: window.from, to: window.to, days: window.days, rows },
    recent,
    lastOk: lastOkRows,
  };
}
