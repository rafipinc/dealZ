"use server";

// Server actions for the lab page: parse the slug or URL, call one quotes
// service function, shape the report for the client. No business rule lives
// here.

import { NotFoundError, ValidationError } from "@/services/errors";
import { extractQuote, fetchHistory, fetchQuotes, searchQuotes } from "@/services/quotes";
import {
  toExtractView,
  toHistoryView,
  toQuoteView,
  toSearchView,
  type ExtractViewResult,
  type HistoryViewResult,
  type QuoteView,
  type SearchViewResult,
  type ViewError,
} from "./view";

const PRODUCTION_ERROR: ViewError = {
  ok: false,
  error: "The lab is not available in production",
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
  if (process.env.NODE_ENV === "production") return PRODUCTION_ERROR;
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
  if (process.env.NODE_ENV === "production") return PRODUCTION_ERROR;
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
  if (process.env.NODE_ENV === "production") return PRODUCTION_ERROR;
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
  if (process.env.NODE_ENV === "production") return PRODUCTION_ERROR;
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
