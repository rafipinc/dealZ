// Thin helpers over catalogue_candidate, the local search index: one row per
// product a retailer storefront has shown DealZ (ADR-0017). Rows are
// replaced in place on every sighting, so there is an upsert and no insert.

import { and, count, desc, eq, inArray, isNull, lt, max, or, sql } from "drizzle-orm";
import { catalogueCandidate } from "../schema";
import type { QueryDb } from "./db";

export type CatalogueCandidateRow = typeof catalogueCandidate.$inferSelect;
export type CatalogueCandidateInsert = typeof catalogueCandidate.$inferInsert;

export interface CatalogueSearch {
  query: string;
  limit: number;
}

export interface RetailerCandidateCount {
  retailerSlug: string;
  count: number;
  lastSeenAt: Date;
}

export interface CatalogueCandidateCounts {
  total: number;
  byRetailer: RetailerCandidateCount[];
}

export interface UnseenListingRows {
  retailerSlug: string;
  /** Listing rows last seen before this instant are dropped. */
  seenSince: Date;
}

export interface EnrichCandidates {
  /** The storefronts DealZ can read product JSON from. */
  retailerSlugs: string[];
  limit: number;
}

/** The most rows one search returns, whatever the caller asks for. */
export const MAX_SEARCH_LIMIT = 200;

/** The rows a search returns when the caller's limit is not a usable number. */
export const DEFAULT_SEARCH_LIMIT = 50;

/** The most rows one enrich pass reads, whatever the caller asks for. */
export const MAX_ENRICH_LIMIT = 100;

// A limit that is not a finite non-negative integer is a caller bug, not a
// request for zero rows; it falls back to the default rather than to nothing.
const searchLimit = (limit: number): number =>
  Number.isInteger(limit) && limit >= 0 ? Math.min(limit, MAX_SEARCH_LIMIT) : DEFAULT_SEARCH_LIMIT;

/** Titles with less trigram similarity than this are not a match on their own. */
const SIMILARITY_FLOOR = 0.1;

// The row proposed for insert, inside ON CONFLICT DO UPDATE.
const excluded = (column: string) => sql.raw(`excluded."${column}"`);
// The new value when the parser read one, else what is stored: a value once
// read is kept.
const keepIfNull = (column: string) =>
  sql`coalesce(${excluded(column)}, ${sql.raw(`"catalogue_candidate"."${column}"`)})`;

/**
 * Writes every row, inserting a new product and replacing a known one in
 * place by (retailer_slug, handle). `first_seen_at` survives; `last_seen_at`
 * moves to now. `gtin`, `mpn`, `retailer_sku`, `image_url`, `category` and
 * `retailer_name` are only overwritten by a value, never by null: an
 * identifier, a category or a name once known is kept. `inspected_at`
 * survives later sightings the same way, so a row read once is not read
 * again. `via` takes the new row's value. Returns the number of rows written.
 */
export async function upsertCatalogueCandidates(
  db: QueryDb,
  rows: CatalogueCandidateInsert[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const written = await db
    .insert(catalogueCandidate)
    .values(rows)
    .onConflictDoUpdate({
      target: [catalogueCandidate.retailerSlug, catalogueCandidate.handle],
      set: {
        retailerName: keepIfNull("retailer_name"),
        canonicalUrl: excluded("canonical_url"),
        title: excluded("title"),
        brand: excluded("brand"),
        storeType: excluded("store_type"),
        category: keepIfNull("category"),
        mpn: keepIfNull("mpn"),
        gtin: keepIfNull("gtin"),
        retailerSku: keepIfNull("retailer_sku"),
        priceCents: excluded("price_cents"),
        compareAtCents: excluded("compare_at_cents"),
        currency: excluded("currency"),
        available: excluded("available"),
        imageUrl: keepIfNull("image_url"),
        source: excluded("source"),
        via: excluded("via"),
        raw: excluded("raw"),
        lastSeenAt: sql`now()`,
        inspectedAt: keepIfNull("inspected_at"),
      },
    })
    .returning({ id: catalogueCandidate.id });
  return written.length;
}

/**
 * Rows whose title is similar to the query by trigram or contains it, or whose
 * gtin, mpn or retailer_sku equals it exactly. Best title match first, then the
 * most recently seen. The limit is capped at MAX_SEARCH_LIMIT; a limit that is
 * not a finite non-negative integer becomes DEFAULT_SEARCH_LIMIT.
 */
export async function searchCatalogueCandidates(
  db: QueryDb,
  { query, limit }: CatalogueSearch,
): Promise<CatalogueCandidateRow[]> {
  const q = query.trim();
  if (q === "") return [];
  const similarity = sql<number>`similarity(${catalogueCandidate.title}, ${q})`;
  // LIKE wildcards in the query are literal characters, not patterns.
  const contains = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  return db
    .select()
    .from(catalogueCandidate)
    .where(
      or(
        sql`${similarity} > ${SIMILARITY_FLOOR}`,
        sql`${catalogueCandidate.title} ILIKE ${contains}`,
        sql`${catalogueCandidate.gtin} = ${q}`,
        sql`${catalogueCandidate.mpn} = ${q}`,
        sql`${catalogueCandidate.retailerSku} = ${q}`,
      ),
    )
    .orderBy(desc(similarity), desc(catalogueCandidate.lastSeenAt), desc(catalogueCandidate.id))
    .limit(searchLimit(limit));
}

/**
 * The database's clock, the same `now()` that stamps `last_seen_at`. A caller
 * that later compares against `last_seen_at`, as `deleteUnseenListingRows`
 * does, takes its cut-off here rather than from the application clock, so skew
 * between the two machines cannot keep or drop rows wrongly. Inside a
 * transaction this is the transaction's start time, as `now()` always is.
 */
export async function databaseNow(db: QueryDb): Promise<Date> {
  // Selected through the timestamp column's mapper, so the driver's raw value
  // (a string under postgres-js, a Date under PGlite) comes back as a Date.
  const [row] = await db
    .select({ now: sql`now()`.mapWith(catalogueCandidate.lastSeenAt) })
    .from(sql`(values (1)) as clock`);
  return row.now;
}

/**
 * Drops one retailer's `listing` rows not seen since `seenSince`: after a
 * collection is re-read, what the store no longer lists leaves the index
 * (ADR-0017 item 9, the index is rebuilt freely). Rows that arrived by
 * `search` or `inspect` are never touched; they were seen on their own merits,
 * not as part of a listing, so an absent listing says nothing about them.
 * Returns the number of rows deleted.
 */
export async function deleteUnseenListingRows(
  db: QueryDb,
  { retailerSlug, seenSince }: UnseenListingRows,
): Promise<number> {
  const deleted = await db
    .delete(catalogueCandidate)
    .where(
      and(
        eq(catalogueCandidate.retailerSlug, retailerSlug),
        eq(catalogueCandidate.source, "listing"),
        lt(catalogueCandidate.lastSeenAt, seenSince),
      ),
    )
    .returning({ id: catalogueCandidate.id });
  return deleted.length;
}

/**
 * The rows an enrich pass reads product JSON for: `storefront` rows with no
 * `gtin` that have never been inspected, newest sighting first, only on the
 * storefronts DealZ can read (`retailerSlugs`). A row inspected once and
 * still without a GTIN has none in its JSON, so it is never listed again. The
 * limit is capped at MAX_ENRICH_LIMIT. Empty when no retailer is named.
 */
export async function listCandidatesWithoutGtin(
  db: QueryDb,
  { retailerSlugs, limit }: EnrichCandidates,
): Promise<CatalogueCandidateRow[]> {
  if (retailerSlugs.length === 0) return [];
  return db
    .select()
    .from(catalogueCandidate)
    .where(
      and(
        isNull(catalogueCandidate.gtin),
        isNull(catalogueCandidate.inspectedAt),
        eq(catalogueCandidate.via, "storefront"),
        inArray(catalogueCandidate.retailerSlug, retailerSlugs),
      ),
    )
    .orderBy(desc(catalogueCandidate.lastSeenAt), desc(catalogueCandidate.id))
    .limit(Math.min(limit, MAX_ENRICH_LIMIT));
}

/** How many rows the index holds, overall and per retailer, for the status line. */
export async function countCatalogueCandidates(db: QueryDb): Promise<CatalogueCandidateCounts> {
  const rows = await db
    .select({
      retailerSlug: catalogueCandidate.retailerSlug,
      count: count(),
      lastSeenAt: max(catalogueCandidate.lastSeenAt),
    })
    .from(catalogueCandidate)
    .groupBy(catalogueCandidate.retailerSlug)
    .orderBy(catalogueCandidate.retailerSlug);
  // max() is typed nullable, but a group always holds at least one row.
  const byRetailer = rows.flatMap((r) =>
    r.lastSeenAt ? [{ ...r, lastSeenAt: r.lastSeenAt }] : [],
  );
  return { total: byRetailer.reduce((n, r) => n + r.count, 0), byRetailer };
}
