// daily-cap: the per-day request cap a paid provider is held to. The cap is
// read from one environment variable, tolerantly, and the day's use is
// counted from the usage ledger's successful calls. Shared by discovery
// (SERPAPI_DAILY_CAP, ADR-0017 item 11) and quotes (OPENAI_DAILY_CAP,
// ADR-0020 item 5), so both caps are read and counted the same way. A
// malformed setting never throws from a page: it is the default, marked
// `invalid`, so a status line can say it was ignored.

import { z } from "zod";
import {
  countOkCallsByOperation,
  type OkCallsByOperation,
  type ProviderPeriod,
} from "@/db/queries/api-usage";
import type { QueryDb } from "@/db/queries/db";
import { defaultDb } from "./default-db";

/** Where the cap came from: the variable, the default because it is unset, or the default because it is malformed. */
export type CapSource = "env" | "default" | "invalid";

export interface DailyCap {
  /** Requests allowed per Sydney day. Zero means the paid call is disabled. */
  cap: number;
  capSource: CapSource;
}

/** A whole, non-negative number. Read on every call, so a test can set the variable. */
const dailyCapSchema = z.coerce.number().int().min(0);

/**
 * The cap as set, or `defaultCap` when the variable is unset or blank. A
 * malformed value is the default too, marked `invalid`.
 */
// Helpers, not service functions: the first two are pure and the third reads
// the ledger through an injected query. They take typed arguments from the
// services that own the Zod boundary (discovery, quotes), so they carry none
// themselves (src/CLAUDE.md rule 4).
export function dailyCapOf(value: string | undefined, defaultCap: number): DailyCap {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return { cap: defaultCap, capSource: "default" };
  const parsed = dailyCapSchema.safeParse(trimmed);
  return parsed.success
    ? { cap: parsed.data, capSource: "env" }
    : { cap: defaultCap, capSource: "invalid" };
}

/**
 * Counts a provider's successful ledger calls by operation over a period.
 * The real one is db/queries/api-usage.countOkCallsByOperation over the
 * application database; a test injects its own.
 */
export type CountOkCalls = (
  period: ProviderPeriod,
  deps: { db?: QueryDb },
) => Promise<OkCallsByOperation[]>;

/** The ledger query over the application database, or the handle given. */
export const countOkCallsInLedger: CountOkCalls = async (period, deps) =>
  countOkCallsByOperation(deps.db ?? (await defaultDb()), period);

/** The day's successful calls for the operations that count, from the rows the ledger returned. */
export function usedTodayOf(
  rows: readonly OkCallsByOperation[],
  counts: (operation: string) => boolean,
): number {
  return rows.filter((row) => counts(row.operation)).reduce((sum, row) => sum + row.count, 0);
}
