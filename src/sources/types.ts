// Sources layer: turns retailer data into PriceQuotes, live.
//
// A source does I/O (HTTP requests) and parsing, nothing else. It never
// touches the database and never decides anything. Its output is a fact seen
// on a page at a moment; whether that fact becomes a price_observation is a
// service's call. Proposed in ADR-0012 as a spike ahead of phase 4 ingestion.
//
// Three kinds of source, decided by Rafi on 2026-09-28:
// - Page sources read one retailer page now: one page in, one quote out.
// - Search sources ask an aggregator (Google Shopping through SerpApi) for
//   every seller of a product: one query in, many quotes out, many retailers.
// - Archive sources read the Wayback Machine's copies of one retailer page:
//   one page in, many quotes out, one per snapshot, each dated when it was
//   captured. This is how price history is backfilled.
// - The llm_extract page source (ADR-0013) reads a page's visible text with a
//   language model when the page carries no structured data. The model returns
//   evidence, never a verdict; the source turns evidence into a confidence by
//   fixed rules, and anything below the review threshold is flagged, never
//   trusted on its own.
//
// Rules for this layer (mirrors src/CLAUDE.md rule 9):
// - May import src/lib only. Never src/db, src/services or src/app.
// - `fetch` is injected so tests replay recorded fixtures without a network.
// - Failures throw SourceError with a `kind`; the quotes service turns those
//   into per-retailer outcomes so one blocked retailer never hides the others.

/** Minimal fetch shape a source needs. globalThis.fetch satisfies it. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type SourceMethod =
  "shopify_json" | "json_ld" | "serpapi_google_shopping" | "wayback" | "llm_extract";

export type Availability = "in_stock" | "out_of_stock" | "unknown";

/** Coarser than listing_condition (ADR-0005); a source rarely knows more. */
export type QuoteCondition = "new" | "refurbished" | "used" | "unknown";

/** Identifiers a page exposed. GTIN is 14 digits by the time it is here. */
export interface QuoteIdentifiers {
  gtin: string | null;
  mpn: string | null;
  retailerSku: string | null;
}

export interface QuoteProvenance {
  kind: "live" | "search" | "archive";
  /** Search: the aggregator's product link. Archive: the snapshot URL. Live: null. */
  via: string | null;
}

/** One price seen on one retailer page at one moment. Not persisted. */
export interface PriceQuote {
  /** Tracked retailer slug for page and archive sources; slugified seller name for search. */
  retailerSlug: string;
  /** Retailer name as the tracked table or the aggregator gives it. */
  retailerName: string | null;
  /** The page the quote came from, canonicalised (tracking parameters stripped). */
  url: string;
  method: SourceMethod;
  /** When this source ran. */
  fetchedAt: Date;
  /** When the price was true: equals fetchedAt for live and search, the capture time for archive. */
  observedAt: Date;
  /** Title as the retailer prints it. */
  title: string | null;
  priceCents: number;
  currency: string;
  /** The "was" price the retailer shows struck through, when it shows one. */
  strikethroughCents: number | null;
  /** Delivery cost when the source states it; null when unknown, 0 when free. */
  shippingCents: number | null;
  availability: Availability;
  condition: QuoteCondition;
  identifiers: QuoteIdentifiers;
  provenance: QuoteProvenance;
  /**
   * How far to trust the price, 0 to 1, assigned by rules in the source.
   * Structured data read directly is 1. A model reading text starts lower
   * and drops for each doubt (ADR-0013). Below REVIEW_THRESHOLD needs a human.
   */
  confidence: number;
  /** The text fragment the price was read from, when a parser had to choose. */
  evidence: string | null;
  /** What the parser read, kept so a bad parse can be replayed. */
  raw: unknown;
}

/** A quote at or above this confidence may be shown as a price; below, it is a candidate for review. */
export const REVIEW_THRESHOLD = 0.7;

export type SourceErrorKind =
  | "blocked" // bot protection answered instead of the page
  | "http" // non-2xx status
  | "unparseable" // no product or no price in the response
  | "network"; // fetch itself failed or timed out

export class SourceError extends Error {
  readonly kind: SourceErrorKind;
  readonly retailerSlug: string;
  readonly status: number | null;

  constructor(
    kind: SourceErrorKind,
    retailerSlug: string,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "SourceError";
    this.kind = kind;
    this.retailerSlug = retailerSlug;
    this.status = options.status ?? null;
  }
}

/** The external service an outbound request went to. */
export type SourceProvider = "serpapi" | "gemini" | "wayback" | "retailer";

/** What the request asked that service for. */
export type SourceOperation =
  | "google_shopping" // serpapi, hop 1
  | "google_immersive_product" // serpapi, hop 2
  | "account" // serpapi, the free Account API
  | "generate_content" // gemini
  | "cdx" // wayback, the capture index
  | "availability" // wayback, the closest-capture fallback
  | "snapshot" // wayback, one archived page
  | "page"; // retailer, one live page or product JSON

/**
 * One HTTP request a source actually made, for the usage ledger. Reported
 * whether the request succeeded or failed. Never carries a URL or a key: a
 * SerpApi URL holds the key, and the ledger must not.
 */
export interface SourceCall {
  provider: SourceProvider;
  operation: SourceOperation;
  /** When the request was sent, from the injected clock. */
  startedAt: Date;
  durationMs: number;
  outcome: "ok" | "failed";
  /** Why it failed; null when it did not. */
  errorKind: SourceErrorKind | null;
  /** Null when no response arrived. */
  httpStatus: number | null;
  /** The model asked for. Null for every provider but gemini. */
  model: string | null;
  /** Null where the provider has no tokens, or answered without a count. */
  inputTokens: number | null;
  /** Everything billed as output: for gemini, answer plus thinking tokens. */
  outputTokens: number | null;
  /** The retailer the request was for, when there is one. Null for a search. */
  retailerSlug: string | null;
}

/**
 * Receives every request a source makes. Injected like `fetch`, so a source
 * still never touches the database: the caller decides what a call becomes.
 * A meter that throws is ignored; it can never break a source.
 */
export type Meter = (call: SourceCall) => void;

/** How to fetch one retailer's page. */
export interface SourceInput {
  retailerSlug: string;
  retailerName?: string;
  url: string;
  fetch?: FetchLike;
  now?: () => Date;
  meter?: Meter;
}

/** One page now, one quote. */
export type Source = (input: SourceInput) => Promise<PriceQuote>;

export interface SearchSourceInput {
  /** What to ask the aggregator, usually brand plus model code. */
  query: string;
  /**
   * Tokens that must all appear in a result's title for it to be a candidate
   * for the product entity, case-insensitive; for example the series "S85H".
   */
  mustMatch: string[];
  /**
   * Tokens that identify the exact variant among the entity's stores, any of
   * which counts; for example the size "65" and the model code. An entity is
   * accepted when most of its store titles carry one of them.
   */
  verifyTokens: string[];
  /** ISO 3166-1 alpha-2, lower-cased for the provider. */
  region: string;
  apiKey: string;
  fetch?: FetchLike;
  now?: () => Date;
  meter?: Meter;
}

/** One query, every seller the aggregator lists. */
export type SearchSource = (input: SearchSourceInput) => Promise<PriceQuote[]>;

export interface ArchiveSourceInput extends SourceInput {
  from: Date;
  to: Date;
  /** Upper bound on snapshots fetched for this page, newest kept. */
  maxSnapshots: number;
}

/** A capture the archive listed but the source could not turn into a quote. */
export interface ArchiveSkippedSnapshot {
  snapshotUrl: string;
  /** Capture time, from the timestamp in the snapshot URL. */
  observedAt: Date;
  kind: SourceErrorKind;
  message: string;
}

/** What an archive source found and what it made of it. */
export interface ArchiveResult {
  /** One quote per capture that fetched and parsed. Newest first. */
  quotes: PriceQuote[];
  /** Captures the archive listed inside the window, after the cap. */
  snapshotsFound: number;
  /** Captures that were listed but fetched or parsed badly. Never silent. */
  skipped: ArchiveSkippedSnapshot[];
}

/** One page, one quote per archived snapshot that parses. */
export type ArchiveSource = (input: ArchiveSourceInput) => Promise<ArchiveResult>;
