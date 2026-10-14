// discovery: finds products in the storefronts that answer scripted
// requests, by title, model code or GTIN (ADR-0016, step c). Every storefront
// is asked in parallel and reported side by side, so one failing never hides
// the others. Nothing is persisted by a search; a candidate becomes a
// catalogue row only through a confirmed add, when the catalog service
// exists (ADR-0016 item 8).
//
// Query routing (ADR-0016 item 7) is lib/query-routing: a GTIN is sent to
// the stores as typed (they index the 13-digit EAN) and reported in its
// 14-digit form. Anything else is text.
//
// "Already held" is answered by the hand-maintained tracked table until the
// catalogue search exists (ADR-0016 items 4 and 10): a candidate whose GTIN,
// model code or page URL is a tracked variant's is shown as held.
//
// Relevance is ours (lib/relevance): a store's predictive search matches
// any query word anywhere, and a store with nothing to say still answers
// with ten unrelated products. Each candidate is judged against the query
// and the candidates of a store are ordered by tier, then score, then
// title. For a GTIN query every candidate the store returned is a match;
// a title never carries the barcode.
//
// Every request is metered and written to the usage ledger, best effort,
// as the quotes service does (ADR-0014). Every candidate a store returns,
// and every product inspected, is remembered in the catalogue index the
// same way (ADR-0017 item 5): best effort, bounded, and a search still
// answers when the index cannot be written.
//
// `discoverProducts` is the Enter path of the lab search (ADR-0017 item 6,
// miss path decided by Rafi on 2026-10-06): a ladder, cheapest first. The
// index is searched; when it holds too little, the storefronts (free) are
// asked, what they return is remembered, and the index is searched again;
// only when it still holds too little is Google Shopping (paid) asked, its
// answer remembered, and the index searched once more. The paid call runs
// only when the free sources leave the index short: a product the
// storefronts stock never costs a search, and a new category with an empty
// index pays once per query, not once per store it is missing from. The
// paid call is a development tool and must not run up a bill, so it also
// has three hard gates: a key must be set, the day's budget must be
// readable, and the day's successful SerpApi searches, read from the usage
// ledger, must be under SERPAPI_DAILY_CAP (20 by default). The budget is
// read only once the free rungs have answered and only when they left the
// index short, so a ledger that cannot be read never stops the free path:
// Google is skipped and the report says why. The budget read, the paid call
// and its ledger write run one search at a time, so two searches cannot
// both take the last search under the cap. Each search of the index after
// a source was remembered is what groups the sources, so a Google row and a
// storefront row for one product come back as one product with two offers.
//
// `enrichIndex` is the bounded identifier pass. An index row learned from a
// search or a listing has no barcode (ADR-0016 item 6, ADR-0017 item 5):
// a predictive search answer and a collection page carry none, only the
// product JSON does. This reads it once per row, newest rows first, at most
// `limit` rows a pass with a politeness pause between reads, so products
// group across stores by GTIN. A row whose JSON carries no barcode is
// marked inspected and never re-read; a row whose JSON names no product is
// written nothing, reported as failed, and listed again next pass. Only a
// searchable storefront's own `/products/` pages are read, the same guard
// as `inspectCandidate`.

import { z } from "zod";
import {
  listCandidatesWithoutGtin,
  MAX_ENRICH_LIMIT,
  type CatalogueCandidateRow,
} from "@/db/queries/catalogue-candidates";
import type { QueryDb } from "@/db/queries/db";
import { SERPAPI_SEARCH_OPERATIONS } from "@/lib/api-prices";
import { dayRangeIn, SYDNEY } from "@/lib/day-ranges";
import { routeQuery, type QueryKind } from "@/lib/query-routing";
import {
  compareByRelevance,
  judgeRelevance,
  type Relevance,
  type RelevanceTier,
} from "@/lib/relevance";
import { withTimeout } from "@/lib/timeout";
import { canonicaliseUrl } from "@/lib/url";
import {
  DEFAULT_LIMIT,
  discoverySources,
  fetchCandidateIdentifiers,
  googleShoppingDiscovery,
  MAX_LIMIT,
  SourceError,
} from "@/sources";
import type { FetchLike, Meter, PriceQuote, ProductCandidate, SourceErrorKind } from "@/sources";
import {
  MAX_QUERY_LENGTH,
  MAX_SEARCH_LIMIT,
  remember,
  rememberInspect,
  searchIndex,
  type IndexedProduct,
  type OfferVia,
} from "./catalogue-index";
import {
  countOkCallsInLedger,
  dailyCapOf,
  usedTodayOf,
  type CapSource,
  type CountOkCalls,
} from "./daily-cap";
import { defaultDb } from "./default-db";
import { NotFoundError, ValidationError } from "./errors";
import { serpApiKeyOf } from "./quotes";
import {
  matchTrackedVariant,
  searchableStorefronts,
  type MatchedBy,
  type SearchableStorefront,
} from "./tracked-products";
import { usageLedger, type UsageRecorder, type UsageRecording } from "./usage-ledger";

export type { QueryKind } from "@/lib/query-routing";
export type { Relevance, RelevanceTier } from "@/lib/relevance";
export type { IndexedOffer, IndexedProduct, OfferVia } from "./catalogue-index";
export type { MatchedBy } from "./tracked-products";
export type { UsageRecorder, UsageRecording } from "./usage-ledger";
export type { CapSource, CountOkCalls } from "./daily-cap";

/** Writes candidates to the catalogue index. catalogue-index.remember is the real one. */
export type RememberCandidates = typeof remember;
/** Writes one inspected product to the catalogue index. catalogue-index.rememberInspect is the real one. */
export type RememberInspected = typeof rememberInspect;
/** Searches the catalogue index. catalogue-index.searchIndex is the real one. */
export type SearchIndex = typeof searchIndex;
/**
 * How long a report waits for the catalogue index before going out without
 * it, the same bound as the usage ledger. A write still in flight is not
 * cancelled and may land later; it is not counted.
 */
export const INDEX_WRITE_TIMEOUT_MS = 2_000;
/** How long a search waits for the day's budget before treating it as unknown. */
export const BUDGET_READ_TIMEOUT_MS = 2_000;

/** One limit for every search box: the index and the sources take the same queries. */
export { MAX_QUERY_LENGTH } from "./catalogue-index";

export interface FindProductsInput {
  /** A title, a model code or a GTIN. */
  query: string;
  /** Results asked of each store. Defaults to 10, at most 20. */
  limit?: number;
  /** Injected so tests replay fixtures. Defaults to globalThis.fetch. */
  fetch?: FetchLike;
  /** Injected clock. Defaults to () => new Date(). */
  now?: () => Date;
  /** Injected so tests need no database. Defaults to usage.record. */
  recordUsage?: UsageRecorder;
  /** Injected so tests need no database. Defaults to catalogue-index.remember. */
  rememberCandidates?: RememberCandidates;
}

export interface DiscoveryCandidate {
  candidate: ProductCandidate;
  /** The tracked variant this candidate already is, or null for a new product. */
  trackedVariantSlug: string | null;
  matchedBy: MatchedBy | null;
  /** How well the candidate answers the query. A GTIN query makes every candidate a match. */
  relevance: Relevance;
}

/** How many candidates across every store that answered fell in each tier. */
export type TierCounts = Record<RelevanceTier, number>;

interface StoreBase {
  retailerSlug: string;
  retailerName: string;
  origin: string;
}

export interface StoreOutcomeOk extends StoreBase {
  status: "ok";
  candidates: DiscoveryCandidate[];
}

export interface StoreOutcomeFailed extends StoreBase {
  status: "failed";
  kind: SourceErrorKind;
  message: string;
}

export type StoreOutcome = StoreOutcomeOk | StoreOutcomeFailed;

export interface DiscoveryReport {
  /** The query as typed, trimmed. */
  query: string;
  queryKind: QueryKind;
  /** The 14-digit form when the query is a GTIN; null for text. */
  gtin: string | null;
  fetchedAt: Date;
  /** Same order as the searchable storefronts. */
  stores: StoreOutcome[];
  /** Candidates across every store that answered, whatever their relevance. */
  total: number;
  tiers: TierCounts;
  usage: UsageRecording;
  /** Candidates written to the catalogue index; below `total` when the index could not be written in time. */
  remembered: number;
}

const fetchSchema = z.custom<FetchLike>((value) => typeof value === "function").optional();
const nowSchema = z.custom<() => Date>((value) => typeof value === "function").optional();
const recordUsageSchema = z
  .custom<UsageRecorder>((value) => typeof value === "function")
  .optional();
const rememberCandidatesSchema = z
  .custom<RememberCandidates>((value) => typeof value === "function")
  .optional();
const rememberInspectedSchema = z
  .custom<RememberInspected>((value) => typeof value === "function")
  .optional();
const searchIndexSchema = z.custom<SearchIndex>((value) => typeof value === "function").optional();
const countOkCallsSchema = z
  .custom<CountOkCalls>((value) => typeof value === "function")
  .optional();
const dbSchema = z
  .custom<QueryDb>((value) => typeof value === "object" && value !== null)
  .optional();

const findProductsInputSchema = z.object({
  query: z.string().trim().min(1, "Expected a query").max(MAX_QUERY_LENGTH),
  limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  fetch: fetchSchema,
  now: nowSchema,
  recordUsage: recordUsageSchema,
  rememberCandidates: rememberCandidatesSchema,
});

/**
 * Runs one index write and reports how many rows it confirmed within the
 * bound. A write that throws, or does not answer in time, counts as zero:
 * the index is a side effect of a search, never a reason to fail one.
 */
async function rememberBestEffort(write: () => Promise<{ written: number }>): Promise<number> {
  try {
    // Inside an async function, so a writer that throws synchronously is a rejection too.
    const { written } = await withTimeout(
      (async () => write())(),
      INDEX_WRITE_TIMEOUT_MS,
      "The catalogue index did not answer",
    );
    return written;
  } catch {
    return 0;
  }
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** A rejected source as a failure: its SourceError kind, or network for anything else. */
function failureOf(reason: unknown): { kind: SourceErrorKind; message: string } {
  const kind = reason instanceof SourceError ? reason.kind : "network";
  return { kind, message: messageOf(reason) };
}

/** "Held" is the tracked table's answer (tracked-products.matchTrackedVariant), shared with the index. */
const matchTracked = matchTrackedVariant;

/** The store matched the barcode itself; a title never carries it, so there is nothing to judge. */
const GTIN_RELEVANCE: Relevance = {
  tier: "match",
  score: 1,
  matched: [],
  missing: [],
  reason: "the store matched the barcode",
};

function relevanceOf(queryKind: QueryKind, query: string, candidate: ProductCandidate): Relevance {
  if (queryKind === "gtin") return GTIN_RELEVANCE;
  return judgeRelevance(query, { title: candidate.title, brand: candidate.brand });
}

/** Best tier first, then the higher score, then the title (lib/relevance), so the order is stable across runs. */
function compareCandidates(a: DiscoveryCandidate, b: DiscoveryCandidate): number {
  return compareByRelevance(
    { relevance: a.relevance, title: a.candidate.title },
    { relevance: b.relevance, title: b.candidate.title },
  );
}

function countTiers(stores: StoreOutcome[]): TierCounts {
  const tiers: TierCounts = { match: 0, accessory: 0, partial: 0, unrelated: 0 };
  for (const store of stores) {
    if (store.status !== "ok") continue;
    for (const entry of store.candidates) tiers[entry.relevance.tier] += 1;
  }
  return tiers;
}

function storeBase(store: SearchableStorefront): StoreBase {
  return {
    retailerSlug: store.retailerSlug,
    retailerName: store.retailerName,
    origin: store.origin,
  };
}

function searchStore(
  store: SearchableStorefront,
  query: string,
  limit: number,
  fetch: FetchLike | undefined,
  now: () => Date,
  meter: Meter,
): Promise<ProductCandidate[]> {
  return discoverySources.storefront_search({
    retailerSlug: store.retailerSlug,
    retailerName: store.retailerName,
    origin: store.origin,
    query,
    limit,
    fetch,
    now,
    meter,
  });
}

/** What every search needs to ask a source and judge its answer. */
interface Ask {
  query: string;
  queryKind: QueryKind;
  fetch: FetchLike | undefined;
  now: () => Date;
  meter: Meter;
}

/** Judges one candidate against the query and the tracked table, and sorts a store's answer best first. */
function judge(ask: Ask, candidates: ProductCandidate[]): DiscoveryCandidate[] {
  return candidates
    .map((candidate): DiscoveryCandidate => ({
      candidate,
      ...matchTracked(candidate),
      relevance: relevanceOf(ask.queryKind, ask.query, candidate),
    }))
    .sort(compareCandidates);
}

/** Every searchable storefront in parallel, each reported on its own. Shared by findProducts and discoverProducts. */
async function askStorefronts(ask: Ask, limit: number): Promise<StoreOutcome[]> {
  const settled = await Promise.allSettled(
    // A GTIN goes to the store as typed: the store indexes the EAN it printed, not the padded form.
    searchableStorefronts.map((store) =>
      searchStore(store, ask.query, limit, ask.fetch, ask.now, ask.meter),
    ),
  );
  return searchableStorefronts.map((store, index) => {
    const result = settled[index];
    if (result.status === "rejected") {
      return { ...storeBase(store), status: "failed", ...failureOf(result.reason) };
    }
    return { ...storeBase(store), status: "ok", candidates: judge(ask, result.value) };
  });
}

function candidatesOf(stores: StoreOutcome[]): ProductCandidate[] {
  return stores.flatMap((store) =>
    store.status === "ok" ? store.candidates.map((entry) => entry.candidate) : [],
  );
}

/**
 * Asks every searchable storefront for one query. Nothing is saved but the
 * usage ledger and the catalogue index, which remembers every candidate the
 * stores returned (ADR-0017 item 5) without ever making one a catalogue row.
 */
export async function findProducts(input: FindProductsInput): Promise<DiscoveryReport> {
  const parsed = findProductsInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Invalid findProducts input", parsed.error.issues);
  }
  const { query, limit, fetch } = parsed.data;
  const now = parsed.data.now ?? (() => new Date());
  const rememberCandidates = parsed.data.rememberCandidates ?? remember;
  const { queryKind, gtin } = routeQuery(query);
  const ledger = usageLedger(parsed.data.recordUsage);

  const fetchedAt = now();
  const stores = await askStorefronts({ query, queryKind, fetch, now, meter: ledger.meter }, limit);
  const found = candidatesOf(stores);
  // Both best effort and both bounded, side by side: neither delays the report by more than the bound.
  const [remembered, usage] = await Promise.all([
    found.length === 0
      ? Promise.resolve(0)
      : rememberBestEffort(() => rememberCandidates({ candidates: found, source: "search" })),
    // A search is for no one tracked variant.
    ledger.flush(null),
  ]);

  return {
    query,
    queryKind,
    gtin,
    fetchedAt,
    stores,
    total: found.length,
    tiers: countTiers(stores),
    usage,
    remembered,
  };
}

// ---------- Budget: the day's SerpApi searches against a hard cap ----------

/** The environment variable that sets the cap; unset means DEFAULT_SERPAPI_DAILY_CAP. */
export const SERPAPI_DAILY_CAP_ENV = "SERPAPI_DAILY_CAP";
export const DEFAULT_SERPAPI_DAILY_CAP = 20;

/** The provider the budget is for, as the ledger names it. */
const SERPAPI_PROVIDER = "serpapi";

export interface SerpApiBudgetInput {
  /** Injected clock; "today" is read from it. Defaults to () => new Date(). */
  now?: () => Date;
  /** Injected so tests need no ledger. Defaults to the ledger query over the application database. */
  countOkCalls?: CountOkCalls;
  db?: QueryDb;
}

export interface SerpApiBudget {
  /** The day's cap, from SERPAPI_DAILY_CAP or the default. */
  cap: number;
  capSource: CapSource;
  /** Successful SerpApi searches so far today, Sydney time, as the usage ledger holds them. */
  usedToday: number;
  /** Never below zero. */
  remaining: number;
  /** True while a paid search may still be made today. */
  allowed: boolean;
}

const serpApiBudgetInputSchema = z.object({
  now: nowSchema,
  countOkCalls: countOkCallsSchema,
  db: dbSchema,
});

/**
 * How many SerpApi searches today's cap still allows. "Today" is the
 * calendar day in Sydney. The count is the ledger's successful `serpapi`
 * calls for the operations that use up a search (lib/api-prices): a failed
 * search is not charged and is not counted, and the free Account API call
 * the status page makes is not counted either. The cap never throws: a
 * malformed SERPAPI_DAILY_CAP is the default, marked as ignored. A ledger
 * failure propagates; discoverProducts treats it as a budget it cannot know.
 */
export async function serpApiBudget(input: SerpApiBudgetInput = {}): Promise<SerpApiBudget> {
  const parsed = serpApiBudgetInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Invalid serpApiBudget input", parsed.error.issues);
  }
  // The cap's parser and the ledger count are shared with the OpenAI cap in
  // quotes (ADR-0020 item 5); a malformed setting is the default, marked
  // `invalid` so the status line can say it was ignored, and never blocks a search.
  const { cap, capSource } = dailyCapOf(
    process.env[SERPAPI_DAILY_CAP_ENV],
    DEFAULT_SERPAPI_DAILY_CAP,
  );
  const now = parsed.data.now ?? (() => new Date());
  const countOkCalls = parsed.data.countOkCalls ?? countOkCallsInLedger;
  const { from, to } = dayRangeIn(now(), SYDNEY);
  const rows = await countOkCalls({ provider: SERPAPI_PROVIDER, from, to }, { db: parsed.data.db });
  const usedToday = usedTodayOf(rows, (operation) => SERPAPI_SEARCH_OPERATIONS.has(operation));
  const remaining = Math.max(0, cap - usedToday);
  return { cap, capSource, usedToday, remaining, allowed: remaining > 0 };
}

// ---------- Discover: the index, then the storefronts, then Google Shopping ----------

/** A text query is answered by the index when it holds this many matching products. */
export const INDEX_SUFFICIENT_MATCHES = 3;
/** The region Google Shopping is asked for. */
const GOOGLE_REGION = "AU";

export interface DiscoverProductsInput {
  /** A title, a model code or a GTIN. */
  query: string;
  /** Results asked of each store. Defaults to 10, at most 20. Google Shopping keeps its own default. */
  limit?: number;
  /** Overrides SERPAPI_API_KEY. Never put in a report. */
  serpApiKey?: string;
  fetch?: FetchLike;
  now?: () => Date;
  recordUsage?: UsageRecorder;
  rememberCandidates?: RememberCandidates;
  /** Injected so tests need no database. Defaults to catalogue-index.searchIndex. */
  searchIndex?: SearchIndex;
  /** Injected so tests need no ledger. Defaults to the ledger query over the application database. */
  countOkCalls?: CountOkCalls;
  db?: QueryDb;
}

/**
 * Why Google Shopping was not asked: the index answered alone, the
 * storefronts' answers left the index sufficient so the paid rung was never
 * reached, no key is set, the day's cap is reached, or the budget could not
 * be read from the ledger, in which case nothing is spent blind.
 */
export type GoogleShoppingSkipReason =
  "index_sufficient" | "storefronts_sufficient" | "no_key" | "cap_reached" | "budget_unknown";

export type GoogleShoppingOutcome =
  | {
      status: "ok";
      /** Results Google returned, all of them candidates. */
      found: number;
      /** Judged like a store's answer, best first. */
      candidates: DiscoveryCandidate[];
    }
  | { status: "skipped"; reason: GoogleShoppingSkipReason }
  | { status: "failed"; kind: SourceErrorKind; message: string };

/**
 * One candidate a source returned, placed in the list both sources share:
 * under the store it is shown as, the storefront that answered or the
 * seller Google named, and with where it came from.
 */
export interface RankedCandidate extends DiscoveryCandidate {
  retailerSlug: string;
  retailerName: string;
  via: OfferVia;
  /** Its place in its own source's answer, best first. With `via` and the slug, unique within a report. */
  position: number;
}

/** The budget as a report carries it: what was spent, never whether the next search may spend. */
export type DiscoverBudget = Pick<SerpApiBudget, "cap" | "capSource" | "usedToday" | "remaining">;

export interface DiscoverReport {
  /** The query as typed, trimmed. */
  query: string;
  queryKind: QueryKind;
  /** The 14-digit form when the query is a GTIN; null for text. */
  gtin: string | null;
  fetchedAt: Date;
  /** "index" when the index answered on its own; "fanout" when the sources were asked. */
  source: "index" | "fanout";
  /** From the index, grouped across stores, best first. After the sources were remembered when they ran. */
  products: IndexedProduct[];
  /** Products the index matched before its limit. */
  total: number;
  googleShopping: GoogleShoppingOutcome;
  /** The storefronts' answers, or null when the index answered on its own. */
  storefronts: StoreOutcome[] | null;
  /**
   * The day's SerpApi searches after this one, against the cap. Null when
   * the budget was not read: the index answered on its own, the storefronts
   * left it sufficient (Google Shopping skipped, `storefronts_sufficient`),
   * or the ledger could not be read (skipped, `budget_unknown`).
   */
  budget: DiscoverBudget | null;
  /** Every request the rungs that ran made, storefront and Google alike. */
  usage: UsageRecording;
  /**
   * Every candidate the sources that ran returned, storefront and Google
   * alike, in one list ranked by lib/relevance: tier, then score, then
   * title, then the store's name. Empty when the index answered on its own.
   */
  candidates: RankedCandidate[];
  /** Candidates the sources that ran returned, storefront and Google alike. */
  found: number;
  /** Of `found`, how many the index confirmed writing in time. */
  remembered: number;
}

const discoverProductsInputSchema = z.object({
  query: z.string().trim().min(1, "Expected a query").max(MAX_QUERY_LENGTH),
  limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  serpApiKey: z.string().optional(),
  fetch: fetchSchema,
  now: nowSchema,
  recordUsage: recordUsageSchema,
  rememberCandidates: rememberCandidatesSchema,
  searchIndex: searchIndexSchema,
  countOkCalls: countOkCallsSchema,
  db: dbSchema,
});

/**
 * True when the index's answer is enough and no source need be asked: a
 * text query with INDEX_SUFFICIENT_MATCHES matching products, or a GTIN the
 * index holds at all, since a barcode names one product and its rows group
 * into one.
 */
function indexSuffices(queryKind: QueryKind, products: IndexedProduct[]): boolean {
  const matches = products.filter((product) => product.relevance.tier === "match").length;
  return queryKind === "gtin" ? matches >= 1 : matches >= INDEX_SUFFICIENT_MATCHES;
}

/**
 * The storefronts' answers and Google's in one list, best first by the same
 * rule as each store's own list (lib/relevance), the store's name breaking
 * a tie between two stores listing one title. A store that failed adds
 * nothing.
 */
function rankCandidates(
  storefronts: StoreOutcome[],
  googleShopping: GoogleShoppingOutcome,
): RankedCandidate[] {
  const ranked: RankedCandidate[] = [];
  for (const store of storefronts) {
    if (store.status !== "ok") continue;
    store.candidates.forEach((entry, position) =>
      ranked.push({
        ...entry,
        retailerSlug: store.retailerSlug,
        retailerName: store.retailerName,
        via: "storefront",
        position,
      }),
    );
  }
  if (googleShopping.status === "ok") {
    googleShopping.candidates.forEach((entry, position) =>
      ranked.push({
        ...entry,
        retailerSlug: entry.candidate.retailerSlug,
        retailerName: entry.candidate.retailerName ?? entry.candidate.retailerSlug,
        via: "google_shopping",
        position,
      }),
    );
  }
  return ranked.sort((a, b) =>
    compareByRelevance(
      { relevance: a.relevance, title: a.candidate.title, retailerName: a.retailerName },
      { relevance: b.relevance, title: b.candidate.title, retailerName: b.retailerName },
    ),
  );
}

/** One paid request, judged like a store's answer; a failure is an outcome, never a throw. */
async function askGoogleShopping(ask: Ask, apiKey: string): Promise<GoogleShoppingOutcome> {
  let candidates: ProductCandidate[];
  try {
    candidates = await googleShoppingDiscovery({
      // A GTIN goes as its digits: Google Shopping matches barcodes in its index.
      query: ask.query,
      region: GOOGLE_REGION,
      apiKey,
      fetch: ask.fetch,
      now: ask.now,
      meter: ask.meter,
    });
  } catch (reason) {
    return { status: "failed", ...failureOf(reason) };
  }
  return { status: "ok", found: candidates.length, candidates: judge(ask, candidates) };
}

function budgetOf(budget: SerpApiBudget | null): DiscoverBudget | null {
  if (budget === null) return null;
  const { cap, capSource, usedToday, remaining } = budget;
  return { cap, capSource, usedToday, remaining };
}

/**
 * The budget, or null when the ledger could not be read in time. The budget
 * gates a paid call; it is never a reason to fail the free path, and a budget
 * that cannot be known allows nothing. Bounded, because it is read inside the
 * paid turn and a read that never answered would hold every later search.
 */
async function budgetBestEffort(input: SerpApiBudgetInput): Promise<SerpApiBudget | null> {
  try {
    return await withTimeout(
      serpApiBudget(input),
      BUDGET_READ_TIMEOUT_MS,
      "The usage ledger did not answer",
    );
  } catch {
    return null;
  }
}

// DealZ's search runs in one Node process (a local dev tool), so an
// in-process chain is enough to stop two searches both passing the cap.
let paidTurn: Promise<unknown> = Promise.resolve();

/** Runs `work` once every earlier call's work has settled, one at a time. */
function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const run = paidTurn.then(work);
  paidTurn = run.catch(() => undefined);
  return run;
}

interface GoogleWithinBudget {
  budget: SerpApiBudget | null;
  outcome: GoogleShoppingOutcome;
  /** The Google call as the ledger took it, written before the next search reads the budget. */
  usage: UsageRecording;
}

/**
 * Reads the budget, then asks Google Shopping only when the key is set and
 * the budget is known and allows it. The read, the paid call and its ledger
 * write run one search at a time, so the next search's read counts this
 * call: two searches at the cap minus one cannot both spend. Only this part
 * waits its turn; the index and the storefronts never do.
 */
function askGoogleShoppingWithinBudget(
  ask: Ask,
  apiKey: string | null,
  budgetInput: SerpApiBudgetInput,
  recordUsage: UsageRecorder | undefined,
): Promise<GoogleWithinBudget> {
  return oneAtATime(async () => {
    const none: UsageRecording = { calls: 0, recorded: 0 };
    const budget = await budgetBestEffort(budgetInput);
    if (apiKey === null) {
      return { budget, outcome: { status: "skipped", reason: "no_key" }, usage: none };
    }
    if (budget === null) {
      return { budget, outcome: { status: "skipped", reason: "budget_unknown" }, usage: none };
    }
    if (!budget.allowed) {
      return { budget, outcome: { status: "skipped", reason: "cap_reached" }, usage: none };
    }
    // Its own ledger, flushed inside the turn: the budget is read from the ledger.
    const ledger = usageLedger(recordUsage);
    const outcome = await askGoogleShopping({ ...ask, meter: ledger.meter }, apiKey);
    // A search is for no one tracked variant.
    return { budget, outcome, usage: await ledger.flush(null) };
  });
}

/**
 * The lab search's Enter path: a ladder, cheapest rung first. The index is
 * searched and answers on its own when it suffices. Otherwise the
 * storefronts (free) are asked, what they return is remembered, and the
 * index is searched again; when it now suffices, Google Shopping is skipped
 * and nothing is paid. Only when the index is still short is Google
 * Shopping (paid, only with a key, a readable budget and room under the
 * daily cap) asked, its answer remembered, and the index searched once
 * more. Each search after a source was remembered is what groups that
 * source's rows with the rest. Nothing becomes a catalogue row (ADR-0016
 * item 8). An index that cannot be read propagates: the index is the
 * answer here, not a side effect. A ledger that cannot be read does not:
 * it only means Google Shopping is skipped.
 */
export async function discoverProducts(input: DiscoverProductsInput): Promise<DiscoverReport> {
  const parsed = discoverProductsInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Invalid discoverProducts input", parsed.error.issues);
  }
  const { query, limit, fetch, db, countOkCalls } = parsed.data;
  const now = parsed.data.now ?? (() => new Date());
  const rememberCandidates = parsed.data.rememberCandidates ?? remember;
  const search = parsed.data.searchIndex ?? searchIndex;
  const { queryKind, gtin } = routeQuery(query);
  const searchIndexNow = () => search({ query, limit: MAX_SEARCH_LIMIT, db });
  /** Best effort and bounded; nothing to write is nothing remembered, without a call. */
  const rememberFound = (candidates: ProductCandidate[]) =>
    candidates.length === 0
      ? Promise.resolve(0)
      : rememberBestEffort(() => rememberCandidates({ candidates, source: "search", db }));

  // Rung 1: the index alone.
  const fetchedAt = now();
  const first = await searchIndexNow();
  const base = { query, queryKind, gtin, fetchedAt };
  if (indexSuffices(queryKind, first.products)) {
    return {
      ...base,
      source: "index",
      products: first.products,
      total: first.total,
      googleShopping: { status: "skipped", reason: "index_sufficient" },
      storefronts: null,
      budget: null,
      usage: { calls: 0, recorded: 0 },
      candidates: [],
      found: 0,
      remembered: 0,
    };
  }

  // Rung 2: the storefronts, free. Remembered, then the index is searched again.
  const ledger = usageLedger(parsed.data.recordUsage);
  const ask: Ask = { query, queryKind, fetch, now, meter: ledger.meter };
  const storefronts = await askStorefronts(ask, limit);
  const fromStorefronts = candidatesOf(storefronts);
  // Both best effort and both bounded, side by side: neither delays the report by more than the bound.
  const [storefrontsRemembered, storefrontUsage] = await Promise.all([
    rememberFound(fromStorefronts),
    // A search is for no one tracked variant.
    ledger.flush(null),
  ]);
  const second = await searchIndexNow();
  if (indexSuffices(queryKind, second.products)) {
    // The budget was never read: the free sources answered and nothing was paid.
    const googleShopping: GoogleShoppingOutcome = {
      status: "skipped",
      reason: "storefronts_sufficient",
    };
    return {
      ...base,
      source: "fanout",
      products: second.products,
      total: second.total,
      googleShopping,
      storefronts,
      budget: null,
      usage: storefrontUsage,
      candidates: rankCandidates(storefronts, googleShopping),
      found: fromStorefronts.length,
      remembered: storefrontsRemembered,
    };
  }

  // Rung 3: Google Shopping, paid, only now that the free rungs left the index short.
  // The key goes to the source and nowhere else; no report includes it.
  const apiKey = serpApiKeyOf(parsed.data.serpApiKey);
  const budgetInput: SerpApiBudgetInput = { now, countOkCalls, db };
  // The budget is read only now, after the index: the free path never waits on the ledger.
  const google = await askGoogleShoppingWithinBudget(
    ask,
    apiKey,
    budgetInput,
    parsed.data.recordUsage,
  );
  const googleShopping = google.outcome;
  const fromGoogle =
    googleShopping.status === "ok" ? googleShopping.candidates.map((entry) => entry.candidate) : [];
  const googleRemembered = await rememberFound(fromGoogle);
  // Only a Google answer can have changed the index since the second search.
  const third = fromGoogle.length === 0 ? second : await searchIndexNow();
  // Re-read after the ledger was written, so the report counts this search
  // when it was made; if the re-read fails, the earlier reading stands.
  const spent =
    googleShopping.status === "skipped"
      ? google.budget
      : ((await budgetBestEffort(budgetInput)) ?? google.budget);

  return {
    ...base,
    source: "fanout",
    products: third.products,
    total: third.total,
    googleShopping,
    storefronts,
    budget: budgetOf(spent),
    usage: {
      calls: storefrontUsage.calls + google.usage.calls,
      recorded: storefrontUsage.recorded + google.usage.recorded,
    },
    candidates: rankCandidates(storefronts, googleShopping),
    found: fromStorefronts.length + fromGoogle.length,
    remembered: storefrontsRemembered + googleRemembered,
  };
}

// ---------- Inspect: one candidate's product JSON, for its identifiers (ADR-0016 item 6) ----------

export interface InspectCandidateInput {
  /** One of the searchable storefronts. */
  retailerSlug: string;
  /** A product page on that storefront. */
  url: string;
  fetch?: FetchLike;
  now?: () => Date;
  recordUsage?: UsageRecorder;
  /** Injected so tests need no database. Defaults to catalogue-index.rememberInspect. */
  rememberInspected?: RememberInspected;
}

export type InspectOutcome =
  | {
      status: "ok";
      quote: PriceQuote;
      trackedVariantSlug: string | null;
      matchedBy: MatchedBy | null;
    }
  | { status: "failed"; kind: SourceErrorKind; message: string };

export interface InspectReport {
  retailerSlug: string;
  url: string;
  fetchedAt: Date;
  outcome: InspectOutcome;
  usage: UsageRecording;
  /** 1 when the inspected product was written to the catalogue index, else 0. */
  remembered: number;
}

const httpUrlSchema = z.string().refine((value) => {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}, "Expected an absolute http or https URL");

const inspectCandidateInputSchema = z.object({
  retailerSlug: z.string().min(1),
  url: httpUrlSchema,
  fetch: fetchSchema,
  now: nowSchema,
  recordUsage: recordUsageSchema,
  rememberInspected: rememberInspectedSchema,
});

/** Where a Shopify storefront keeps its product pages; the only path this service will read. */
const PRODUCT_PATH_PREFIX = "/products/";

type ProductPageCheck = { ok: true; url: string } | { ok: false; message: string };

/**
 * The URL as a product page on the store, canonicalised, or why it is not
 * one: not an absolute http(s) URL, not on the store's origin, or not under
 * its products path. Shared by inspectCandidate, which refuses with a
 * ValidationError, and enrichIndex, which skips the row with a failed
 * outcome, so neither ever reads an arbitrary host or another path of the
 * store.
 */
function checkProductPage(store: SearchableStorefront, input: string): ProductPageCheck {
  let url: string;
  try {
    url = canonicaliseUrl(input);
  } catch {
    return { ok: false, message: `${input} is not an absolute http or https URL` };
  }
  const { origin, pathname } = new URL(url);
  if (origin !== store.origin) {
    return { ok: false, message: `${url} is not on ${store.retailerName} (${store.origin})` };
  }
  if (!pathname.startsWith(PRODUCT_PATH_PREFIX)) {
    return {
      ok: false,
      message: `${url} is not a product page (expected ${PRODUCT_PATH_PREFIX}...)`,
    };
  }
  return { ok: true, url };
}

/**
 * Reads one candidate's product JSON and reports the identifiers it carries.
 * The store must be a searchable storefront and the URL must be a product
 * page on it, so a caller can never point this at an arbitrary host or at
 * any other path of the store.
 */
export async function inspectCandidate(input: InspectCandidateInput): Promise<InspectReport> {
  const parsed = inspectCandidateInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Invalid inspectCandidate input", parsed.error.issues);
  }
  const { retailerSlug, fetch } = parsed.data;
  const now = parsed.data.now ?? (() => new Date());
  const rememberInspected = parsed.data.rememberInspected ?? rememberInspect;

  const store = searchableStorefronts.find((candidate) => candidate.retailerSlug === retailerSlug);
  if (store === undefined) {
    throw new NotFoundError(`No searchable storefront with slug "${retailerSlug}"`);
  }
  const page = checkProductPage(store, parsed.data.url);
  if (!page.ok) throw new ValidationError(page.message);
  const { url } = page;

  const ledger = usageLedger(parsed.data.recordUsage);
  const fetchedAt = now();
  let outcome: InspectOutcome;
  try {
    const quote = await fetchCandidateIdentifiers({
      retailerSlug: store.retailerSlug,
      retailerName: store.retailerName,
      url,
      fetch,
      now,
      meter: ledger.meter,
    });
    outcome = { status: "ok", quote, ...matchTracked(quote) };
  } catch (reason) {
    outcome = { status: "failed", ...failureOf(reason) };
  }

  const quote = outcome.status === "ok" ? outcome.quote : null;
  const [remembered, usage] = await Promise.all([
    quote === null ? Promise.resolve(0) : rememberBestEffort(() => rememberInspected({ quote })),
    // The variant is known only when the page's identifiers matched one.
    ledger.flush(outcome.status === "ok" ? outcome.trackedVariantSlug : null),
  ]);

  return { retailerSlug: store.retailerSlug, url, fetchedAt, outcome, usage, remembered };
}

// ---------- Enrich: read the product JSON of rows without a GTIN, bounded (ADR-0016 item 6) ----------

/** Rows an enrich pass reads when the caller names no limit. */
export const DEFAULT_ENRICH_LIMIT = 25;
/** The politeness pause between two reads of one pass. */
export const DEFAULT_ENRICH_DELAY_MS = 500;

/** Lists the index rows without a GTIN. db/queries/catalogue-candidates.listCandidatesWithoutGtin is the real one. */
export type ListWithoutGtin = typeof listCandidatesWithoutGtin;

export interface EnrichIndexInput {
  /** One searchable storefront, or every one when absent. */
  retailerSlug?: string;
  /** Rows read in this pass. Defaults to 25, at most MAX_ENRICH_LIMIT. */
  limit?: number;
  /** Politeness pause between reads, in milliseconds. Defaults to 500; tests pass 0. */
  delayMs?: number;
  /** How the pause is waited; injected so a test asserts the wait without a clock. */
  sleep?: (ms: number) => Promise<void>;
  fetch?: FetchLike;
  now?: () => Date;
  recordUsage?: UsageRecorder;
  /** Injected so tests need no database. Defaults to catalogue-index.rememberInspect. */
  rememberInspected?: RememberInspected;
  /** Injected so tests need no database. Defaults to the query helper. */
  listWithoutGtin?: ListWithoutGtin;
  db?: QueryDb;
}

/**
 * Why a row was not read: a source failure, a URL the service will not
 * read because it is off the store or not one of its product pages, or a
 * product JSON that named no product (`unparseable`), so the index wrote
 * nothing and the row was not marked inspected.
 */
export type EnrichFailureKind = SourceErrorKind | "not_product_page";

export type EnrichRowOutcome =
  { status: "ok" } | { status: "failed"; kind: EnrichFailureKind; message: string };

export interface EnrichRow {
  retailerSlug: string;
  retailerName: string;
  /** The row's product page as the index holds it. */
  url: string;
  outcome: EnrichRowOutcome;
  /** The 14-digit GTIN the product JSON carried; null when it carried none or the outcome is failed. */
  gtin: string | null;
}

export interface EnrichIndexReport {
  fetchedAt: Date;
  /** Rows listed for the pass, each attempted in turn. */
  attempted: number;
  /** Rows whose product JSON was read and written back, marked inspected. */
  read: number;
  /** Of `read`, how many carried a GTIN. */
  withGtin: number;
  /** Same order as the rows were listed: newest sighting first. */
  rows: EnrichRow[];
  /** Rows written to the index: every read, since the write is the point. */
  remembered: number;
  usage: UsageRecording;
}

const sleepSchema = z
  .custom<(ms: number) => Promise<void>>((value) => typeof value === "function")
  .optional();
const listWithoutGtinSchema = z
  .custom<ListWithoutGtin>((value) => typeof value === "function")
  .optional();

const enrichIndexInputSchema = z.object({
  retailerSlug: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(MAX_ENRICH_LIMIT).default(DEFAULT_ENRICH_LIMIT),
  delayMs: z.number().int().min(0).default(DEFAULT_ENRICH_DELAY_MS),
  sleep: sleepSchema,
  fetch: fetchSchema,
  now: nowSchema,
  recordUsage: recordUsageSchema,
  rememberInspected: rememberInspectedSchema,
  listWithoutGtin: listWithoutGtinSchema,
  db: dbSchema,
});

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** A product JSON that named no product: the index wrote no row, so nothing was stamped and the row is listed again. */
const UNNAMED_PRODUCT: { kind: SourceErrorKind; message: string } = {
  kind: "unparseable",
  message: "the product JSON named no product; not marked inspected",
};

function enrichRowBase(store: SearchableStorefront, row: CatalogueCandidateRow) {
  return {
    retailerSlug: store.retailerSlug,
    retailerName: store.retailerName,
    url: row.canonicalUrl,
  };
}

/**
 * Reads the product JSON of the index rows that have no GTIN and were never
 * inspected, on the searchable storefronts (all of them, or the one named),
 * newest sighting first and at most `limit` rows, and writes each read back
 * with its identifiers and `inspected_at` (catalogue-index.rememberInspect).
 * A row whose URL is off its store or not a product page is skipped with a
 * failed outcome, never read. A page that cannot be read is a failed outcome
 * too, never a throw. So is a page whose product JSON names no product: the
 * index writes nothing for it, so it is not marked inspected, not counted as
 * read, and is listed again next pass. Every row counted as read was written
 * back. A politeness pause separates one read from the next. Every request
 * is metered as a page. The write is the point of the pass, so a database
 * failure propagates, as it does from refreshIndex; a listing that cannot be
 * read does the same, before any request.
 */
export async function enrichIndex(input: EnrichIndexInput = {}): Promise<EnrichIndexReport> {
  const parsed = enrichIndexInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Invalid enrichIndex input", parsed.error.issues);
  }
  const { retailerSlug, limit, delayMs, fetch } = parsed.data;
  const now = parsed.data.now ?? (() => new Date());
  const sleep = parsed.data.sleep ?? defaultSleep;
  const rememberInspected = parsed.data.rememberInspected ?? rememberInspect;
  const listWithoutGtin = parsed.data.listWithoutGtin ?? listCandidatesWithoutGtin;

  const stores =
    retailerSlug === undefined
      ? searchableStorefronts
      : searchableStorefronts.filter((store) => store.retailerSlug === retailerSlug);
  if (stores.length === 0) {
    throw new NotFoundError(`No searchable storefront with slug "${retailerSlug}"`);
  }
  const storesBySlug = new Map(stores.map((store) => [store.retailerSlug, store]));

  const db = parsed.data.db ?? (await defaultDb());
  const fetchedAt = now();
  const listed = await listWithoutGtin(db, {
    retailerSlugs: stores.map((store) => store.retailerSlug),
    limit,
  });

  const ledger = usageLedger(parsed.data.recordUsage);
  const rows: EnrichRow[] = [];
  let read = 0;
  let withGtin = 0;
  let remembered = 0;
  let requests = 0;
  for (const row of listed) {
    // The query listed only these stores' rows; the lookup narrows the type.
    const store = storesBySlug.get(row.retailerSlug);
    if (store === undefined) continue;
    const base = enrichRowBase(store, row);
    const page = checkProductPage(store, row.canonicalUrl);
    if (!page.ok) {
      rows.push({
        ...base,
        outcome: { status: "failed", kind: "not_product_page", message: page.message },
        gtin: null,
      });
      continue;
    }

    // The pause is for the store, so it follows a request whether or not it answered.
    if (requests > 0 && delayMs > 0) await sleep(delayMs);
    requests += 1;
    let quote: PriceQuote;
    try {
      quote = await fetchCandidateIdentifiers({
        retailerSlug: store.retailerSlug,
        retailerName: store.retailerName,
        url: page.url,
        fetch,
        now,
        meter: ledger.meter,
      });
    } catch (reason) {
      rows.push({ ...base, outcome: { status: "failed", ...failureOf(reason) }, gtin: null });
      continue;
    }

    // The write is the point: a database failure propagates.
    const { written } = await rememberInspected({ quote, now, db });
    if (written === 0) {
      // No row, no inspected_at stamp: the row comes back next pass, so say so.
      rows.push({ ...base, outcome: { status: "failed", ...UNNAMED_PRODUCT }, gtin: null });
      continue;
    }
    remembered += written;
    read += 1;
    const gtin = quote.identifiers.gtin;
    if (gtin !== null) withGtin += 1;
    rows.push({ ...base, outcome: { status: "ok" }, gtin });
  }

  // A pass is for no one tracked variant.
  const usage = await ledger.flush(null);
  return { fetchedAt, attempted: listed.length, read, withGtin, rows, remembered, usage };
}
