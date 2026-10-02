// What the lab's status page says about each service check: a tone, a badge
// and a sentence. Pure wording over the status service's result; the page
// renders these and decides nothing. No rule lives here: what counts as a
// healthy database or a set key is the service's business.
//
// The input types are structural, so this file imports nothing from
// src/services; the status service's result satisfies them as it is.

import { formatCount, formatDateTimeIn, formatPercent } from "./usage-format";

export type Tone = "good" | "warn" | "bad" | "muted";

export type DatabaseCheck =
  | { status: "ok"; migrationsApplied: number; migrationsExpected: number; upToDate: boolean }
  | { status: "unmigrated"; migrationsExpected: number; message: string }
  | { status: "unreachable"; migrationsExpected: number; message: string };

export type AccountCheck =
  | { status: "no_key" }
  | {
      status: "ok";
      planName: string;
      searchesPerMonth: number | null;
      thisMonthUsage: number | null;
      planSearchesLeft: number | null;
      totalSearchesLeft: number | null;
    }
  | { status: "failed"; kind: string; message: string };

/** The part of the status service's result the page words. */
export interface StatusInput {
  checkedAt: Date;
  database: DatabaseCheck;
  keys: readonly { name: string; set: boolean }[];
  serpApiAccount: AccountCheck;
}

// ---------- Services ----------

export interface CheckView {
  tone: Tone;
  /** The state in a word or two, for the badge. */
  badge: string;
  /** One sentence saying what the state is. */
  detail: string;
  /** What to do about it, or the redacted failure message. Null when there is nothing to add. */
  note: string | null;
}

export interface KeyView {
  name: string;
  tone: Tone;
  /** "set" or "not set". Never the value, never a part of it. */
  badge: string;
}

export interface StatusView {
  checkedAtLabel: string;
  database: CheckView;
  keys: KeyView[];
  serpApiAccount: CheckView;
}

function migrations(count: number): string {
  return `${count} ${count === 1 ? "migration" : "migrations"}`;
}

function databaseView(database: DatabaseCheck): CheckView {
  switch (database.status) {
    case "ok":
      return database.upToDate
        ? {
            tone: "good",
            badge: "reachable",
            detail: `${database.migrationsApplied} of ${migrations(database.migrationsExpected)} applied.`,
            note: null,
          }
        : {
            tone: "warn",
            badge: "out of date",
            detail: `Reachable, but ${database.migrationsApplied} of ${migrations(database.migrationsExpected)} applied.`,
            note: "Run npm run db:migrate.",
          };
    case "unmigrated":
      return {
        tone: "warn",
        badge: "not migrated",
        detail: `Reachable, but no migration was ever applied; the repository has ${database.migrationsExpected}.`,
        note: `Run npm run db:migrate. The database said: ${database.message}`,
      };
    case "unreachable":
      return {
        tone: "bad",
        badge: "unreachable",
        detail: "The database did not answer.",
        note: database.message,
      };
  }
}

function accountView(account: AccountCheck): CheckView {
  switch (account.status) {
    case "no_key":
      return {
        tone: "muted",
        badge: "no key",
        detail: "SERPAPI_API_KEY is not set, so the account was not asked.",
        note: "Store it with scripts/keys.sh set SERPAPI_API_KEY and restart the dev server.",
      };
    case "failed":
      return {
        tone: "bad",
        badge: account.kind,
        detail: "SerpApi did not return the account.",
        note: account.message,
      };
    case "ok": {
      const {
        thisMonthUsage: used,
        searchesPerMonth: allowance,
        totalSearchesLeft: left,
      } = account;
      const share = used === null || allowance === null ? null : formatPercent(used, allowance);
      const usedText =
        used === null
          ? "Usage this month is not reported"
          : allowance === null
            ? `${formatCount(used)} searches used this month`
            : `${formatCount(used)} of ${formatCount(allowance)} searches used this month${
                share === null ? "" : ` (${share})`
              }`;
      const leftText = left === null ? "" : `, ${formatCount(left)} left`;
      return {
        tone: left === 0 ? "warn" : "good",
        badge: account.planName,
        detail: `${usedText}${leftText}.`,
        note: null,
      };
    }
  }
}

/** `timeZone` is the zone the check time is printed in. */
export function toStatusView(status: StatusInput, timeZone: string): StatusView {
  return {
    checkedAtLabel: formatDateTimeIn(status.checkedAt, timeZone),
    database: databaseView(status.database),
    keys: status.keys.map((key) => ({
      name: key.name,
      tone: key.set ? "good" : "muted",
      badge: key.set ? "set" : "not set",
    })),
    serpApiAccount: accountView(status.serpApiAccount),
  };
}

/**
 * Why the ledger cannot be read, when the database check says so. Null when
 * the database is fit to be asked.
 */
export function ledgerBlockedReason(database: DatabaseCheck): string | null {
  switch (database.status) {
    case "ok":
      return null;
    case "unmigrated":
      return "The database has no migrations applied, so there is no ledger to read. Run npm run db:migrate.";
    case "unreachable":
      return `The database is unreachable, so the ledger cannot be read: ${database.message}`;
  }
}

/** What the Usage section says when a ledger read fails. `message` is already redacted. */
export function ledgerReadFailure(message: string): string {
  return `The ledger could not be read: ${message}`;
}
