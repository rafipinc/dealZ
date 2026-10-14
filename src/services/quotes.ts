// quotes: prices for one tracked variant from every source kind, with each
// retailer's outcome reported side by side.
//
// Three functions, one per source kind (ADR-0012): fetchQuotes reads every
// readable retailer page now, searchQuotes asks Google Shopping for every
// seller, fetchHistory reads the Wayback Machine's copies of every page and,
// from the same button, asks a model with web search for dated price pages
// and verifies each on its page (ADR-0020). The model search is gated by a
// key and OPENAI_DAILY_CAP, counted from the usage ledger, and its failure
// never fails the archive, nor the archive's failure the model search.
//
// fetchQuotes is layered, cheapest route first: the page's structured data
// (free), then the model on a page without any (ADR-0013), and only for a
// retailer still without a price, one Google Shopping search (paid, up to four requests).
// When every page answers, the search is never made.
//
// A spike per ADR-0012. No price here is persisted; a quote is a fact seen at
// a moment. When the catalog, retailers and listings services exist, a quote
// becomes an observations.record call and the tracked-products table becomes
// rows.
//
// What is written is the usage ledger: every request a source makes is
// metered and recorded through usage.record with the variant's slug. That is
// best effort. A ledger that cannot be written never fails a fetch; each
// report's `usage` says how many calls were made and how many were recorded.

import { z } from "zod";
import type { QueryDb } from "@/db/queries/db";
import { dayRangeIn, SYDNEY } from "@/lib/day-ranges";
import type { ClaimVerdict, FragmentMatch } from "@/lib/history-evidence";
import { slugify } from "@/lib/slug";
import { canonicaliseUrl } from "@/lib/url";
import {
  archiveSources,
  historySearch,
  pageSources,
  REVIEW_THRESHOLD,
  searchSources,
  SourceError,
} from "@/sources";
import type {
  AssessedClaim,
  FetchLike,
  HistorySearchResult,
  LlmExtractInput,
  Meter,
  PriceQuote,
  QuoteCondition,
  SourceErrorKind,
  SourceInput,
} from "@/sources";
import { countOkCallsInLedger, dailyCapOf, usedTodayOf, type CountOkCalls } from "./daily-cap";
import { NotFoundError, ValidationError } from "./errors";
import { trackedVariants, type TrackedRetailerPage, type TrackedVariant } from "./tracked-products";
import { usageLedger, type UsageRecorder, type UsageRecording } from "./usage-ledger";

export { USAGE_WRITE_TIMEOUT_MS } from "./usage-ledger";
export type { UsageRecorder, UsageRecording } from "./usage-ledger";
export type { CountOkCalls } from "./daily-cap";

export interface FetchQuotesInput {
  /** Slug of a tracked variant, see tracked-products.ts. */
  slug: string;
  /**
   * Lets the model read a page that carries no structured data (ADR-0013).
   * Defaults to process.env.GEMINI_API_KEY. With neither set, such a page
   * stays a failed outcome of kind "unparseable".
   */
  geminiApiKey?: string;
  /**
   * Lets a Google Shopping search fill in a retailer whose page gave no price.
   * Defaults to process.env.SERPAPI_API_KEY. With neither set, such a retailer
   * stays skipped or failed. The search is made only when there is a gap.
   */
  serpApiKey?: string;
  /** Injected so tests replay fixtures. Defaults to globalThis.fetch. */
  fetch?: FetchLike;
  /** Injected clock. Defaults to () => new Date(). */
  now?: () => Date;
  /** Injected so tests need no database. Defaults to usage.record. */
  recordUsage?: UsageRecorder;
}

/** Which tracked identifier the page agreed with, in trust order (ADR-0004). */
export type IdentifierMatch = "gtin" | "mpn" | "none";

interface OutcomeBase {
  retailerSlug: string;
  retailerName: string;
  url: string;
}

export interface QuoteOutcomeOk extends OutcomeBase {
  status: "ok";
  quote: PriceQuote;
  /** True when the page source found no structured data and the model read the page instead (ADR-0013). */
  readByModel: boolean;
  /**
   * Shown as a candidate, never as a price: quote.confidence is below
   * REVIEW_THRESHOLD, or a search fill is for a listing that is not new.
   */
  needsReview: boolean;
  /** True when the page gave no price and the quote came from the search source instead. */
  filledBySearch: boolean;
  /** Why the page itself gave no price, when filledBySearch. Null otherwise. */
  gapReason: string | null;
  identifierMatch: IdentifierMatch;
  isCheapest: boolean;
  /** This price minus the cheapest ok price. Zero for the cheapest. */
  deltaFromCheapestCents: number;
  /** This price minus the variant's RRP. Negative means under RRP. */
  deltaFromRrpCents: number;
}

export interface QuoteOutcomeFailed extends OutcomeBase {
  status: "failed";
  kind: SourceErrorKind;
  message: string;
}

export interface QuoteOutcomeSkipped extends OutcomeBase {
  status: "skipped";
  reason: string;
}

export type QuoteOutcome = QuoteOutcomeOk | QuoteOutcomeFailed | QuoteOutcomeSkipped;

/**
 * What the search layer did for the retailers whose pages gave no price.
 * `gaps` counts those retailers; `filled` counts the ones the search priced.
 */
export type GapFill =
  | { status: "not_needed" }
  | { status: "no_key"; gaps: number }
  | { status: "ok"; gaps: number; filled: number; query: string }
  | { status: "failed"; gaps: number; kind: SourceErrorKind; message: string };

export interface QuoteReport {
  variant: {
    slug: string;
    displayName: string;
    mpn: string;
    gtin: string;
    rrpCents: number;
  };
  fetchedAt: Date;
  /** Ok outcomes first, cheapest to dearest, then failed, then skipped. */
  outcomes: QuoteOutcome[];
  cheapest: { retailerSlug: string; priceCents: number } | null;
  gapFill: GapFill;
  usage: UsageRecording;
}

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const slugSchema = z.string().min(1).regex(SLUG_RE, "Expected a kebab-case slug");
const fetchSchema = z.custom<FetchLike>((value) => typeof value === "function").optional();
const nowSchema = z.custom<() => Date>((value) => typeof value === "function").optional();
const recordUsageSchema = z
  .custom<UsageRecorder>((value) => typeof value === "function")
  .optional();
const countOkCallsSchema = z
  .custom<CountOkCalls>((value) => typeof value === "function")
  .optional();
const dbSchema = z
  .custom<QueryDb>((value) => typeof value === "object" && value !== null)
  .optional();

const fetchQuotesInputSchema = z.object({
  slug: slugSchema,
  geminiApiKey: z.string().optional(),
  serpApiKey: z.string().optional(),
  fetch: fetchSchema,
  now: nowSchema,
  recordUsage: recordUsageSchema,
});

/** A key from the argument or the environment; null when neither is set. Never put in a report. */
function keyOf(given: string | undefined, fromEnv: string | undefined): string | null {
  const key = given ?? fromEnv;
  return key === undefined || key.trim() === "" ? null : key;
}

function geminiKeyOf(given: string | undefined): string | null {
  return keyOf(given, process.env.GEMINI_API_KEY);
}

function openAiKeyOf(given: string | undefined): string | null {
  return keyOf(given, process.env.OPENAI_API_KEY);
}

/** The SerpApi key from the argument or SERPAPI_API_KEY; null when neither is set. Shared with discovery. */
// A key lookup helper, not a service function: there is no input to validate, only a string to prefer.
export function serpApiKeyOf(given: string | undefined): string | null {
  return keyOf(given, process.env.SERPAPI_API_KEY);
}

/** The threshold rule from ADR-0013: below it a quote is a candidate, never a price. */
function needsReviewOf(quote: PriceQuote): boolean {
  return quote.confidence < REVIEW_THRESHOLD;
}

function normaliseCode(value: string | null): string | null {
  return value === null ? null : value.trim().toUpperCase();
}

/**
 * GTIN agreement is the strongest match. The MPN counts when the page labels
 * it as mpn or model, or when the retailer's own SKU is the model code, as on
 * a manufacturer's store.
 */
function matchIdentifier(quote: PriceQuote, variant: TrackedVariant): IdentifierMatch {
  if (quote.identifiers.gtin === variant.gtin) return "gtin";
  const target = normaliseCode(variant.mpn);
  const mpn = normaliseCode(quote.identifiers.mpn);
  const sku = normaliseCode(quote.identifiers.retailerSku);
  if (mpn === target || sku === target) return "mpn";
  return "none";
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** A rejected source as a failure: its SourceError kind, or network for anything else. */
function failureOf(reason: unknown): { kind: SourceErrorKind; message: string } {
  const kind = reason instanceof SourceError ? reason.kind : "network";
  return { kind, message: messageOf(reason) };
}

function pageBase(page: TrackedRetailerPage): OutcomeBase {
  return { retailerSlug: page.retailerSlug, retailerName: page.retailerName, url: page.url };
}

function findVariant(slug: string): TrackedVariant {
  const variant = trackedVariants.find((candidate) => candidate.slug === slug);
  if (variant === undefined) {
    throw new NotFoundError(`No tracked variant with slug "${slug}"`);
  }
  return variant;
}

function summariseVariant(variant: TrackedVariant): QuoteReport["variant"] {
  return {
    slug: variant.slug,
    displayName: variant.displayName,
    mpn: variant.mpn,
    gtin: variant.gtin,
    rrpCents: variant.rrpCents,
  };
}

interface PageRead {
  quote: PriceQuote;
  readByModel: boolean;
}

/** A tracked variant's configured search, run once. Shared by the gap fill and searchQuotes. */
function runSearch(
  variant: TrackedVariant,
  apiKey: string,
  fetch: FetchLike | undefined,
  now: () => Date,
  meter: Meter,
): Promise<PriceQuote[]> {
  const search = variant.searches[0];
  return searchSources[search.method]({
    query: search.query,
    // The series picks the product entity; the size or the model code verifies the variant.
    mustMatch: [variant.series],
    verifyTokens: [variant.size, variant.mpn],
    region: variant.region,
    apiKey,
    fetch,
    now,
    meter,
  });
}

/**
 * A fill stands in for a page nobody read, so it is held to more than its
 * confidence: a listing that is not new is a candidate too.
 */
function fillNeedsReview(quote: PriceQuote): boolean {
  return needsReviewOf(quote) || quote.condition !== "new";
}

/**
 * The search quote that stands in for one tracked retailer: a price before a
 * candidate, then the lowest. A seller can list twice. Null when the search
 * did not list the retailer.
 */
function searchQuoteFor(
  page: TrackedRetailerPage,
  quotes: readonly PriceQuote[],
  variant: TrackedVariant,
): PriceQuote | null {
  let best: PriceQuote | null = null;
  for (const quote of quotes) {
    if (trackedRetailerOf(quote, variant) !== page.retailerSlug) continue;
    const better =
      best === null ||
      (fillNeedsReview(best) && !fillNeedsReview(quote)) ||
      (fillNeedsReview(best) === fillNeedsReview(quote) && quote.priceCents < best.priceCents);
    if (better) best = quote;
  }
  return best;
}

/**
 * Runs the page's declared source. When that source finds no structured data
 * and a model key is at hand, the model reads the same page instead
 * (ADR-0013) and the read says so. Any other failure, and an unparseable
 * page without a key, propagates as it is.
 */
async function readPage(
  page: TrackedRetailerPage,
  source: NonNullable<TrackedRetailerPage["source"]>,
  geminiApiKey: string | null,
  fetch: FetchLike | undefined,
  now: () => Date,
  meter: Meter,
): Promise<PageRead> {
  const pageInput: SourceInput = {
    retailerSlug: page.retailerSlug,
    retailerName: page.retailerName,
    url: page.url,
    fetch,
    now,
    meter,
  };
  try {
    return { quote: await pageSources[source](pageInput), readByModel: source === "llm_extract" };
  } catch (error) {
    const unparseable = error instanceof SourceError && error.kind === "unparseable";
    if (!unparseable || geminiApiKey === null || source === "llm_extract") throw error;
    const modelInput: LlmExtractInput = { ...pageInput, apiKey: geminiApiKey };
    return { quote: await pageSources.llm_extract(modelInput), readByModel: true };
  }
}

export async function fetchQuotes(input: FetchQuotesInput): Promise<QuoteReport> {
  const parsed = fetchQuotesInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Invalid fetchQuotes input", parsed.error.issues);
  }
  const { slug, fetch } = parsed.data;
  const now = parsed.data.now ?? (() => new Date());
  // The key goes to the source and nowhere else; no report includes it.
  const geminiApiKey = geminiKeyOf(parsed.data.geminiApiKey);

  const variant = findVariant(slug);
  const ledger = usageLedger(parsed.data.recordUsage);

  const fetchedAt = now();
  const settled = await Promise.allSettled(
    variant.pages.map(async (page): Promise<PageRead | null> => {
      if (page.source === null) return null;
      return readPage(page, page.source, geminiApiKey, fetch, now, ledger.meter);
    }),
  );

  interface Quoted {
    page: TrackedRetailerPage;
    read: PageRead;
    needsReview: boolean;
    /** Why the page itself gave no price; null when the page was read. */
    gapReason: string | null;
  }
  interface Gap {
    page: TrackedRetailerPage;
    /** Why the page gave no price, as the filled row will say it. */
    reason: string;
    outcome: QuoteOutcomeFailed | QuoteOutcomeSkipped;
  }
  const quoted: Quoted[] = [];
  let gaps: Gap[] = [];
  variant.pages.forEach((page, index) => {
    const result = settled[index];
    if (result.status === "rejected") {
      const failure = failureOf(result.reason);
      gaps.push({
        page,
        reason: `${failure.kind}: ${failure.message}`,
        outcome: { ...pageBase(page), status: "failed", ...failure },
      });
    } else if (result.value === null) {
      const reason = page.note ?? "No readable source";
      gaps.push({ page, reason, outcome: { ...pageBase(page), status: "skipped", reason } });
    } else {
      const read = result.value;
      quoted.push({ page, read, needsReview: needsReviewOf(read.quote), gapReason: null });
    }
  });

  // The last layer. One search (up to four paid requests), and only when a
  // retailer is still without a price: the search costs money and the pages
  // do not.
  let gapFill: GapFill = { status: "not_needed" };
  if (gaps.length > 0) {
    const gapCount = gaps.length;
    // The key goes to the source and nowhere else; no report includes it.
    const serpApiKey = serpApiKeyOf(parsed.data.serpApiKey);
    if (serpApiKey === null) {
      gapFill = { status: "no_key", gaps: gapCount };
    } else {
      let found: PriceQuote[] | null = null;
      try {
        found = await runSearch(variant, serpApiKey, fetch, now, ledger.meter);
      } catch (reason) {
        gapFill = { status: "failed", gaps: gapCount, ...failureOf(reason) };
      }
      if (found !== null) {
        const unfilled: Gap[] = [];
        for (const gap of gaps) {
          const quote = searchQuoteFor(gap.page, found, variant);
          if (quote === null) {
            unfilled.push(gap);
            continue;
          }
          quoted.push({
            page: gap.page,
            read: { quote, readByModel: false },
            needsReview: fillNeedsReview(quote),
            gapReason: gap.reason,
          });
        }
        gaps = unfilled;
        gapFill = {
          status: "ok",
          gaps: gapCount,
          filled: gapCount - gaps.length,
          query: variant.searches[0].query,
        };
      }
    }
  }
  const failed = gaps.map((gap) => gap.outcome).filter((o) => o.status === "failed");
  const skipped = gaps.map((gap) => gap.outcome).filter((o) => o.status === "skipped");

  // A candidate (below the review threshold) never wins: it is not a price yet.
  let cheapest: QuoteReport["cheapest"] = null;
  for (const { page, read, needsReview } of quoted) {
    if (needsReview) continue;
    if (cheapest === null || read.quote.priceCents < cheapest.priceCents) {
      cheapest = { retailerSlug: page.retailerSlug, priceCents: read.quote.priceCents };
    }
  }
  const cheapestCents = cheapest?.priceCents;

  const ok: QuoteOutcomeOk[] = quoted
    .map(({ page, read, needsReview, gapReason }) => ({
      ...pageBase(page),
      status: "ok" as const,
      quote: read.quote,
      readByModel: read.readByModel,
      needsReview,
      filledBySearch: gapReason !== null,
      gapReason,
      identifierMatch: matchIdentifier(read.quote, variant),
      isCheapest: cheapest !== null && page.retailerSlug === cheapest.retailerSlug,
      deltaFromCheapestCents:
        cheapestCents === undefined ? 0 : read.quote.priceCents - cheapestCents,
      deltaFromRrpCents: read.quote.priceCents - variant.rrpCents,
    }))
    .sort((a, b) => a.quote.priceCents - b.quote.priceCents);

  return {
    variant: summariseVariant(variant),
    fetchedAt,
    outcomes: [...ok, ...failed, ...skipped],
    cheapest,
    gapFill,
    usage: await ledger.flush(variant.slug),
  };
}

// ---------- Search: every seller an aggregator lists ----------

export interface SearchQuotesInput {
  slug: string;
  /** Defaults to process.env.SERPAPI_API_KEY. Missing key throws ValidationError. */
  apiKey?: string;
  fetch?: FetchLike;
  now?: () => Date;
  /** Defaults to usage.record. */
  recordUsage?: UsageRecorder;
}

export interface SearchQuote {
  quote: PriceQuote;
  /** True when quote.confidence is below REVIEW_THRESHOLD: a candidate, never the cheapest (ADR-0013). */
  needsReview: boolean;
  /** The tracked retailer this seller is, by slug or alias, or null for a new seller. */
  trackedRetailerSlug: string | null;
  identifierMatch: IdentifierMatch;
  isCheapest: boolean;
  deltaFromCheapestCents: number;
  deltaFromRrpCents: number;
}

export type SearchOutcome =
  | {
      status: "ok";
      quotes: SearchQuote[];
      cheapest: { retailerSlug: string; priceCents: number } | null;
    }
  | { status: "failed"; kind: SourceErrorKind; message: string };

export interface SearchReport {
  variant: QuoteReport["variant"];
  fetchedAt: Date;
  method: "serpapi_google_shopping";
  query: string;
  outcome: SearchOutcome;
  usage: UsageRecording;
}

const searchQuotesInputSchema = z.object({
  slug: slugSchema,
  apiKey: z.string().optional(),
  fetch: fetchSchema,
  now: nowSchema,
  recordUsage: recordUsageSchema,
});

/**
 * The tracked retailer a seller is, by slug first, then by the seller name
 * the aggregator printed against the page's aliases. Null for a new seller.
 */
function trackedRetailerOf(quote: PriceQuote, variant: TrackedVariant): string | null {
  const bySlug = variant.pages.find((page) => page.retailerSlug === quote.retailerSlug);
  if (bySlug !== undefined) return bySlug.retailerSlug;
  const name = quote.retailerName?.trim().toLowerCase();
  if (name === undefined || name === "") return null;
  const byAlias = variant.pages.find((page) => page.aliases.includes(name));
  return byAlias?.retailerSlug ?? null;
}

/** Index of the cheapest quote that does not need review; -1 when none qualifies. First on ties. */
function cheapestIndexOf(quotes: readonly PriceQuote[]): number {
  let best = -1;
  quotes.forEach((quote, index) => {
    if (quote.confidence < REVIEW_THRESHOLD) return;
    if (best === -1 || quote.priceCents < quotes[best].priceCents) best = index;
  });
  return best;
}

function searchOutcomeOf(quotes: PriceQuote[], variant: TrackedVariant): SearchOutcome {
  const cheapestIndex = cheapestIndexOf(quotes);
  const cheapestCents = cheapestIndex === -1 ? 0 : quotes[cheapestIndex].priceCents;
  return {
    status: "ok",
    quotes: quotes.map((quote, index) => ({
      quote,
      trackedRetailerSlug: trackedRetailerOf(quote, variant),
      identifierMatch: matchIdentifier(quote, variant),
      needsReview: quote.confidence < REVIEW_THRESHOLD,
      isCheapest: index === cheapestIndex,
      deltaFromCheapestCents: quote.priceCents - cheapestCents,
      deltaFromRrpCents: quote.priceCents - variant.rrpCents,
    })),
    cheapest:
      cheapestIndex === -1
        ? null
        : { retailerSlug: quotes[cheapestIndex].retailerSlug, priceCents: cheapestCents },
  };
}

export async function searchQuotes(input: SearchQuotesInput): Promise<SearchReport> {
  const parsed = searchQuotesInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Invalid searchQuotes input", parsed.error.issues);
  }
  const { slug, fetch } = parsed.data;
  const now = parsed.data.now ?? (() => new Date());

  // The key goes to the source and nowhere else; no report includes it.
  const apiKey = serpApiKeyOf(parsed.data.apiKey);
  if (apiKey === null) {
    throw new ValidationError("SERPAPI_API_KEY is not set");
  }

  const variant = findVariant(slug);
  const search = variant.searches[0];
  const ledger = usageLedger(parsed.data.recordUsage);

  const fetchedAt = now();
  let outcome: SearchOutcome;
  try {
    const quotes = await runSearch(variant, apiKey, fetch, now, ledger.meter);
    outcome = searchOutcomeOf(quotes, variant);
  } catch (reason) {
    outcome = { status: "failed", ...failureOf(reason) };
  }

  return {
    variant: summariseVariant(variant),
    fetchedAt,
    method: search.method,
    query: search.query,
    outcome,
    usage: await ledger.flush(variant.slug),
  };
}

// ---------- History: archived snapshots of every tracked page ----------

export interface FetchHistoryInput {
  slug: string;
  /** Defaults to the variant's onSaleFrom. */
  from?: Date;
  /** Defaults to now(). */
  to?: Date;
  /** Defaults to 12. */
  maxSnapshotsPerPage?: number;
  /**
   * Lets a model with web search look for dated price pages alongside the
   * archive (ADR-0020). Defaults to process.env.OPENAI_API_KEY. With neither
   * set the model search is skipped, never an error. Never put in a report.
   */
  openAiApiKey?: string;
  fetch?: FetchLike;
  now?: () => Date;
  /** Defaults to usage.record. */
  recordUsage?: UsageRecorder;
  /** Injected so tests need no ledger. Defaults to the ledger query over the application database. */
  countOkCalls?: CountOkCalls;
  db?: QueryDb;
}

// ---------- Model search: what the model found and what the pages confirmed (ADR-0020) ----------

/** The environment variable that caps the day's model searches; unset means DEFAULT_OPENAI_DAILY_CAP. */
export const OPENAI_DAILY_CAP_ENV = "OPENAI_DAILY_CAP";
/** Requests per Sydney day, by default. About 5 cents a request (ADR-0020). */
export const DEFAULT_OPENAI_DAILY_CAP = 10;
/** The ledger operation that counts against the cap: one row per Responses API request. */
const OPENAI_REQUEST_OPERATION = "responses";
/** The provider as the ledger names it. */
const OPENAI_PROVIDER = "openai";

/**
 * A point the model found and the page confirmed: the quoted fragment is on
 * the page verbatim and the page or its URL carries a date. Confidence 0.8,
 * so it charts solid, below an archive capture (0.9). It links to the page it
 * was verified on, as ADR-0020 item 6 requires.
 */
export interface HistoryModelPoint {
  /** The retailer as the model named it, slugified; "jb-hi-fi" for "JB Hi-Fi". */
  retailerSlug: string;
  /** The retailer as the model named it; the page's host when it named none. */
  retailerName: string;
  /** Midnight, Australia/Sydney, of the date the page or its URL states. Never the model's date. */
  observedAt: Date;
  priceCents: number;
  /** The page the point was verified on. The chart links here. */
  sourceUrl: string;
  /** The fragment on the page that states the price. */
  quote: string;
  confidence: number;
  /** Whether the date came from the URL (a dated catalogue path) or the page's own markup. */
  dateSource: "url" | "page" | null;
}

/**
 * One claim the model made, with the verdict the page gave it and why. The
 * lab lists these under the chart. `claimedDate` is the model's own date,
 * shown so a reader can see how far it was from the page's; it is never
 * charted and never compared.
 */
export interface HistoryModelClaim {
  retailerSlug: string;
  retailerName: string;
  priceCents: number;
  /** The page as the model cited it. */
  sourceUrl: string;
  /** The fragment the model said states the price; "" when it gave none. */
  quote: string;
  /** The model's own date, as written, or null. Display only. */
  claimedDate: string | null;
  /** "candidate": fragment matched weakly or the page is undated. "unverified": the page could not be fetched. "rejected": fetched, fragment absent, or domain not allowed. */
  verdict: ClaimVerdict;
  /** 0.6 or 0.5 candidate, 0.4 unverified, 0.3 rejected (lib/history-evidence). */
  confidence: number;
  /** ISO date read from the URL or the page, when one was read. */
  observedDate: string | null;
  /** `observedDate` at midnight in Australia/Sydney, when there is one. */
  observedAt: Date | null;
  /** How the quote matched the page; null when the page was not read. */
  fragment: FragmentMatch | null;
  dateSource: "url" | "page" | null;
  /** One line per rule that fired, in order. */
  reasons: string[];
}

/**
 * Why the model was not asked. "no-key": no OPENAI_API_KEY. "disabled":
 * OPENAI_DAILY_CAP is 0. "daily-cap": today's requests in the ledger are at
 * or over the cap. "budget-unknown": the ledger could not be read, and
 * nothing is spent blind.
 */
export type HistoryModelSkipReason = "no-key" | "disabled" | "daily-cap" | "budget-unknown";

/**
 * What the model search did. "ok" means the model answered; its claims are
 * sorted by the verdict the pages gave them, and an answer with no claims
 * is ok with every list empty. A failure here never fails the archive pages.
 */
export type HistoryModelSearch =
  | { status: "skipped"; reason: HistoryModelSkipReason }
  | { status: "failed"; kind: SourceErrorKind; message: string }
  | {
      status: "ok";
      /** The model the provider reports. */
      model: string;
      /** Searches the model made, each billed. */
      searches: number;
      /** Pages the model opened, not billed. */
      pageOpens: number;
      /** Chart these, solid. Oldest first. */
      verified: HistoryModelPoint[];
      /** Fragment matched weakly, or the page is undated. Listed with the reason, never charted. */
      candidates: HistoryModelClaim[];
      /** Fetched and the fragment is not there, or the domain is not allowed. Listed with the reason. */
      rejected: HistoryModelClaim[];
      /** The page could not be fetched, so nothing was checked. Listed. */
      unverified: HistoryModelClaim[];
    };

/** The lowest price in the report and which kind of point it is: an archive capture or a verified model-found point. */
export interface HistoryLowest {
  kind: "archive" | "model";
  retailerSlug: string;
  priceCents: number;
  observedAt: Date;
}

export interface HistoryPoint {
  observedAt: Date;
  priceCents: number;
  strikethroughCents: number | null;
  condition: QuoteCondition;
  snapshotUrl: string;
}

interface HistoryPageBase {
  retailerSlug: string;
  retailerName: string;
  url: string;
}

export interface HistorySkippedSnapshot {
  snapshotUrl: string;
  observedAt: Date;
  kind: SourceErrorKind;
  message: string;
}

export interface HistoryPageOk extends HistoryPageBase {
  status: "ok";
  /** Oldest first. Empty when the archive holds no readable snapshot. */
  points: HistoryPoint[];
  /** Captures the archive listed in the window. Zero means never captured. */
  snapshotsFound: number;
  /** Captures that did not become points, with the reason each. */
  skipped: HistorySkippedSnapshot[];
}

export interface HistoryPageFailed extends HistoryPageBase {
  status: "failed";
  kind: SourceErrorKind;
  message: string;
}

export type HistoryPage = HistoryPageOk | HistoryPageFailed;

export interface HistoryReport {
  variant: QuoteReport["variant"];
  fetchedAt: Date;
  from: Date;
  to: Date;
  /** Same order as the tracked pages. */
  pages: HistoryPage[];
  /** The model search, run alongside the archive for the same window (ADR-0020). */
  modelSearch: HistoryModelSearch;
  /** The lowest price across every archive page and every verified model point; null when there is none. */
  lowest: HistoryLowest | null;
  /** Every call the archive and the model search made, written to one ledger. */
  usage: UsageRecording;
}

const DEFAULT_MAX_SNAPSHOTS_PER_PAGE = 12;

const fetchHistoryInputSchema = z.object({
  slug: slugSchema,
  from: z.date().optional(),
  to: z.date().optional(),
  maxSnapshotsPerPage: z.number().int().positive().default(DEFAULT_MAX_SNAPSHOTS_PER_PAGE),
  openAiApiKey: z.string().optional(),
  fetch: fetchSchema,
  now: nowSchema,
  recordUsage: recordUsageSchema,
  countOkCalls: countOkCallsSchema,
  db: dbSchema,
});

function historyPointOf(quote: PriceQuote): HistoryPoint {
  return {
    observedAt: quote.observedAt,
    priceCents: quote.priceCents,
    strikethroughCents: quote.strikethroughCents,
    condition: quote.condition,
    snapshotUrl: quote.provenance.via ?? "",
  };
}

/**
 * The lowest price across every ok archive page and every verified model
 * point, earliest on ties; the archive is considered first, so an archive
 * capture wins an exact tie with a model point.
 */
function lowestOf(
  pages: readonly HistoryPage[],
  modelPoints: readonly HistoryModelPoint[],
): HistoryLowest | null {
  let lowest: HistoryLowest | null = null;
  const consider = (candidate: HistoryLowest) => {
    const lower =
      lowest === null ||
      candidate.priceCents < lowest.priceCents ||
      (candidate.priceCents === lowest.priceCents && candidate.observedAt < lowest.observedAt);
    if (lower) lowest = candidate;
  };
  for (const page of pages) {
    if (page.status !== "ok") continue;
    for (const point of page.points) {
      consider({
        kind: "archive",
        retailerSlug: page.retailerSlug,
        priceCents: point.priceCents,
        observedAt: point.observedAt,
      });
    }
  }
  for (const point of modelPoints) {
    consider({
      kind: "model",
      retailerSlug: point.retailerSlug,
      priceCents: point.priceCents,
      observedAt: point.observedAt,
    });
  }
  return lowest;
}

function modelClaimOf(claim: AssessedClaim): HistoryModelClaim {
  return {
    retailerSlug: claim.retailerSlug,
    retailerName: claim.retailer === "" ? claim.retailerSlug : claim.retailer,
    priceCents: claim.priceCents,
    sourceUrl: claim.sourceUrl,
    quote: claim.quote,
    claimedDate: claim.claimedDate,
    verdict: claim.verdict,
    confidence: claim.confidence,
    observedDate: claim.observedDate,
    observedAt: claim.observedAt,
    fragment: claim.fragment,
    dateSource: claim.dateSource,
    reasons: claim.reasons,
  };
}

/** The source's result sorted by verdict. A verified claim always carries a date; one without is kept as a candidate. */
function modelSearchOf(result: HistorySearchResult): HistoryModelSearch {
  const verified: HistoryModelPoint[] = [];
  const candidates: HistoryModelClaim[] = [];
  const rejected: HistoryModelClaim[] = [];
  const unverified: HistoryModelClaim[] = [];
  for (const claim of result.claims) {
    const row = modelClaimOf(claim);
    if (claim.verdict === "verified" && claim.observedAt !== null) {
      verified.push({
        retailerSlug: row.retailerSlug,
        retailerName: row.retailerName,
        observedAt: claim.observedAt,
        priceCents: row.priceCents,
        sourceUrl: row.sourceUrl,
        quote: row.quote,
        confidence: row.confidence,
        dateSource: row.dateSource,
      });
    } else if (claim.verdict === "rejected") {
      rejected.push(row);
    } else if (claim.verdict === "unverified") {
      unverified.push(row);
    } else {
      candidates.push(row);
    }
  }
  verified.sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  return {
    status: "ok",
    model: result.model,
    searches: result.toolCalls.searches,
    pageOpens: result.toolCalls.pageOpens,
    verified,
    candidates,
    rejected,
    unverified,
  };
}

interface ModelSearchDeps {
  apiKey: string | null;
  fetch: FetchLike | undefined;
  now: () => Date;
  meter: Meter;
  countOkCalls: CountOkCalls;
  db: QueryDb | undefined;
}

/**
 * The model search behind its three gates: a key, a cap above zero, and the
 * day's requests in the ledger under the cap. "Today" is the Sydney day, and
 * the count is the ledger's successful `responses` rows, as the SerpApi
 * budget counts searches. A ledger that cannot be read skips the search:
 * nothing is spent blind. Never throws; a source failure is a failed outcome.
 */
async function runModelSearch(
  variant: TrackedVariant,
  from: Date,
  to: Date,
  deps: ModelSearchDeps,
): Promise<HistoryModelSearch> {
  if (deps.apiKey === null) return { status: "skipped", reason: "no-key" };
  const { cap } = dailyCapOf(process.env[OPENAI_DAILY_CAP_ENV], DEFAULT_OPENAI_DAILY_CAP);
  if (cap === 0) return { status: "skipped", reason: "disabled" };

  let usedToday: number;
  try {
    const day = dayRangeIn(deps.now(), SYDNEY);
    const rows = await deps.countOkCalls(
      { provider: OPENAI_PROVIDER, from: day.from, to: day.to },
      { db: deps.db },
    );
    usedToday = usedTodayOf(rows, (operation) => operation === OPENAI_REQUEST_OPERATION);
  } catch {
    return { status: "skipped", reason: "budget-unknown" };
  }
  if (usedToday >= cap) return { status: "skipped", reason: "daily-cap" };

  try {
    const result = await historySearch.search({
      product: { title: variant.displayName, modelCode: variant.mpn, gtin: variant.gtin },
      from,
      to,
      apiKey: deps.apiKey,
      fetch: deps.fetch,
      now: deps.now,
      meter: deps.meter,
    });
    return modelSearchOf(result);
  } catch (reason) {
    return { status: "failed", ...failureOf(reason) };
  }
}

/** The kind most of the skipped captures failed with; the first one on ties. */
function commonestKind(skipped: readonly { kind: SourceErrorKind }[]): SourceErrorKind {
  const counts = new Map<SourceErrorKind, number>();
  for (const { kind } of skipped) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  let best: SourceErrorKind = skipped[0]?.kind ?? "network";
  for (const [kind, count] of counts) if (count > (counts.get(best) ?? 0)) best = kind;
  return best;
}

export async function fetchHistory(input: FetchHistoryInput): Promise<HistoryReport> {
  const parsed = fetchHistoryInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Invalid fetchHistory input", parsed.error.issues);
  }
  const { slug, fetch, maxSnapshotsPerPage } = parsed.data;
  const now = parsed.data.now ?? (() => new Date());

  const variant = findVariant(slug);
  const from = parsed.data.from ?? new Date(`${variant.onSaleFrom}T00:00:00Z`);
  const to = parsed.data.to ?? now();
  const ledger = usageLedger(parsed.data.recordUsage);
  // The key goes to the source and nowhere else; no report includes it.
  const openAiApiKey = openAiKeyOf(parsed.data.openAiApiKey);

  // Every page is tried, whatever its live `source`: an archived copy is HTML
  // with JSON-LD even for a Shopify store, and a bot-protected site may still
  // have been captured. The model search runs beside the archive, for the
  // same window; neither waits on the other and neither's failure is the
  // other's.
  const fetchedAt = now();
  const [settled, modelSearch] = await Promise.all([
    Promise.allSettled(
      variant.pages.map((page) =>
        archiveSources.wayback({
          retailerSlug: page.retailerSlug,
          retailerName: page.retailerName,
          url: page.url,
          from,
          to,
          maxSnapshots: maxSnapshotsPerPage,
          fetch,
          now,
          meter: ledger.meter,
        }),
      ),
    ),
    runModelSearch(variant, from, to, {
      apiKey: openAiApiKey,
      fetch,
      now,
      meter: ledger.meter,
      countOkCalls: parsed.data.countOkCalls ?? countOkCallsInLedger,
      db: parsed.data.db,
    }),
  ]);

  const pages: HistoryPage[] = variant.pages.map((page, index) => {
    const result = settled[index];
    if (result.status === "rejected") {
      return { ...pageBase(page), status: "failed", ...failureOf(result.reason) };
    }
    const { quotes, snapshotsFound, skipped } = result.value;
    const points = quotes
      .map(historyPointOf)
      .sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
    // Captures listed but none fetched is an outage, not an empty history.
    // A capture that fetched and did not parse is history that is not there.
    if (
      snapshotsFound > 0 &&
      points.length === 0 &&
      skipped.every((s) => s.kind !== "unparseable")
    ) {
      return {
        ...pageBase(page),
        status: "failed",
        kind: commonestKind(skipped),
        message: `${snapshotsFound} ${snapshotsFound === 1 ? "capture" : "captures"} found, none could be fetched: ${skipped[0]?.message ?? "no detail"}`,
      };
    }
    return {
      ...pageBase(page),
      status: "ok",
      points,
      snapshotsFound,
      skipped: skipped
        .map((s) => ({
          snapshotUrl: s.snapshotUrl,
          observedAt: s.observedAt,
          kind: s.kind,
          message: s.message,
        }))
        .sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime()),
    };
  });

  return {
    variant: summariseVariant(variant),
    fetchedAt,
    from,
    to,
    pages,
    modelSearch,
    lowest: lowestOf(pages, modelSearch.status === "ok" ? modelSearch.verified : []),
    usage: await ledger.flush(variant.slug),
  };
}

// ---------- Extract: one page of any store, read by the model (ADR-0013) ----------

export interface ExtractQuoteInput {
  /** Any retailer product page. */
  url: string;
  /** Defaults to process.env.GEMINI_API_KEY. Missing key throws ValidationError. */
  apiKey?: string;
  fetch?: FetchLike;
  now?: () => Date;
  /** Defaults to usage.record. */
  recordUsage?: UsageRecorder;
}

export type ExtractOutcome =
  | {
      status: "ok";
      quote: PriceQuote;
      needsReview: boolean;
      /** Why the confidence is what it is, from the source's rules. */
      reasons: string[];
      /** Which tracked variant the page's identifiers point at, if any. */
      matchedVariantSlug: string | null;
      identifierMatch: IdentifierMatch;
    }
  | { status: "failed"; kind: SourceErrorKind; message: string };

export interface ExtractReport {
  url: string;
  fetchedAt: Date;
  method: "llm_extract";
  outcome: ExtractOutcome;
  usage: UsageRecording;
}

const httpUrlSchema = z.string().refine((value) => {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}, "Expected an absolute http or https URL");

const extractQuoteInputSchema = z.object({
  url: httpUrlSchema,
  apiKey: z.string().optional(),
  fetch: fetchSchema,
  now: nowSchema,
  recordUsage: recordUsageSchema,
});

/** The part of the llm_extract source's `raw` the report repeats. Read defensively: `raw` is unknown by contract. */
const extractRawSchema = z
  .looseObject({ reasons: z.array(z.string()).catch([]) })
  .catch({ reasons: [] });

function reasonsOf(raw: unknown): string[] {
  return extractRawSchema.parse(raw).reasons;
}

/** Used when the host has no letters or digits to slugify. */
const UNKNOWN_RETAILER_SLUG = "unknown-retailer";

/** The tracked variant the page's identifiers point at: GTIN first, then model code. Null for a stranger. */
function variantOfQuote(quote: PriceQuote): TrackedVariant | null {
  const { gtin } = quote.identifiers;
  const mpn = normaliseCode(quote.identifiers.mpn);
  const variant = trackedVariants.find(
    (candidate) =>
      (gtin !== null && candidate.gtin === gtin) ||
      (mpn !== null && normaliseCode(candidate.mpn) === mpn),
  );
  return variant ?? null;
}

/** Reads one page with the model, whatever store it belongs to. Nothing is saved. */
export async function extractQuote(input: ExtractQuoteInput): Promise<ExtractReport> {
  const parsed = extractQuoteInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Invalid extractQuote input", parsed.error.issues);
  }
  const { fetch } = parsed.data;
  const now = parsed.data.now ?? (() => new Date());

  // The key goes to the source and nowhere else; no report includes it.
  const apiKey = geminiKeyOf(parsed.data.apiKey);
  if (apiKey === null) {
    throw new ValidationError("GEMINI_API_KEY is not set");
  }

  // The schema accepted it, so canonicalisation cannot throw here.
  const url = canonicaliseUrl(parsed.data.url);
  const { hostname } = new URL(url);
  const ledger = usageLedger(parsed.data.recordUsage);
  const modelInput: LlmExtractInput = {
    retailerSlug: slugify(hostname.replace(/^www\./, "")) || UNKNOWN_RETAILER_SLUG,
    retailerName: hostname,
    url,
    apiKey,
    fetch,
    now,
    meter: ledger.meter,
  };

  const fetchedAt = now();
  let outcome: ExtractOutcome;
  try {
    const quote = await pageSources.llm_extract(modelInput);
    const matched = variantOfQuote(quote);
    outcome = {
      status: "ok",
      quote,
      needsReview: needsReviewOf(quote),
      reasons: reasonsOf(quote.raw),
      matchedVariantSlug: matched?.slug ?? null,
      identifierMatch: matched === null ? "none" : matchIdentifier(quote, matched),
    };
  } catch (reason) {
    outcome = { status: "failed", ...failureOf(reason) };
  }

  return {
    url: outcome.status === "ok" ? outcome.quote.url : url,
    fetchedAt,
    method: "llm_extract",
    outcome,
    // The page is any store's, so the variant is known only when its identifiers matched one.
    usage: await ledger.flush(outcome.status === "ok" ? outcome.matchedVariantSlug : null),
  };
}
