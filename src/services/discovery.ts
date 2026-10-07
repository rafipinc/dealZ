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
// miss path decided by Rafi on 2026-10-06): the index first, and only when
// it holds too little, the storefronts and Google Shopping together. The
// paid call is a development tool and must not run up a bill, so it has
// three hard gates: a key must be set, the day's budget must be readable,
// and the day's successful SerpApi searches, read from the usage ledger,
// must be under SERPAPI_DAILY_CAP (20 by default). The budget is read only
// once the index has answered and only when it holds too little, so a
// ledger that cannot be read never stops the free path: Google is skipped
// and the report says why. What both sources return is remembered in the
// index and the index is searched again, so a Google row and a storefront
// row for one product come back as one product with two offers.

import { z } from "zod";
import {
  countOkCallsByOperation,
  type OkCallsByOperation,
  type ProviderPeriod,
} from "@/db/queries/api-usage";
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

/** Writes candidates to the catalogue index. catalogue-index.remember is the real one. */
export type RememberCandidates = typeof remember;
/** Writes one inspected product to the catalogue index. catalogue-index.rememberInspect is the real one. */
export type RememberInspected = typeof rememberInspect;
/** Searches the catalogue index. catalogue-index.searchIndex is the real one. */
export type SearchIndex = typeof searchIndex;
/**
 * Counts a provider's successful ledger calls by operation over a period.
 * The real one is db/queries/api-usage.countOkCallsByOperation over the
 * application database.
 */
export type CountOkCalls = (
  period: ProviderPeriod,
  deps: { db?: QueryDb },
) => Promise<OkCallsByOperation[]>;

/**
 * How long a report waits for the catalogue index before going out without
 * it, the same bound as the usage ledger. A write still in flight is not
 * cancelled and may land later; it is not counted.
 */
export const INDEX_WRITE_TIMEOUT_MS = 2_000;

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

/** Where the cap came from: the variable, the default because it is unset, or the default because it is malformed. */
export type CapSource = "env" | "default" | "invalid";

/** A whole, non-negative number. Read on every call, so a test can set the variable. */
const dailyCapSchema = z.coerce.number().int().min(0);

/**
 * The cap as set, or the default when the variable is unset or blank. A
 * malformed value is the default too, marked `invalid` so the status line
 * can say it was ignored: a typo in a setting must never throw from a page
 * or block a search.
 */
function dailyCapOf(value: string | undefined): Pick<SerpApiBudget, "cap" | "capSource"> {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return { cap: DEFAULT_SERPAPI_DAILY_CAP, capSource: "default" };
  const parsed = dailyCapSchema.safeParse(trimmed);
  return parsed.success
    ? { cap: parsed.data, capSource: "env" }
    : { cap: DEFAULT_SERPAPI_DAILY_CAP, capSource: "invalid" };
}

/** The provider the budget is for, as the ledger names it. */
const SERPAPI_PROVIDER = "serpapi";

/** The ledger query over the application database, or the handle given. */
const countOkCallsInLedger: CountOkCalls = async (period, deps) =>
  countOkCallsByOperation(deps.db ?? (await defaultDb()), period);

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
  const { cap, capSource } = dailyCapOf(process.env[SERPAPI_DAILY_CAP_ENV]);
  const now = parsed.data.now ?? (() => new Date());
  const countOkCalls = parsed.data.countOkCalls ?? countOkCallsInLedger;
  const { from, to } = dayRangeIn(now(), SYDNEY);
  const rows = await countOkCalls({ provider: SERPAPI_PROVIDER, from, to }, { db: parsed.data.db });
  const usedToday = rows
    .filter((row) => SERPAPI_SEARCH_OPERATIONS.has(row.operation))
    .reduce((sum, row) => sum + row.count, 0);
  const remaining = Math.max(0, cap - usedToday);
  return { cap, capSource, usedToday, remaining, allowed: remaining > 0 };
}

// ---------- Discover: the index first, then the stores and Google Shopping together ----------

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
 * Why Google Shopping was not asked: the index answered alone, no key is
 * set, the day's cap is reached, or the budget could not be read from the
 * ledger, in which case nothing is spent blind.
 */
export type GoogleShoppingSkipReason =
  "index_sufficient" | "no_key" | "cap_reached" | "budget_unknown";

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
   * the budget was not read: the index answered on its own, or the ledger
   * could not be read (Google Shopping skipped, `budget_unknown`).
   */
  budget: DiscoverBudget | null;
  usage: UsageRecording;
  /**
   * Every candidate the sources returned, storefront and Google alike, in one
   * list ranked by lib/relevance: tier, then score, then title, then the
   * store's name. Empty when the index answered on its own.
   */
  candidates: RankedCandidate[];
  /** Candidates the sources returned, both of them. */
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
 * The budget, or null when the ledger could not be read. The budget gates
 * a paid call; it is never a reason to fail the free path, and a budget
 * that cannot be known allows nothing.
 */
async function budgetBestEffort(input: SerpApiBudgetInput): Promise<SerpApiBudget | null> {
  try {
    return await serpApiBudget(input);
  } catch {
    return null;
  }
}

/** Reads the budget, then asks Google Shopping only when the key is set and the budget is known and allows it. */
async function askGoogleShoppingWithinBudget(
  ask: Ask,
  apiKey: string | null,
  budgetInput: SerpApiBudgetInput,
): Promise<{ budget: SerpApiBudget | null; outcome: GoogleShoppingOutcome }> {
  const budget = await budgetBestEffort(budgetInput);
  if (apiKey === null) return { budget, outcome: { status: "skipped", reason: "no_key" } };
  if (budget === null) return { budget, outcome: { status: "skipped", reason: "budget_unknown" } };
  if (!budget.allowed) return { budget, outcome: { status: "skipped", reason: "cap_reached" } };
  return { budget, outcome: await askGoogleShopping(ask, apiKey) };
}

/**
 * The lab search's Enter path. The index is searched first and answers on
 * its own when it suffices. Otherwise the storefronts (free) and Google
 * Shopping (paid, only with a key, a readable budget and room under the
 * daily cap) are asked together, everything they return is remembered,
 * and the index is searched again so the products come back grouped
 * across every source. Nothing becomes a catalogue row (ADR-0016 item 8).
 * An index that cannot be read propagates: the index is the answer here,
 * not a side effect. A ledger that cannot be read does not: it only means
 * Google Shopping is skipped.
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

  const fetchedAt = now();
  const first = await search({ query, limit: MAX_SEARCH_LIMIT, db });
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

  const ledger = usageLedger(parsed.data.recordUsage);
  const ask: Ask = { query, queryKind, fetch, now, meter: ledger.meter };
  // The key goes to the source and nowhere else; no report includes it.
  const apiKey = serpApiKeyOf(parsed.data.serpApiKey);
  const budgetInput: SerpApiBudgetInput = { now, countOkCalls, db };
  // The budget is read only now, after the index: the free path never waits on the ledger.
  const [storefronts, google] = await Promise.all([
    askStorefronts(ask, limit),
    askGoogleShoppingWithinBudget(ask, apiKey, budgetInput),
  ]);
  const googleShopping = google.outcome;

  const found = [
    ...candidatesOf(storefronts),
    ...(googleShopping.status === "ok"
      ? googleShopping.candidates.map((entry) => entry.candidate)
      : []),
  ];
  // Both best effort and both bounded, side by side: neither delays the report by more than the bound.
  const [remembered, usage] = await Promise.all([
    found.length === 0
      ? Promise.resolve(0)
      : rememberBestEffort(() => rememberCandidates({ candidates: found, source: "search", db })),
    // A search is for no one tracked variant.
    ledger.flush(null),
  ]);
  // Only once the sources are in: the second search is what groups them.
  const second = await search({ query, limit: MAX_SEARCH_LIMIT, db });
  // Re-read after the ledger was written, so the report counts this search
  // when it was made; if the re-read fails, the earlier reading stands.
  const spent =
    googleShopping.status === "skipped"
      ? google.budget
      : ((await budgetBestEffort(budgetInput)) ?? google.budget);

  return {
    ...base,
    source: "fanout",
    products: second.products,
    total: second.total,
    googleShopping,
    storefronts,
    budget: budgetOf(spent),
    usage,
    candidates: rankCandidates(storefronts, googleShopping),
    found: found.length,
    remembered,
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
  // The schema accepted it, so canonicalisation cannot throw here.
  const url = canonicaliseUrl(parsed.data.url);
  const { origin, pathname } = new URL(url);
  if (origin !== store.origin) {
    throw new ValidationError(`${url} is not on ${store.retailerName} (${store.origin})`);
  }
  if (!pathname.startsWith(PRODUCT_PATH_PREFIX)) {
    throw new ValidationError(`${url} is not a product page (expected ${PRODUCT_PATH_PREFIX}...)`);
  }

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
