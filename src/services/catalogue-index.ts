// catalogue-index: the local search index of storefront products (ADR-0017,
// proposed). One catalogue_candidate row per product a store has shown
// DealZ, written by a listing pull, by every live search and by every
// identifier read, and searched without asking a store.
//
// Every row is a candidate (ADR-0017 item 8): nothing here creates a
// product, variant or listing, and nothing in the catalogue references a
// row. The index is disposable (item 9); it is rebuilt by `refreshIndex`.
//
// `searchIndex` runs one trigram query (src/db/queries/catalogue-candidates),
// judges the rows with the relevance rule of ADR-0016 item 12, drops the
// unrelated ones and groups the rest into one product per GTIN, model code
// or title, with every store's price. "Held" is answered by the tracked
// table, as discovery does.
//
// A database failure propagates from every function here, as it does from
// usage.record. A caller for whom the index is a side effect (discovery)
// catches it; a caller for whom it is the point (the refresh) reports it.

import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import {
  countCatalogueCandidates,
  databaseNow,
  deleteUnseenListingRows,
  searchCatalogueCandidates,
  upsertCatalogueCandidates,
  type CatalogueCandidateInsert,
  type CatalogueCandidateRow,
} from "@/db/queries/catalogue-candidates";
import type { QueryDb } from "@/db/queries/db";
import { catalogueCandidate } from "@/db/schema";
import { normaliseGtin } from "@/lib/gtin";
import { isModelCode, readModelCode } from "@/lib/model-code";
import { routeQuery, type QueryKind } from "@/lib/query-routing";
import { compareByRelevance, judgeRelevance, tokenise, type Relevance } from "@/lib/relevance";
import { listingSources, SourceError } from "@/sources";
import type {
  Availability,
  FetchLike,
  PriceQuote,
  ProductCandidate,
  SourceErrorKind,
} from "@/sources";
import { defaultDb } from "./default-db";
import { NotFoundError, ValidationError } from "./errors";
import {
  matchTrackedVariant,
  searchableStorefronts,
  seededCollections,
  type MatchedBy,
  type SeededCollection,
} from "./tracked-products";
import { usageLedger, type UsageRecorder, type UsageRecording } from "./usage-ledger";

export type { UsageRecorder, UsageRecording } from "./usage-ledger";

/** How a row arrived: a collection pull, a live search, or one product's JSON read. */
export const INDEX_SOURCES = ["listing", "search", "inspect"] as const;
export type IndexSource = (typeof INDEX_SOURCES)[number];

export const MAX_QUERY_LENGTH = 200;
export const DEFAULT_SEARCH_LIMIT = 8;
export const MAX_SEARCH_LIMIT = 50;
/** Rows read from the index for one search, before relevance and grouping. */
export const CANDIDATE_ROWS = 60;

// ---------- Schemas ----------

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const GTIN_RE = /^[0-9]{14}$/;

const dbSchema = z
  .custom<QueryDb>((value) => typeof value === "object" && value !== null)
  .optional();
const fetchSchema = z.custom<FetchLike>((value) => typeof value === "function").optional();
const nowSchema = z.custom<() => Date>((value) => typeof value === "function").optional();
const recordUsageSchema = z
  .custom<UsageRecorder>((value) => typeof value === "function")
  .optional();

const cents = z.int().nonnegative().nullable().optional();

// The row shape comes from the table, so a column is defined once. The
// overrides repeat the table's checks so a bad row is a ValidationError
// here, before the database has to refuse it.
const rowSchema = createInsertSchema(catalogueCandidate, {
  retailerSlug: (column) => column.regex(SLUG_RE, "Expected a kebab-case slug"),
  handle: (column) => column.min(1),
  gtin: z.string().regex(GTIN_RE, "Expected 14 digits").nullable().optional(),
  priceCents: cents,
  compareAtCents: cents,
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  source: z.enum(INDEX_SOURCES),
});

const availabilitySchema = z.enum(["in_stock", "out_of_stock", "unknown"]);

const identifiersSchema = z.object({
  gtin: z.string().nullable(),
  mpn: z.string().nullable(),
  retailerSku: z.string().nullable(),
});

/** The part of a ProductCandidate the index keeps. */
const candidateSchema = z.object({
  retailerSlug: z.string().min(1),
  title: z.string(),
  brand: z.string().nullable(),
  storeType: z.string().nullable(),
  url: z.string().min(1),
  handle: z.string().nullable(),
  priceCents: z.number().int().nullable(),
  currency: z.string(),
  strikethroughCents: z.number().int().nullable(),
  availability: availabilitySchema,
  imageUrl: z.string().nullable(),
  identifiers: identifiersSchema,
  raw: z.unknown(),
});

type Candidate = z.infer<typeof candidateSchema>;

/** The part of a PriceQuote the index keeps. */
const quoteSchema = z.object({
  retailerSlug: z.string().min(1),
  url: z.string().min(1),
  title: z.string().nullable(),
  priceCents: z.number().int(),
  currency: z.string(),
  strikethroughCents: z.number().int().nullable(),
  availability: availabilitySchema,
  identifiers: identifiersSchema,
  raw: z.unknown(),
});

/** What a Shopify product JSON carries that a quote does not surface. */
const rawProductSchema = z.looseObject({
  handle: z.string().nullable().catch(null),
  vendor: z.string().nullable().catch(null),
  product_type: z.string().nullable().catch(null),
});

// ---------- Rows ----------

async function dbOf(db: QueryDb | undefined): Promise<QueryDb> {
  return db ?? defaultDb();
}

/** The listing's three-way stock flag as the table's nullable boolean. */
function availableOf(availability: Availability): boolean | null {
  if (availability === "unknown") return null;
  return availability === "in_stock";
}

/** The 14-digit form, or null when the value is not a GTIN: a bad barcode is dropped, never stored. */
function gtinOf(gtin: string | null): string | null {
  return gtin === null ? null : normaliseGtin(gtin);
}

/** The model code from the title, else a SKU that is one (the rule of the listing source). */
function mpnOf(title: string, sku: string | null): string | null {
  const fromTitle = readModelCode(title);
  if (fromTitle !== null) return fromTitle;
  return sku !== null && isModelCode(sku) ? sku : null;
}

function toRow(candidate: Candidate, source: IndexSource): CatalogueCandidateInsert | null {
  // A product without a handle has no row key; it is skipped, never a failure.
  if (candidate.handle === null || candidate.handle === "") return null;
  return {
    retailerSlug: candidate.retailerSlug,
    handle: candidate.handle,
    canonicalUrl: candidate.url,
    title: candidate.title,
    brand: candidate.brand,
    storeType: candidate.storeType,
    mpn: candidate.identifiers.mpn,
    gtin: gtinOf(candidate.identifiers.gtin),
    retailerSku: candidate.identifiers.retailerSku,
    priceCents: candidate.priceCents,
    compareAtCents: candidate.strikethroughCents,
    currency: candidate.currency,
    available: availableOf(candidate.availability),
    imageUrl: candidate.imageUrl,
    source,
    raw: candidate.raw ?? {},
  };
}

/** Where a Shopify storefront keeps its product pages. */
const PRODUCT_PATH_PREFIX = "/products/";

/** The handle in a product page URL, or null when the path is not a product page. */
function handleOfUrl(url: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  if (!pathname.startsWith(PRODUCT_PATH_PREFIX)) return null;
  const handle = pathname
    .slice(PRODUCT_PATH_PREFIX.length)
    .replace(/\.json$/, "")
    .replace(/\/.*$/, "");
  return handle === "" ? null : handle;
}

/**
 * One inspected product as a row: the quote's identifiers and price, with
 * the candidate's store fields when the caller has them, else what the
 * product JSON in `raw` carries. Null when nothing names the product.
 */
function toInspectedRow(
  quote: z.infer<typeof quoteSchema>,
  candidate: Candidate | undefined,
): CatalogueCandidateInsert | null {
  const raw = rawProductSchema.safeParse(quote.raw);
  const fromRaw = raw.success ? raw.data : { handle: null, vendor: null, product_type: null };
  const handle = candidate?.handle ?? fromRaw.handle ?? handleOfUrl(quote.url);
  const title = quote.title ?? candidate?.title ?? null;
  if (handle === null || handle === "" || title === null) return null;
  const sku = quote.identifiers.retailerSku;
  return {
    retailerSlug: quote.retailerSlug,
    handle,
    canonicalUrl: quote.url,
    title,
    brand: candidate?.brand ?? fromRaw.vendor,
    storeType: candidate?.storeType ?? fromRaw.product_type,
    mpn: quote.identifiers.mpn ?? candidate?.identifiers.mpn ?? mpnOf(title, sku),
    gtin: gtinOf(quote.identifiers.gtin),
    retailerSku: sku,
    priceCents: quote.priceCents,
    compareAtCents: quote.strikethroughCents,
    currency: quote.currency,
    available: availableOf(quote.availability),
    imageUrl: candidate?.imageUrl ?? null,
    source: "inspect",
    raw: quote.raw ?? {},
  };
}

/**
 * Every row checked against the table's rules, and one row per (retailer,
 * handle): the last sighting in a batch wins, because Postgres refuses to
 * update one row twice in a single upsert.
 */
function checkRows(rows: (CatalogueCandidateInsert | null)[]): CatalogueCandidateInsert[] {
  const byKey = new Map<string, CatalogueCandidateInsert>();
  for (const row of rows) {
    if (row === null) continue;
    const parsed = rowSchema.safeParse(row);
    if (!parsed.success) {
      throw new ValidationError("Invalid catalogue candidate row", parsed.error.issues);
    }
    byKey.set(`${parsed.data.retailerSlug}\u0000${parsed.data.handle}`, parsed.data);
  }
  return Array.from(byKey.values());
}

// ---------- Remember: rows from a search, a listing or an identifier read ----------

export interface RememberInput {
  candidates: ProductCandidate[];
  source: IndexSource;
  /** Injected so tests run against PGlite. Defaults to the application database. */
  db?: QueryDb;
}

export interface Remembered {
  /** Rows written, inserted or replaced. A candidate without a handle is not counted. */
  written: number;
}

const rememberInputSchema = z.object({
  candidates: z.array(candidateSchema),
  source: z.enum(INDEX_SOURCES),
  db: dbSchema,
});

/**
 * Upserts every candidate by (retailer, handle). An identifier a row holds
 * is never erased by a candidate without one (ADR-0017 item 5). A database
 * failure propagates.
 */
export async function remember(input: RememberInput): Promise<Remembered> {
  const parsed = rememberInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Invalid remember input", parsed.error.issues);
  }
  const { candidates, source } = parsed.data;
  const rows = checkRows(candidates.map((candidate) => toRow(candidate, source)));
  const written = await upsertCatalogueCandidates(await dbOf(parsed.data.db), rows);
  return { written };
}

export interface RememberInspectInput {
  /** What the product JSON said: identifiers, price and stock. */
  quote: PriceQuote;
  /**
   * The candidate the read was for, when the caller has it; its brand, type
   * and image fill what a quote does not carry. Without it the product JSON
   * in the quote's `raw` is read for the handle, vendor and type.
   */
  candidate?: ProductCandidate;
  db?: QueryDb;
}

const rememberInspectInputSchema = z.object({
  quote: quoteSchema,
  candidate: candidateSchema.optional(),
  db: dbSchema,
});

/**
 * Writes one inspected product with the GTIN, SKU and price its product JSON
 * carried, source `inspect`. Written 0 when nothing names the product.
 */
export async function rememberInspect(input: RememberInspectInput): Promise<Remembered> {
  const parsed = rememberInspectInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Invalid rememberInspect input", parsed.error.issues);
  }
  const rows = checkRows([toInspectedRow(parsed.data.quote, parsed.data.candidate)]);
  const written = await upsertCatalogueCandidates(await dbOf(parsed.data.db), rows);
  return { written };
}

// ---------- Refresh: pull the seeded collections (ADR-0017 items 2, 7 and 9) ----------

/** Drops a store's listing rows last seen before an instant. The query helper, or a test's stub. */
export type DeleteUnseenListingRows = typeof deleteUnseenListingRows;
/** The database's clock, the one that stamps last_seen_at. The query helper, or a test's stub. */
export type DatabaseNow = typeof databaseNow;

export interface RefreshIndexInput {
  /** One seeded store, or every one when absent. */
  retailerSlug?: string;
  /** Injected so tests replay fixtures. Defaults to globalThis.fetch. */
  fetch?: FetchLike;
  /** Injected clock for the sources' fetch times. Defaults to () => new Date(). */
  now?: () => Date;
  /** Injected so tests need no ledger. Defaults to usage.record. */
  recordUsage?: UsageRecorder;
  /** Injected so unit tests stub the delete. Defaults to the query helper. */
  deleteUnseen?: DeleteUnseenListingRows;
  /** Injected so unit tests stub the database clock. Defaults to the query helper. */
  databaseNow?: DatabaseNow;
  db?: QueryDb;
}

interface CollectionBase {
  retailerSlug: string;
  retailerName: string;
  collection: string;
}

export interface CollectionOutcomeOk extends CollectionBase {
  status: "ok";
  /** Products the collection listed. */
  found: number;
  /** Rows written to the index. Below `found` only when a product had no handle. */
  written: number;
  /** This store's listing rows the pull did not touch: products it no longer lists, dropped (ADR-0017 item 9). */
  removed: number;
}

export interface CollectionOutcomeFailed extends CollectionBase {
  status: "failed";
  kind: SourceErrorKind;
  message: string;
}

export type CollectionOutcome = CollectionOutcomeOk | CollectionOutcomeFailed;

export interface RefreshIndexReport {
  /** When the refresh began by the database's clock: the cut-off for the listing rows it dropped. */
  refreshedAt: Date;
  /** Same order as the seeded collections. */
  collections: CollectionOutcome[];
  usage: UsageRecording;
}

const deleteUnseenSchema = z
  .custom<DeleteUnseenListingRows>((value) => typeof value === "function")
  .optional();

const databaseNowSchema = z.custom<DatabaseNow>((value) => typeof value === "function").optional();

const refreshIndexInputSchema = z.object({
  retailerSlug: z.string().min(1).optional(),
  fetch: fetchSchema,
  now: nowSchema,
  recordUsage: recordUsageSchema,
  deleteUnseen: deleteUnseenSchema,
  databaseNow: databaseNowSchema,
  db: dbSchema,
});

/** A collection that listed nothing: almost always a store that changed, not one that sells nothing. */
const EMPTY_COLLECTION: { kind: SourceErrorKind; message: string } = {
  kind: "unparseable",
  message: "The collection returned no products; nothing was removed",
};

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** A rejected source as a failure: its SourceError kind, or network for anything else. */
function failureOf(reason: unknown): { kind: SourceErrorKind; message: string } {
  const kind = reason instanceof SourceError ? reason.kind : "network";
  return { kind, message: messageOf(reason) };
}

/**
 * Pulls every seeded collection, one after another, and remembers what each
 * lists with source `listing`. Once a collection is remembered, that store's
 * listing rows last seen before the refresh began are dropped: a product the
 * store no longer lists leaves the index (ADR-0017 item 9); a `search` or
 * `inspect` row stays. "Began" is read from the database's clock, the one
 * that stamps last_seen_at, so skew between the hosts cannot drop a fresh
 * row or keep a stale one. A store that cannot be read is a failed outcome,
 * never a throw, and nothing of its is dropped; so is a collection that
 * lists no products, since an empty answer would otherwise empty the store's
 * rows. Every page is metered as `listing`. A database failure propagates:
 * the write is the point of a refresh.
 */
export async function refreshIndex(input: RefreshIndexInput = {}): Promise<RefreshIndexReport> {
  const parsed = refreshIndexInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Invalid refreshIndex input", parsed.error.issues);
  }
  const { retailerSlug, fetch } = parsed.data;
  const now = parsed.data.now ?? (() => new Date());
  const deleteUnseen = parsed.data.deleteUnseen ?? deleteUnseenListingRows;
  const clock = parsed.data.databaseNow ?? databaseNow;
  const targets: readonly SeededCollection[] =
    retailerSlug === undefined
      ? seededCollections
      : seededCollections.filter((seeded) => seeded.retailerSlug === retailerSlug);
  if (targets.length === 0) {
    throw new NotFoundError(
      retailerSlug === undefined
        ? "No seeded collection to refresh: no store is seeded"
        : `No seeded collection for retailer "${retailerSlug}"`,
    );
  }

  const ledger = usageLedger(parsed.data.recordUsage);
  const db = await dbOf(parsed.data.db);
  // Taken before any pull, from the clock that stamps last_seen_at: a listing
  // row last seen before this instant was not in it.
  const refreshedAt = await clock(db);
  const seenSince = refreshedAt;
  const collections: CollectionOutcome[] = [];
  for (const seeded of targets) {
    const base: CollectionBase = {
      retailerSlug: seeded.retailerSlug,
      retailerName: seeded.retailerName,
      collection: seeded.collection,
    };
    let candidates: ProductCandidate[];
    try {
      candidates = await listingSources.storefront_listing({
        retailerSlug: seeded.retailerSlug,
        retailerName: seeded.retailerName,
        origin: seeded.origin,
        collection: seeded.collection,
        fetch,
        now,
        meter: ledger.meter,
      });
    } catch (reason) {
      collections.push({ ...base, status: "failed", ...failureOf(reason) });
      continue;
    }
    if (candidates.length === 0) {
      collections.push({ ...base, status: "failed", ...EMPTY_COLLECTION });
      continue;
    }
    const { written } = await remember({ candidates, source: "listing", db });
    // Only once the pull is in: a failed write throws above, and drops nothing.
    const removed = await deleteUnseen(db, { retailerSlug: seeded.retailerSlug, seenSince });
    collections.push({ ...base, status: "ok", found: candidates.length, written, removed });
  }

  // A pull is for no one tracked variant.
  return { refreshedAt, collections, usage: await ledger.flush(null) };
}

// ---------- Search: one query on the index, products grouped across stores ----------

export interface SearchIndexInput {
  /** A title, a model code or a GTIN. Blank finds nothing and is not an error. */
  query: string;
  /** Products returned. Defaults to 8, at most 50. */
  limit?: number;
  db?: QueryDb;
}

/** Where an offer was seen: a storefront DealZ asked itself, or a seller Google Shopping listed. */
export type OfferVia = "storefront" | "google_shopping";

export interface IndexedOffer {
  retailerSlug: string;
  /** The tracked tables' name for the store, else the seller as Google printed it, else the slug. */
  retailerName: string;
  priceCents: number | null;
  compareAtCents: number | null;
  available: boolean | null;
  canonicalUrl: string;
  lastSeenAt: Date;
  source: IndexSource;
  via: OfferVia;
}

export interface IndexedProduct {
  /** Unique within one report: the GTIN, model code or title the group formed on. */
  key: string;
  /** The shortest title among the group's rows. */
  title: string;
  brand: string | null;
  mpn: string | null;
  gtin: string | null;
  imageUrl: string | null;
  /** Cheapest first; rows without a price last. */
  offers: IndexedOffer[];
  cheapest: { retailerSlug: string; priceCents: number } | null;
  /** The best relevance among the group's rows. */
  relevance: Relevance;
  trackedVariantSlug: string | null;
  matchedBy: MatchedBy | null;
}

export interface IndexSearchReport {
  /** The query as typed, trimmed. */
  query: string;
  queryKind: QueryKind;
  /** The 14-digit form when the query is a GTIN; null for text. */
  gtin: string | null;
  /** The first `limit` products, best first. */
  products: IndexedProduct[];
  /** Products matched before the limit. */
  total: number;
}

const searchIndexInputSchema = z.object({
  query: z.string().trim().max(MAX_QUERY_LENGTH),
  limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).default(DEFAULT_SEARCH_LIMIT),
  db: dbSchema,
});

/** The index matched the barcode itself; a title never carries it, so there is nothing to judge. */
const GTIN_RELEVANCE: Relevance = {
  tier: "match",
  score: 1,
  matched: [],
  missing: [],
  reason: "the index matched the barcode",
};

interface JudgedRow {
  row: CatalogueCandidateRow;
  relevance: Relevance;
}

/** The tracked tables' name for a store, or null for one they do not know. */
function knownRetailerNameOf(retailerSlug: string): string | null {
  const storefront = searchableStorefronts.find((store) => store.retailerSlug === retailerSlug);
  if (storefront !== undefined) return storefront.retailerName;
  const seeded = seededCollections.find((store) => store.retailerSlug === retailerSlug);
  return seeded === undefined ? null : seeded.retailerName;
}

/** The name a store is shown under: the tracked tables know it, else the slug. */
function retailerNameOf(retailerSlug: string): string {
  return knownRetailerNameOf(retailerSlug) ?? retailerSlug;
}

/**
 * What a Google Shopping row's `raw` carries that no storefront row does
 * (sources/serpapi, discoverGoogleShopping): the seller as Google prints it
 * and Google's product id or link. The table has no column for a row's
 * method or retailer name, so the raw read is what says which it was.
 */
const googleShoppingRawSchema = z
  .looseObject({
    source: z.string().min(1),
    product_id: z.string().optional(),
    product_link: z.string().optional(),
  })
  .refine((raw) => raw.product_id !== undefined || raw.product_link !== undefined);

/** The seller name Google printed, or null for a row a storefront gave. */
function googleSellerOf(raw: unknown): string | null {
  const parsed = googleShoppingRawSchema.safeParse(raw);
  return parsed.success ? parsed.data.source : null;
}

function isIndexSource(value: string): value is IndexSource {
  return (INDEX_SOURCES as readonly string[]).includes(value);
}

/** The row's source as the union. The table's check keeps it one of the three; a stray value is refused, not guessed. */
function sourceOf(value: string): IndexSource {
  if (isIndexSource(value)) return value;
  throw new ValidationError(`Unknown index source "${value}"`);
}

function normaliseCode(value: string | null): string | null {
  if (value === null) return null;
  const code = value.trim().toUpperCase();
  return code === "" ? null : code;
}

/** Lower-case words joined, so punctuation and spacing never split one product in two. */
function normaliseTitle(title: string): string {
  return tokenise(title).join(" ");
}

interface Group {
  /** Insertion order kept: the first GTIN, else the first model code, else the first title, names the group. */
  gtins: Set<string>;
  mpns: Set<string>;
  titles: Set<string>;
  rows: JudgedRow[];
}

function keyOf(group: Group): string {
  const [gtin] = group.gtins;
  if (gtin !== undefined) return `gtin:${gtin}`;
  const [mpn] = group.mpns;
  if (mpn !== undefined) return `mpn:${mpn}`;
  const [title] = group.titles;
  return `title:${title ?? ""}`;
}

/** True when the row names a different product than the group by an identifier they both carry. */
function conflicts(group: Group, gtin: string | null, mpn: string | null): boolean {
  if (gtin !== null && group.gtins.size > 0 && !group.gtins.has(gtin)) return true;
  if (mpn !== null && group.mpns.size > 0 && !group.mpns.has(mpn)) return true;
  return false;
}

/** Folds `absorbed` into `into`, which keeps its place; the rows go back to best first. */
function mergeGroups(groups: Group[], into: Group, absorbed: Group): void {
  for (const gtin of absorbed.gtins) into.gtins.add(gtin);
  for (const mpn of absorbed.mpns) into.mpns.add(mpn);
  for (const title of absorbed.titles) into.titles.add(title);
  into.rows.push(...absorbed.rows);
  into.rows.sort(compareJudged);
  groups.splice(groups.indexOf(absorbed), 1);
}

/**
 * One group per product: rows sharing a GTIN, else a model code, else the
 * same normalised title, provided no identifier says otherwise. A row that
 * carries one group's GTIN and another's model code joins the two. Rows
 * arrive best first, so the groups are in that order too.
 */
function groupRows(judged: JudgedRow[]): Group[] {
  const groups: Group[] = [];
  for (const entry of judged) {
    const gtin = entry.row.gtin;
    const mpn = normaliseCode(entry.row.mpn);
    const title = normaliseTitle(entry.row.title);
    const byGtin = gtin === null ? undefined : groups.find((g) => g.gtins.has(gtin));
    const byMpn = mpn === null ? undefined : groups.find((g) => g.mpns.has(mpn));
    const group =
      byGtin ?? byMpn ?? groups.find((g) => g.titles.has(title) && !conflicts(g, gtin, mpn));
    if (group === undefined) {
      groups.push({
        gtins: new Set(gtin === null ? [] : [gtin]),
        mpns: new Set(mpn === null ? [] : [mpn]),
        titles: new Set([title]),
        rows: [entry],
      });
      continue;
    }
    if (gtin !== null) group.gtins.add(gtin);
    if (mpn !== null) group.mpns.add(mpn);
    group.titles.add(title);
    group.rows.push(entry);
    if (byGtin !== undefined && byMpn !== undefined && byGtin !== byMpn) {
      // The earlier group keeps its place, so the list stays best first.
      const [into, absorbed] =
        groups.indexOf(byGtin) < groups.indexOf(byMpn) ? [byGtin, byMpn] : [byMpn, byGtin];
      mergeGroups(groups, into, absorbed);
    }
  }
  return groups;
}

function toOffer(row: CatalogueCandidateRow): IndexedOffer {
  const seller = googleSellerOf(row.raw);
  return {
    retailerSlug: row.retailerSlug,
    retailerName: knownRetailerNameOf(row.retailerSlug) ?? seller ?? row.retailerSlug,
    priceCents: row.priceCents,
    compareAtCents: row.compareAtCents,
    available: row.available,
    canonicalUrl: row.canonicalUrl,
    lastSeenAt: row.lastSeenAt,
    source: sourceOf(row.source),
    via: seller === null ? "storefront" : "google_shopping",
  };
}

/** Cheapest first, a row without a price last, the store name breaking a tie. */
function compareOffers(a: IndexedOffer, b: IndexedOffer): number {
  if (a.priceCents === null || b.priceCents === null) {
    if (a.priceCents === b.priceCents) return a.retailerName.localeCompare(b.retailerName, "en");
    return a.priceCents === null ? 1 : -1;
  }
  const byPrice = a.priceCents - b.priceCents;
  return byPrice !== 0 ? byPrice : a.retailerName.localeCompare(b.retailerName, "en");
}

function firstValue<T>(
  rows: CatalogueCandidateRow[],
  pick: (row: CatalogueCandidateRow) => T | null,
): T | null {
  for (const row of rows) {
    const value = pick(row);
    if (value !== null) return value;
  }
  return null;
}

/** Trust order (ADR-0004): a GTIN match over a model code over a page URL. */
const MATCH_ORDER: readonly MatchedBy[] = ["gtin", "mpn", "url"];

type GroupMatch = Pick<IndexedProduct, "trackedVariantSlug" | "matchedBy">;

/** The tracked variant any row of the group already is, by the most trusted identifier among them. */
function matchGroup(rows: CatalogueCandidateRow[]): GroupMatch {
  let best: GroupMatch = { trackedVariantSlug: null, matchedBy: null };
  for (const row of rows) {
    const match = matchTrackedVariant({
      url: row.canonicalUrl,
      identifiers: { gtin: row.gtin, mpn: row.mpn, retailerSku: row.retailerSku },
    });
    if (match.matchedBy === null) continue;
    if (
      best.matchedBy === null ||
      MATCH_ORDER.indexOf(match.matchedBy) < MATCH_ORDER.indexOf(best.matchedBy)
    ) {
      best = match;
    }
  }
  return best;
}

function toProduct(group: Group): IndexedProduct {
  const rows = group.rows.map((entry) => entry.row);
  const offers = rows.map(toOffer).sort(compareOffers);
  const cheapestOffer = offers.find((offer) => offer.priceCents !== null);
  const title = rows.reduce((shortest, row) =>
    row.title.length < shortest.title.length ? row : shortest,
  ).title;
  return {
    key: keyOf(group),
    title,
    brand: firstValue(rows, (row) => row.brand),
    mpn: firstValue(rows, (row) => row.mpn),
    gtin: firstValue(rows, (row) => row.gtin),
    imageUrl: firstValue(rows, (row) => row.imageUrl),
    offers,
    cheapest:
      cheapestOffer === undefined || cheapestOffer.priceCents === null
        ? null
        : { retailerSlug: cheapestOffer.retailerSlug, priceCents: cheapestOffer.priceCents },
    // The rows arrived best first, so the first row's relevance is the group's.
    relevance: group.rows[0].relevance,
    ...matchGroup(rows),
  };
}

function compareJudged(a: JudgedRow, b: JudgedRow): number {
  return compareByRelevance(
    {
      relevance: a.relevance,
      title: a.row.title,
      retailerName: retailerNameOf(a.row.retailerSlug),
    },
    {
      relevance: b.relevance,
      title: b.row.title,
      retailerName: retailerNameOf(b.row.retailerSlug),
    },
  );
}

/**
 * Searches the index for a title, model code or GTIN and groups the hits
 * into products, every store's offer under each. Never asks a store. A
 * blank query returns no products and no error, so a dropdown can call
 * this on every keystroke.
 */
export async function searchIndex(input: SearchIndexInput): Promise<IndexSearchReport> {
  const parsed = searchIndexInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Invalid searchIndex input", parsed.error.issues);
  }
  const { query, limit } = parsed.data;
  const { queryKind, gtin } = routeQuery(query);
  if (query === "") return { query, queryKind, gtin, products: [], total: 0 };

  const db = await dbOf(parsed.data.db);
  let judged: JudgedRow[];
  if (gtin !== null) {
    // The exact barcode, in the 14-digit form the table holds; a title never carries it.
    const rows = await searchCatalogueCandidates(db, { query: gtin, limit: CANDIDATE_ROWS });
    judged = rows
      .filter((row) => row.gtin === gtin)
      .map((row) => ({ row, relevance: GTIN_RELEVANCE }));
  } else {
    const rows = await searchCatalogueCandidates(db, { query, limit: CANDIDATE_ROWS });
    judged = rows
      .map((row) => ({
        row,
        relevance: judgeRelevance(query, { title: row.title, brand: row.brand }),
      }))
      .filter((entry) => entry.relevance.tier !== "unrelated");
  }

  const products = groupRows(judged.sort(compareJudged)).map(toProduct);
  return { query, queryKind, gtin, products: products.slice(0, limit), total: products.length };
}

// ---------- Status: what the index holds, for the status line ----------

export interface IndexStoreStatus {
  retailerSlug: string;
  retailerName: string;
  /** True for a store the tracked tables name; false for a seller learned from Google Shopping. */
  known: boolean;
  count: number;
  /** When a row of this store was last written. */
  lastSeenAt: Date;
}

export interface IndexStatus {
  total: number;
  /** By retailer slug. */
  stores: IndexStoreStatus[];
}

const indexStatusInputSchema = z.object({ db: dbSchema });

/** How many products the index holds, overall and per store, with the last sighting. */
export async function indexStatus(input: { db?: QueryDb } = {}): Promise<IndexStatus> {
  const parsed = indexStatusInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Invalid indexStatus input", parsed.error.issues);
  }
  const counts = await countCatalogueCandidates(await dbOf(parsed.data.db));
  return {
    total: counts.total,
    stores: counts.byRetailer.map((store) => ({
      retailerSlug: store.retailerSlug,
      retailerName: retailerNameOf(store.retailerSlug),
      known: knownRetailerNameOf(store.retailerSlug) !== null,
      count: store.count,
      lastSeenAt: store.lastSeenAt,
    })),
  };
}
