// quotes: prices for one tracked variant from every source kind, with each
// retailer's outcome reported side by side.
//
// Three functions, one per source kind (ADR-0012): fetchQuotes reads every
// readable retailer page now, searchQuotes asks Google Shopping for every
// seller, fetchHistory reads the Wayback Machine's copies of every page.
//
// fetchQuotes is layered, cheapest route first: the page's structured data
// (free), then the model on a page without any (ADR-0013), and only for a
// retailer still without a price, one Google Shopping search (paid, up to four requests).
// When every page answers, the search is never made.
//
// A spike per ADR-0012. Nothing here is persisted; a quote is a fact seen at
// a moment. When the catalog, retailers and listings services exist, a quote
// becomes an observations.record call and the tracked-products table becomes
// rows.

import { z } from "zod";
import { slugify } from "@/lib/slug";
import { canonicaliseUrl } from "@/lib/url";
import {
  archiveSources,
  pageSources,
  REVIEW_THRESHOLD,
  searchSources,
  SourceError,
} from "@/sources";
import type {
  FetchLike,
  LlmExtractInput,
  PriceQuote,
  QuoteCondition,
  SourceErrorKind,
  SourceInput,
} from "@/sources";
import { NotFoundError, ValidationError } from "./errors";
import { trackedVariants, type TrackedRetailerPage, type TrackedVariant } from "./tracked-products";

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
}

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const slugSchema = z.string().min(1).regex(SLUG_RE, "Expected a kebab-case slug");
const fetchSchema = z.custom<FetchLike>((value) => typeof value === "function").optional();
const nowSchema = z.custom<() => Date>((value) => typeof value === "function").optional();

const fetchQuotesInputSchema = z.object({
  slug: slugSchema,
  geminiApiKey: z.string().optional(),
  serpApiKey: z.string().optional(),
  fetch: fetchSchema,
  now: nowSchema,
});

/** A key from the argument or the environment; null when neither is set. Never put in a report. */
function keyOf(given: string | undefined, fromEnv: string | undefined): string | null {
  const key = given ?? fromEnv;
  return key === undefined || key.trim() === "" ? null : key;
}

function geminiKeyOf(given: string | undefined): string | null {
  return keyOf(given, process.env.GEMINI_API_KEY);
}

function serpApiKeyOf(given: string | undefined): string | null {
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
): Promise<PageRead> {
  const pageInput: SourceInput = {
    retailerSlug: page.retailerSlug,
    retailerName: page.retailerName,
    url: page.url,
    fetch,
    now,
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

  const fetchedAt = now();
  const settled = await Promise.allSettled(
    variant.pages.map(async (page): Promise<PageRead | null> => {
      if (page.source === null) return null;
      return readPage(page, page.source, geminiApiKey, fetch, now);
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
        found = await runSearch(variant, serpApiKey, fetch, now);
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
  };
}

// ---------- Search: every seller an aggregator lists ----------

export interface SearchQuotesInput {
  slug: string;
  /** Defaults to process.env.SERPAPI_API_KEY. Missing key throws ValidationError. */
  apiKey?: string;
  fetch?: FetchLike;
  now?: () => Date;
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
}

const searchQuotesInputSchema = z.object({
  slug: slugSchema,
  apiKey: z.string().optional(),
  fetch: fetchSchema,
  now: nowSchema,
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

  const fetchedAt = now();
  let outcome: SearchOutcome;
  try {
    const quotes = await runSearch(variant, apiKey, fetch, now);
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
  fetch?: FetchLike;
  now?: () => Date;
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
  /** The lowest archived price across every page, or null when none parsed. */
  lowest: { retailerSlug: string; priceCents: number; observedAt: Date } | null;
}

const DEFAULT_MAX_SNAPSHOTS_PER_PAGE = 12;

const fetchHistoryInputSchema = z.object({
  slug: slugSchema,
  from: z.date().optional(),
  to: z.date().optional(),
  maxSnapshotsPerPage: z.number().int().positive().default(DEFAULT_MAX_SNAPSHOTS_PER_PAGE),
  fetch: fetchSchema,
  now: nowSchema,
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

/** The lowest price across every ok page, earliest on ties, in page order. */
function lowestOf(pages: readonly HistoryPage[]): HistoryReport["lowest"] {
  let lowest: HistoryReport["lowest"] = null;
  for (const page of pages) {
    if (page.status !== "ok") continue;
    for (const point of page.points) {
      const lower =
        lowest === null ||
        point.priceCents < lowest.priceCents ||
        (point.priceCents === lowest.priceCents && point.observedAt < lowest.observedAt);
      if (lower) {
        lowest = {
          retailerSlug: page.retailerSlug,
          priceCents: point.priceCents,
          observedAt: point.observedAt,
        };
      }
    }
  }
  return lowest;
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

  // Every page is tried, whatever its live `source`: an archived copy is HTML
  // with JSON-LD even for a Shopify store, and a bot-protected site may still
  // have been captured.
  const fetchedAt = now();
  const settled = await Promise.allSettled(
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
      }),
    ),
  );

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
    lowest: lowestOf(pages),
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
  const modelInput: LlmExtractInput = {
    retailerSlug: slugify(hostname.replace(/^www\./, "")) || UNKNOWN_RETAILER_SLUG,
    retailerName: hostname,
    url,
    apiKey,
    fetch,
    now,
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
  };
}
