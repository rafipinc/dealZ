// The catalogue index as the lab page reads it: each loader calls one
// service function and shapes the result, and a database that is down is a
// line to show, never a thrown page (ADR-0017 item 7). Shared by the page
// (the status and budget lines) and the server actions (the dropdown, the
// refresh, the Enter search), so both say the same thing when the index
// cannot be reached. Not a server action file: nothing here is callable
// from the browser.

import { rootCause } from "@/lib/errors";
import { indexStatus, refreshIndex, searchIndex } from "@/services/catalogue-index";
import { discoverProducts, serpApiBudget, type DiscoverProductsInput } from "@/services/discovery";
import { NotFoundError, ValidationError } from "@/services/errors";
import { safeFailureMessage } from "@/services/status";
import {
  indexUnavailableView,
  serpApiBudgetUnavailableView,
  toDiscoverView,
  toIndexStatusView,
  toRefreshView,
  toSerpApiBudgetView,
  toSuggestView,
  type DiscoverViewResult,
  type IndexStatusView,
  type RefreshViewResult,
  type SerpApiBudgetView,
  type SuggestViewResult,
} from "./view";

/** The database handle the services take, for a test that injects one. Defaults to the application database. */
export type IndexDeps = NonNullable<Parameters<typeof indexStatus>[0]>;

/** Rows the dropdown shows (ADR-0017 item 6). */
export const SUGGEST_LIMIT = 8;

const INDEX_UNAVAILABLE = "Index unavailable";

export async function loadIndexStatus(deps: IndexDeps = {}): Promise<IndexStatusView> {
  try {
    return toIndexStatusView(await indexStatus(deps));
  } catch (error) {
    // Redacted: a database error can quote the connection string.
    return indexUnavailableView(safeFailureMessage(rootCause(error)));
  }
}

export async function loadSuggestions(
  query: string,
  deps: IndexDeps = {},
): Promise<SuggestViewResult> {
  try {
    return toSuggestView(await searchIndex({ query, limit: SUGGEST_LIMIT, ...deps }));
  } catch (error) {
    if (error instanceof ValidationError) return { ok: false, error: error.message };
    return { ok: false, error: `${INDEX_UNAVAILABLE}: ${safeFailureMessage(rootCause(error))}` };
  }
}

/** The refresh's injectables: the database, and the fetch and clock a test replaces. */
export type RefreshDeps = NonNullable<Parameters<typeof refreshIndex>[0]>;

export async function runRefreshIndex(deps: RefreshDeps = {}): Promise<RefreshViewResult> {
  try {
    return toRefreshView(await refreshIndex(deps));
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof ValidationError) {
      return { ok: false, error: error.message };
    }
    return { ok: false, error: `Refresh failed: ${safeFailureMessage(rootCause(error))}` };
  }
}

/** The budget's injectables: the database, the clock and the ledger read a test replaces. */
export type BudgetDeps = NonNullable<Parameters<typeof serpApiBudget>[0]>;

/**
 * The day's SerpApi searches against the cap, for the line under the search
 * box. A malformed SERPAPI_DAILY_CAP is not a failure: the service falls
 * back to the default and the line says the setting was ignored.
 */
export async function loadSerpApiBudget(deps: BudgetDeps = {}): Promise<SerpApiBudgetView> {
  try {
    return toSerpApiBudgetView(await serpApiBudget(deps));
  } catch (error) {
    // Redacted: a ledger error can quote the connection string.
    return serpApiBudgetUnavailableView(safeFailureMessage(rootCause(error)));
  }
}

/** Everything discoverProducts takes but the query, for a test that injects its sources. */
export type DiscoverDeps = Omit<DiscoverProductsInput, "query">;

/** The Enter search: the index, then the stores and Google Shopping when it holds too little. */
export async function runDiscover(
  query: string,
  deps: DiscoverDeps = {},
): Promise<DiscoverViewResult> {
  try {
    return toDiscoverView(await discoverProducts({ query, ...deps }));
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof ValidationError) {
      return { ok: false, error: error.message };
    }
    return { ok: false, error: `Search failed: ${safeFailureMessage(rootCause(error))}` };
  }
}
