"use server";

// Server actions for the lab page: parse the slug or URL, call one quotes
// service function, shape the report for the client. No business rule lives
// here.

import { revalidatePath } from "next/cache";
import { isLocalDevelopment } from "@/lib/local-only";
import { inspectCandidate } from "@/services/discovery";
import { NotFoundError, ValidationError } from "@/services/errors";
import { extractQuote, fetchHistory, fetchQuotes, searchQuotes } from "@/services/quotes";
import { loadSuggestions, runDiscover, runRefreshIndex } from "./index-loaders";
import {
  toExtractView,
  toHistoryView,
  toInspectView,
  toQuoteView,
  toSearchView,
  type DiscoverViewResult,
  type ExtractViewResult,
  type HistoryViewResult,
  type InspectViewResult,
  type QuoteView,
  type RefreshViewResult,
  type SearchViewResult,
  type SuggestViewResult,
  type ViewError,
} from "./view";

// The same gate as the page: each action fires live requests, so each
// refuses on anything but a development server.
const NOT_LOCAL_ERROR: ViewError = {
  ok: false,
  error: "The lab is only available on a development server",
};

function slugOf(formData: FormData): string {
  // The service validates the slug and throws ValidationError for a bad one.
  const slug = formData.get("slug");
  return typeof slug === "string" ? slug : "";
}

function toViewError(error: unknown, verb: string): ViewError {
  if (error instanceof NotFoundError || error instanceof ValidationError) {
    return { ok: false, error: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: `${verb} failed: ${message}` };
}

export async function fetchQuotesAction(
  _prev: QuoteView | null,
  formData: FormData,
): Promise<QuoteView> {
  if (!isLocalDevelopment(process.env.NODE_ENV)) return NOT_LOCAL_ERROR;
  try {
    const report = await fetchQuotes({ slug: slugOf(formData) });
    return toQuoteView(report);
  } catch (error) {
    return toViewError(error, "Fetch");
  }
}

export async function searchQuotesAction(
  _prev: SearchViewResult | null,
  formData: FormData,
): Promise<SearchViewResult> {
  if (!isLocalDevelopment(process.env.NODE_ENV)) return NOT_LOCAL_ERROR;
  try {
    // The service reads SERPAPI_API_KEY itself and throws ValidationError
    // when it is missing; that one case is a set-up notice, not a failure.
    const report = await searchQuotes({ slug: slugOf(formData) });
    return toSearchView(report);
  } catch (error) {
    if (error instanceof ValidationError && error.message.includes("SERPAPI_API_KEY")) {
      return {
        ok: false,
        error:
          "SERPAPI_API_KEY is not set. Store it with scripts/keys.sh set SERPAPI_API_KEY and restart the dev server.",
        notice: true,
      };
    }
    return toViewError(error, "Search");
  }
}

export async function fetchHistoryAction(
  _prev: HistoryViewResult | null,
  formData: FormData,
): Promise<HistoryViewResult> {
  if (!isLocalDevelopment(process.env.NODE_ENV)) return NOT_LOCAL_ERROR;
  try {
    const report = await fetchHistory({ slug: slugOf(formData), maxSnapshotsPerPage: 12 });
    return toHistoryView(report);
  } catch (error) {
    return toViewError(error, "History fetch");
  }
}

function urlOf(formData: FormData): string {
  // Passed raw: the service validates the URL and throws ValidationError for a bad one.
  const url = formData.get("url");
  return typeof url === "string" ? url : "";
}

export async function extractQuoteAction(
  _prev: ExtractViewResult | null,
  formData: FormData,
): Promise<ExtractViewResult> {
  if (!isLocalDevelopment(process.env.NODE_ENV)) return NOT_LOCAL_ERROR;
  try {
    // The service reads GEMINI_API_KEY itself and throws ValidationError
    // when it is missing; that one case is a set-up notice, not a failure.
    const report = await extractQuote({ url: urlOf(formData) });
    return toExtractView(report);
  } catch (error) {
    if (error instanceof ValidationError && error.message.includes("GEMINI_API_KEY")) {
      return {
        ok: false,
        error:
          "GEMINI_API_KEY is not set. Store it with scripts/keys.sh set GEMINI_API_KEY and restart the dev server.",
        notice: true,
      };
    }
    return toViewError(error, "Extraction");
  }
}

function fieldOf(formData: FormData, name: string): string {
  // Passed raw: the service validates the value and throws ValidationError for a bad one.
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * The Enter search (ADR-0017 item 6, miss path decided by Rafi on
 * 2026-10-06): the index first; when it holds too little, the storefronts
 * and Google Shopping together, the latter only with a key and under the
 * daily cap. What the sources return is remembered in the index.
 */
export async function discoverProductsAction(
  _prev: DiscoverViewResult | null,
  formData: FormData,
): Promise<DiscoverViewResult> {
  if (!isLocalDevelopment(process.env.NODE_ENV)) return NOT_LOCAL_ERROR;
  const view = await runDiscover(fieldOf(formData, "q"));
  // The status and budget lines under the search box are rendered by the
  // page; a search that asked the sources changes both.
  if (view.ok && view.source === "fanout") revalidatePath("/lab");
  return view;
}

/** Reads one candidate's product JSON for its identifiers (ADR-0016 item 6). */
export async function inspectCandidateAction(
  _prev: InspectViewResult | null,
  formData: FormData,
): Promise<InspectViewResult> {
  if (!isLocalDevelopment(process.env.NODE_ENV)) return NOT_LOCAL_ERROR;
  try {
    const report = await inspectCandidate({
      retailerSlug: fieldOf(formData, "retailerSlug"),
      url: fieldOf(formData, "url"),
    });
    return toInspectView(report);
  } catch (error) {
    return toViewError(error, "Identifier read");
  }
}

/**
 * The dropdown's query: the local index only, never a store (ADR-0017 item
 * 6). Called by the client on each keystroke after the debounce, so it takes
 * the string itself, not a form.
 */
export async function suggestProductsAction(query: string): Promise<SuggestViewResult> {
  if (!isLocalDevelopment(process.env.NODE_ENV)) return NOT_LOCAL_ERROR;
  // Passed raw: the service validates the length and throws ValidationError for a long one.
  return loadSuggestions(typeof query === "string" ? query : "");
}

/** Pulls the seeded collections into the index (ADR-0017 item 7). Each page is logged to the usage ledger. */
export async function refreshIndexAction(): Promise<RefreshViewResult> {
  if (!isLocalDevelopment(process.env.NODE_ENV)) return NOT_LOCAL_ERROR;
  const view = await runRefreshIndex();
  // The status line under the search box is rendered by the page; re-render it with the new counts.
  revalidatePath("/lab");
  return view;
}
