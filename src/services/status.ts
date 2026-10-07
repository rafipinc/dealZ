// status: is everything the backend depends on there? The database and its
// migrations, the API keys, and the SerpApi account's remaining quota, for
// the local dashboard. It never returns a key's value: a key is reported as
// set or not set, nothing more. It changes nothing but the usage ledger,
// where its one outbound call (the SerpApi Account call) is recorded like
// any other.
//
// Each check stands alone. One failing is a status value in its own field
// and never hides the others; checkServices itself throws only for a
// malformed argument.

import { z } from "zod";
import type { QueryDb } from "@/db/queries/db";
import {
  countAppliedMigrations,
  EXPECTED_MIGRATION_COUNT,
  pingDatabase,
} from "@/db/queries/health";
import { redactSecrets } from "@/lib/redact";
import { TimeoutError, withTimeout } from "@/lib/timeout";
import { accountSources, SourceError } from "@/sources";
import type { FetchLike, Meter, SourceErrorKind } from "@/sources";
import { defaultDb } from "./default-db";
import { ValidationError } from "./errors";
import { record } from "./usage";
import { usageLedger, type UsageRecorder, type UsageRecording } from "./usage-ledger";

/** The environment variables that hold a key. Their values are never reported. */
export const KEY_NAMES = ["GEMINI_API_KEY", "SERPAPI_API_KEY"] as const;
export type KeyName = (typeof KEY_NAMES)[number];

/**
 * How long the database gets to answer each health query. A stopped local
 * database refuses at once; this bounds the case where the host accepts the
 * connection and then says nothing, so the status page never hangs on it.
 */
export const DATABASE_TIMEOUT_MS = 3_000;

/** Variables whose values must never appear in a message: keys and connection strings. */
const SECRET_NAMES: readonly string[] = [...KEY_NAMES, "DATABASE_URL", "DIRECT_URL"];

export interface CheckServicesInput {
  /** Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Defaults to globalThis.fetch. */
  fetch?: FetchLike;
  /** Defaults to the application database. */
  db?: QueryDb;
  /** Defaults to () => new Date(). */
  now?: () => Date;
  /** Defaults to the number of migrations in the repository, as src/db reports it. */
  expectedMigrations?: number;
  /** Defaults to DATABASE_TIMEOUT_MS. */
  databaseTimeoutMs?: number;
  /** Writes the Account call to the usage ledger. Defaults to usage.record on the same database. */
  recordUsage?: UsageRecorder;
}

export type DatabaseStatus =
  | {
      status: "ok";
      /** Migrations the database records as applied. */
      migrationsApplied: number;
      /** Migrations in the repository's journal. */
      migrationsExpected: number;
      /** True when the two counts agree. */
      upToDate: boolean;
    }
  /** The database answered but its migration table could not be read: none was ever applied. */
  | { status: "unmigrated"; migrationsExpected: number; message: string }
  /** The database refused, failed, or did not answer within the timeout. */
  | { status: "unreachable"; migrationsExpected: number; message: string };

export interface KeyStatus {
  name: KeyName;
  set: boolean;
}

export type SerpApiAccountStatus =
  | { status: "no_key" }
  | {
      status: "ok";
      planName: string;
      searchesPerMonth: number | null;
      thisMonthUsage: number | null;
      planSearchesLeft: number | null;
      totalSearchesLeft: number | null;
    }
  | { status: "failed"; kind: SourceErrorKind; message: string };

export interface ServicesStatus {
  checkedAt: Date;
  database: DatabaseStatus;
  /** One entry per name in KEY_NAMES, in that order. */
  keys: KeyStatus[];
  serpApiAccount: SerpApiAccountStatus;
  /**
   * The outbound calls this check made (the SerpApi Account call, when a key
   * is set) and how many the usage ledger confirmed. Best effort: a ledger
   * that cannot be written never changes the statuses above.
   */
  usage: UsageRecording;
}

const isFunction = (value: unknown): boolean => typeof value === "function";

const checkServicesInputSchema = z.object({
  env: z.record(z.string(), z.string().optional()).optional(),
  fetch: z.custom<FetchLike>(isFunction).optional(),
  // A database handle is opaque here; the query helpers are its contract.
  db: z.custom<QueryDb>((value) => typeof value === "object" && value !== null).optional(),
  now: z.custom<() => Date>(isFunction).optional(),
  expectedMigrations: z.number().int().nonnegative().optional(),
  databaseTimeoutMs: z.number().int().positive().optional(),
  recordUsage: z.custom<UsageRecorder>(isFunction).optional(),
});

type Env = Record<string, string | undefined>;

function valueOf(env: Env, name: string): string | null {
  const value = env[name];
  return value === undefined || value.trim() === "" ? null : value;
}

/**
 * A failure's message with the value of every key and connection string the
 * environment holds removed from it. For anything that shows a failure to a
 * person: the status checks here, and the page when a ledger read fails.
 * `env` defaults to process.env.
 */
export function safeFailureMessage(reason: unknown, env: Env = process.env): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  return redactSecrets(
    message,
    SECRET_NAMES.map((name) => env[name]),
  );
}

async function checkDatabase(
  given: QueryDb | undefined,
  migrationsExpected: number,
  env: Env,
  timeoutMs: number,
): Promise<DatabaseStatus> {
  const unanswered = `The database did not answer within ${timeoutMs} ms`;
  let db: QueryDb;
  try {
    db = given ?? (await defaultDb());
    await withTimeout(pingDatabase(db), timeoutMs, unanswered);
  } catch (reason) {
    return { status: "unreachable", migrationsExpected, message: safeFailureMessage(reason, env) };
  }
  try {
    const migrationsApplied = await withTimeout(countAppliedMigrations(db), timeoutMs, unanswered);
    return {
      status: "ok",
      migrationsApplied,
      migrationsExpected,
      upToDate: migrationsApplied === migrationsExpected,
    };
  } catch (reason) {
    // It answered the ping, so silence now is the database going away, not a missing table.
    const status = reason instanceof TimeoutError ? "unreachable" : "unmigrated";
    return { status, migrationsExpected, message: safeFailureMessage(reason, env) };
  }
}

async function checkSerpApiAccount(
  env: Env,
  fetch: FetchLike | undefined,
  now: () => Date,
  meter: Meter,
): Promise<SerpApiAccountStatus> {
  // The key goes to the source and nowhere else; no status includes it.
  const apiKey = valueOf(env, "SERPAPI_API_KEY");
  if (apiKey === null) return { status: "no_key" };
  try {
    const account = await accountSources.serpapi({ apiKey, fetch, now, meter });
    return {
      status: "ok",
      planName: account.planName,
      searchesPerMonth: account.searchesPerMonth,
      thisMonthUsage: account.thisMonthUsage,
      planSearchesLeft: account.planSearchesLeft,
      totalSearchesLeft: account.totalSearchesLeft,
    };
  } catch (reason) {
    const kind = reason instanceof SourceError ? reason.kind : "network";
    return { status: "failed", kind, message: safeFailureMessage(reason, env) };
  }
}

/**
 * Checks the database, the keys and the SerpApi account, each on its own, and
 * records the Account call in the usage ledger, best effort. Throws
 * ValidationError for a malformed argument and for nothing else.
 */
export async function checkServices(input: CheckServicesInput = {}): Promise<ServicesStatus> {
  const parsed = checkServicesInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Invalid checkServices input", parsed.error.issues);
  }
  const env: Env = parsed.data.env ?? process.env;
  const now = parsed.data.now ?? (() => new Date());
  const migrationsExpected = parsed.data.expectedMigrations ?? EXPECTED_MIGRATION_COUNT;

  // The Account call is an outbound call like any other, so it goes in the
  // ledger: one row per call, without exception. On the same database handle
  // the check itself uses.
  const { db } = parsed.data;
  const ledger = usageLedger(
    parsed.data.recordUsage ?? ((call) => record(call, db === undefined ? {} : { db })),
  );

  const checkedAt = now();
  const [database, serpApiAccount] = await Promise.all([
    checkDatabase(
      db,
      migrationsExpected,
      env,
      parsed.data.databaseTimeoutMs ?? DATABASE_TIMEOUT_MS,
    ),
    checkSerpApiAccount(env, parsed.data.fetch, now, ledger.meter),
  ]);

  return {
    checkedAt,
    database,
    keys: KEY_NAMES.map((name) => ({ name, set: valueOf(env, name) !== null })),
    serpApiAccount,
    // A database that did not answer the check is not asked again: the write
    // is skipped and reported as not recorded, instead of waiting on it twice.
    usage: database.status === "unreachable" ? ledger.abandon() : await ledger.flush(null),
  };
}
