// serpapi_google_shopping: asks Google Shopping, through SerpApi, for every
// seller of a product in one region. Two hops, both recorded as fixtures on
// 2026-09-28 (docs/research/2026-09-28-serpapi-and-wayback.md):
//
// 1. engine google_shopping with the query. Google answers with product
//    entities, not sellers: each result is one entity Google matched to the
//    query, fronted by one seller, and for a model-code query most of them
//    are the wrong series or the wrong size. `mustMatch` and the model-code
//    check pick the candidates, in position order, at most MAX_CANDIDATES.
// 2. engine google_immersive_product with a candidate's page token and
//    more_stores=true. This lists every store selling that entity. The entity
//    is accepted when at least half of its store titles carry one of
//    `verifyTokens` (the size or the model code); the first accepted entity's
//    stores become the quotes and no further candidate is fetched.
//
// When no entity is accepted, the hop-1 results that match `mustMatch` are
// mapped as quotes at a lower confidence: one seller each, unverified.
//
// discoverGoogleShopping is the catalogue search's miss path (decided by
// Rafi on 2026-10-06): hop 1 only, every result mapped to a ProductCandidate
// with no filtering, so one paid request shows what Google holds for a
// query. Nothing here decides whether that request may be made; the daily
// cap is the discovery service's.

import { z } from "zod";
import { readModelCode as readTitleModelCode } from "../lib/model-code";
import { parseCents } from "../lib/money";
import { slugify } from "../lib/slug";
import { canonicaliseUrl } from "../lib/url";
import { fetchBody } from "./http";
import { beginCall } from "./meter";
import {
  SourceError,
  type Availability,
  type FetchLike,
  type GoogleShoppingDiscoverySource,
  type Meter,
  type PriceQuote,
  type ProductCandidate,
  type QuoteCondition,
  type SearchSource,
  type SearchSourceInput,
  type SourceOperation,
} from "./types";

export const SERPAPI_ENDPOINT = "https://serpapi.com/search.json";
/** The Account API: plan and quota. Free, and not counted against the quota. */
export const SERPAPI_ACCOUNT_ENDPOINT = "https://serpapi.com/account.json";
/** SourceError.retailerSlug for failures of the aggregator itself. */
export const SERPAPI_SLUG = "serpapi";
/** Hop-1 results tried against hop 2, in position order. Each is one paid request. */
export const MAX_CANDIDATES = 3;
/**
 * Confidence for a store price from a verified entity: the aggregator's copy
 * of the retailer's product feed, checked against the variant, but not the
 * retailer's page itself. Feeds lag pages by hours.
 */
export const ENTITY_CONFIDENCE = 0.8;
/**
 * Confidence for a hop-1 result mapped on its own: one seller's price for an
 * entity nothing verified as the right variant.
 */
export const FALLBACK_CONFIDENCE = 0.5;
/** Where a quote points when the aggregator gives no link at all. */
const GOOGLE_SHOPPING_URL = "https://www.google.com/shopping";
/** Used when the seller name has no letters or digits to slugify. */
const UNKNOWN_SELLER_SLUG = "unknown-seller";
/** Hop-1 results kept by the discovery function, in position order. */
export const DISCOVERY_DEFAULT_LIMIT = 20;
export const DISCOVERY_MAX_LIMIT = 40;

/** The fields of a hop-1 shopping result DealZ keeps in `raw`. */
const rawItemShape = {
  position: z.number().optional(),
  title: z.string(),
  product_id: z.string().optional(),
  product_link: z.string().optional(),
  link: z.string().optional(),
  source: z.string(),
  price: z.string().optional(),
  extracted_price: z.number().optional(),
  old_price: z.string().optional(),
  extracted_old_price: z.number().optional(),
  delivery: z.string().optional(),
  second_hand_condition: z.string().optional(),
  tag: z.string().optional(),
};

/**
 * Provider fields are tolerated on the way in but never kept. The token is
 * read, not kept; the thumbnail is kept by the discovery function only.
 */
const itemSchema = z.looseObject({
  ...rawItemShape,
  immersive_product_page_token: z.string().optional(),
  thumbnail: z.string().optional(),
});

/** z.object strips unknown keys and omits absent optional ones, so `raw` is exactly rawItemShape. */
const rawItemSchema = z.object(rawItemShape);

/** A candidate's `raw`: the quote's fields plus the thumbnail, which a search result shows and a price never needs. */
const discoveryRawItemSchema = z.object({ ...rawItemShape, thumbnail: z.string().optional() });

type ShoppingItem = z.infer<typeof itemSchema>;

/** Items are validated one by one so a malformed result drops out alone. */
const shoppingResponseSchema = z.looseObject({
  error: z.string().optional(),
  shopping_results: z.array(z.unknown()).optional(),
});

/** One store of a product entity, as hop 2 lists it. Other fields stay in `raw`. */
const storeSchema = z.looseObject({
  name: z.string(),
  link: z.string().optional(),
  title: z.string().optional(),
  price: z.string().optional(),
  extracted_price: z.number().optional(),
  original_price: z.string().optional(),
  extracted_original_price: z.number().optional(),
  shipping: z.string().optional(),
  shipping_extracted: z.number().optional(),
  tag: z.string().optional(),
  details_and_offers: z.array(z.string()).optional(),
});

type Store = z.infer<typeof storeSchema>;

const immersiveResponseSchema = z.looseObject({
  error: z.string().optional(),
  product_results: z.looseObject({ stores: z.array(z.unknown()).optional() }).optional(),
});

/** Keys dropped from a store's `raw`: bulky and never needed to replay a parse. */
const OMITTED_STORE_KEYS: ReadonlySet<string> = new Set(["logo"]);

/** Samsung-style model codes such as QA65S85HAEXXY, as they appear in titles. */
const MODEL_CODE_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{5,}\b/;

/** The request URL with the key replaced, safe to log or put in an error. */
export function redactApiKey(url: string): string {
  return url.replace(/([?&]api_key=)[^&#]*/g, "$1REDACTED");
}

/** Hop 1: the shopping search. */
export function serpApiRequestUrl(query: string, region: string, apiKey: string): string {
  const gl = region.toLowerCase();
  const params = new URLSearchParams({
    engine: "google_shopping",
    q: query,
    gl,
    hl: "en",
    google_domain: gl === "au" ? "google.com.au" : "google.com",
    api_key: apiKey,
  });
  return `${SERPAPI_ENDPOINT}?${params.toString()}`;
}

/** Hop 2: one entity's stores. The token carries the locale of the search it came from. */
export function serpApiImmersiveUrl(pageToken: string, apiKey: string): string {
  const params = new URLSearchParams({
    engine: "google_immersive_product",
    page_token: pageToken,
    more_stores: "true",
    api_key: apiKey,
  });
  return `${SERPAPI_ENDPOINT}?${params.toString()}`;
}

/** Canonicalises an http(s) link; null for anything else. */
function canonicalOrNull(candidate: string | undefined): string | null {
  if (candidate === undefined) return null;
  try {
    return canonicaliseUrl(candidate);
  } catch {
    return null;
  }
}

/**
 * Google Shopping lists new goods unless the seller says otherwise, so "new"
 * is the default. Second-hand listings carry `second_hand_condition` or a
 * `tag`, and eBay-style titles say "Refurbished" or "Pre-Owned" themselves.
 */
export function readSearchCondition(item: {
  second_hand_condition?: string;
  tag?: string;
  title: string;
}): QuoteCondition {
  const text = [item.second_hand_condition, item.tag, item.title]
    .filter((part): part is string => typeof part === "string")
    .join(" ")
    .toLowerCase();
  if (text.includes("refurb")) return "refurbished";
  if (/\bused\b|\bpre-owned\b/.test(text)) return "used";
  return "new";
}

/** Hop 2 says "In stock online" or "Out of stock" among a store's details; hop 1 says nothing. */
export function readStoreAvailability(details: string[] | undefined): Availability {
  const text = (details ?? []).join(" ").toLowerCase();
  if (text.includes("out of stock")) return "out_of_stock";
  if (text.includes("in stock")) return "in_stock";
  return "unknown";
}

/** `shipping_extracted` when given; 0 for "Free"; the shipping text otherwise; null when absent. */
export function readShippingCents(store: {
  shipping?: string;
  shipping_extracted?: number;
}): number | null {
  if (store.shipping_extracted !== undefined) return parseCents(store.shipping_extracted);
  if (store.shipping === undefined) return null;
  if (/free/i.test(store.shipping)) return 0;
  return parseCents(store.shipping);
}

/** The Samsung-style code of the price search. The discovery function uses the general rule of lib/model-code. */
function readSamsungModelCode(title: string): string | null {
  const match = MODEL_CODE_RE.exec(title);
  return match === null ? null : match[0];
}

function containsToken(text: string, token: string): boolean {
  return text.toLowerCase().includes(token.toLowerCase());
}

/**
 * A hop-1 result is a candidate for the entity when its title carries every
 * `mustMatch` token and no model code other than one in `verifyTokens`. The
 * second rule drops a sibling variant Google matched on the series alone,
 * such as a 48-inch European model returned for a 65-inch Australian query.
 */
export function isCandidate(
  title: string,
  input: Pick<SearchSourceInput, "mustMatch" | "verifyTokens">,
): boolean {
  if (!input.mustMatch.every((token) => containsToken(title, token))) return false;
  const modelCode = readSamsungModelCode(title);
  if (modelCode === null) return true;
  return input.verifyTokens.some((token) => token.toLowerCase() === modelCode.toLowerCase());
}

/** True when at least half of the stores name the variant in their title or store name. */
export function storesVerify(stores: Store[], verifyTokens: string[]): boolean {
  if (stores.length === 0) return false;
  const matching = stores.filter((store) =>
    verifyTokens.some((token) => containsToken(`${store.title ?? ""} ${store.name}`, token)),
  ).length;
  return matching * 2 >= stores.length;
}

/** SerpApi prices for gl=au are in Australian dollars. Any other region is a placeholder. */
function currencyOf(region: string): string {
  return region.toLowerCase() === "au" ? "AUD" : region.toUpperCase();
}

function strikethroughAbove(priceCents: number, candidate: number | null): number | null {
  return candidate !== null && candidate > priceCents ? candidate : null;
}

function quoteFromStore(
  store: Store,
  entity: ShoppingItem,
  region: string,
  fetchedAt: Date,
): PriceQuote | null {
  const priceCents = parseCents(store.extracted_price ?? store.price);
  if (priceCents === null) return null;
  const title = store.title ?? null;
  const raw = Object.fromEntries(
    Object.entries(store).filter(([key]) => !OMITTED_STORE_KEYS.has(key)),
  );

  return {
    retailerSlug: slugify(store.name) || UNKNOWN_SELLER_SLUG,
    retailerName: store.name,
    url: canonicalOrNull(store.link) ?? canonicalOrNull(entity.product_link) ?? GOOGLE_SHOPPING_URL,
    method: "serpapi_google_shopping",
    fetchedAt,
    observedAt: fetchedAt,
    title,
    priceCents,
    currency: currencyOf(region),
    strikethroughCents: strikethroughAbove(
      priceCents,
      parseCents(store.extracted_original_price ?? store.original_price),
    ),
    shippingCents: readShippingCents(store),
    availability: readStoreAvailability(store.details_and_offers),
    condition: readSearchCondition({ title: title ?? "", tag: store.tag }),
    identifiers: {
      gtin: null,
      mpn: title === null ? null : readSamsungModelCode(title),
      retailerSku: null,
    },
    provenance: { kind: "search", via: entity.product_link ?? null },
    confidence: ENTITY_CONFIDENCE,
    evidence: title,
    raw,
  };
}

function quoteFromItem(item: ShoppingItem, region: string, fetchedAt: Date): PriceQuote | null {
  const priceCents = parseCents(item.extracted_price ?? item.price);
  if (priceCents === null) return null;

  return {
    retailerSlug: slugify(item.source) || UNKNOWN_SELLER_SLUG,
    retailerName: item.source,
    url: canonicalOrNull(item.product_link) ?? canonicalOrNull(item.link) ?? GOOGLE_SHOPPING_URL,
    method: "serpapi_google_shopping",
    fetchedAt,
    observedAt: fetchedAt,
    title: item.title,
    currency: currencyOf(region),
    priceCents,
    strikethroughCents: strikethroughAbove(
      priceCents,
      parseCents(item.extracted_old_price ?? item.old_price),
    ),
    // Hop 1 states delivery as text only; "Free delivery" is the one value it makes plain.
    shippingCents: item.delivery !== undefined && /free/i.test(item.delivery) ? 0 : null,
    availability: "unknown",
    condition: readSearchCondition(item),
    identifiers: { gtin: null, mpn: readSamsungModelCode(item.title), retailerSku: null },
    provenance: { kind: "search", via: item.product_link ?? null },
    confidence: FALLBACK_CONFIDENCE,
    evidence: item.title,
    raw: rawItemSchema.parse(item),
  };
}

/** Re-throws a SourceError from fetchBody with the key stripped from its message. */
function withoutKey(error: SourceError, safeUrl: string): SourceError {
  return new SourceError(error.kind, SERPAPI_SLUG, `Request to ${safeUrl} failed: ${error.kind}`, {
    status: error.status ?? undefined,
    cause: error.cause,
  });
}

/**
 * One SerpApi request, parsed against `schema`. Every error names the URL
 * with the key redacted. An `error` field in the payload is SerpApi saying
 * no, at any status, and is reported as "http".
 */
/** What a SerpApi request needs from its caller besides the URL. */
interface SerpApiRequestInput {
  fetch?: FetchLike;
  now?: () => Date;
  meter?: Meter;
}

/**
 * requestSerpApi, reported to the meter as one call. SerpApi can say no in a
 * 200 body, so the call is judged after the body is parsed, not when the
 * response arrives: that is why this does not go through fetchText.
 */
async function fetchSerpApi<T extends { error?: string }>(
  input: SerpApiRequestInput,
  operation: SourceOperation,
  requestUrl: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const finish = beginCall(input.meter, input.now, {
    provider: "serpapi",
    operation,
    retailerSlug: null,
  });
  const seen: { httpStatus: number | null } = { httpStatus: null };
  try {
    const data = await requestSerpApi(input, requestUrl, schema, seen);
    finish(seen);
    return data;
  } catch (error) {
    finish({ ...seen, error });
    throw error;
  }
}

async function requestSerpApi<T extends { error?: string }>(
  input: SerpApiRequestInput,
  requestUrl: string,
  schema: z.ZodType<T>,
  seen: { httpStatus: number | null },
): Promise<T> {
  const safeUrl = redactApiKey(requestUrl);

  let body: string;
  try {
    const answer = await fetchBody({ retailerSlug: SERPAPI_SLUG, fetch: input.fetch }, requestUrl, {
      headers: { accept: "application/json" },
    });
    seen.httpStatus = answer.status;
    body = answer.body;
  } catch (error) {
    if (error instanceof SourceError) throw withoutKey(error, safeUrl);
    throw error;
  }

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (cause) {
    throw new SourceError("unparseable", SERPAPI_SLUG, `${safeUrl} is not JSON`, { cause });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new SourceError("unparseable", SERPAPI_SLUG, `${safeUrl} has an unexpected shape`, {
      cause: parsed.error,
    });
  }
  if (parsed.data.error !== undefined) {
    throw new SourceError("http", SERPAPI_SLUG, `SerpApi answered: ${parsed.data.error}`);
  }
  return parsed.data;
}

/** Hop 2 for one candidate. Throws SourceError as hop 1 does; the caller decides whether to move on. */
async function fetchStores(input: SearchSourceInput, pageToken: string): Promise<Store[]> {
  const response = await fetchSerpApi(
    input,
    "google_immersive_product",
    serpApiImmersiveUrl(pageToken, input.apiKey),
    immersiveResponseSchema,
  );
  const stores: Store[] = [];
  for (const candidate of response.product_results?.stores ?? []) {
    const store = storeSchema.safeParse(candidate);
    if (store.success) stores.push(store.data);
  }
  return stores;
}

export const searchGoogleShopping: SearchSource = async (input) => {
  const now = input.now ?? (() => new Date());

  const response = await fetchSerpApi(
    input,
    "google_shopping",
    serpApiRequestUrl(input.query, input.region, input.apiKey),
    shoppingResponseSchema,
  );
  const fetchedAt = now();

  const matching: ShoppingItem[] = [];
  for (const candidate of response.shopping_results ?? []) {
    const item = itemSchema.safeParse(candidate);
    if (item.success && isCandidate(item.data.title, input)) matching.push(item.data);
  }

  const candidates = matching
    .filter((item) => item.immersive_product_page_token !== undefined)
    .slice(0, MAX_CANDIDATES);
  let failures = 0;
  let lastError: SourceError | null = null;
  for (const entity of candidates) {
    let stores: Store[];
    try {
      stores = await fetchStores(input, entity.immersive_product_page_token ?? "");
    } catch (error) {
      // One entity's page failing is not the search failing; the next may answer.
      if (!(error instanceof SourceError)) throw error;
      failures += 1;
      lastError = error;
      continue;
    }
    if (!storesVerify(stores, input.verifyTokens)) continue;
    const quotes: PriceQuote[] = [];
    for (const store of stores) {
      const quote = quoteFromStore(store, entity, input.region, fetchedAt);
      if (quote !== null) quotes.push(quote);
    }
    return quotes.sort((a, b) => a.priceCents - b.priceCents);
  }
  if (lastError !== null && failures === candidates.length) throw lastError;

  const quotes: PriceQuote[] = [];
  for (const item of matching) {
    const quote = quoteFromItem(item, input.region, fetchedAt);
    if (quote !== null) quotes.push(quote);
  }
  return quotes.sort((a, b) => a.priceCents - b.priceCents);
};

// ---------- Discovery: one hop, every result a candidate (ADR-0017, miss path) ----------

function clampDiscoveryLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DISCOVERY_DEFAULT_LIMIT;
  return Math.min(DISCOVERY_MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

/**
 * A hop-1 result as a candidate. Nothing is dropped for want of a price:
 * the index allows a row without one, and a seller Google lists is worth
 * knowing about. The handle is Google's product id, else a slug of seller
 * and title, so the index's (retailer, handle) key holds.
 */
function candidateFromItem(item: ShoppingItem, region: string, fetchedAt: Date): ProductCandidate {
  const priceCents = parseCents(item.extracted_price ?? item.price);
  return {
    retailerSlug: slugify(item.source) || UNKNOWN_SELLER_SLUG,
    retailerName: item.source,
    method: "google_shopping",
    fetchedAt,
    title: item.title,
    // Google names no brand; the relevance rule judges the title alone.
    brand: null,
    storeType: null,
    // The seller's own page when Google gives it, else Google's product page.
    url: canonicalOrNull(item.link) ?? canonicalOrNull(item.product_link) ?? GOOGLE_SHOPPING_URL,
    handle: item.product_id ?? (slugify(`${item.source}-${item.title}`) || null),
    priceCents,
    currency: currencyOf(region),
    strikethroughCents:
      priceCents === null
        ? null
        : strikethroughAbove(priceCents, parseCents(item.extracted_old_price ?? item.old_price)),
    availability: "unknown",
    imageUrl: item.thumbnail ?? null,
    identifiers: { gtin: null, mpn: readTitleModelCode(item.title), retailerSku: null },
    provenance: { kind: "search", via: item.product_link ?? null },
    raw: discoveryRawItemSchema.parse(item),
  };
}

/**
 * One request, hop 1, every result a candidate in position order. Throws
 * SourceError under the "serpapi" slug, with the key redacted, as the price
 * search does; an `error` body is a failed call.
 */
export const discoverGoogleShopping: GoogleShoppingDiscoverySource = async (input) => {
  const now = input.now ?? (() => new Date());
  const limit = clampDiscoveryLimit(input.limit);

  const response = await fetchSerpApi(
    input,
    "google_shopping",
    serpApiRequestUrl(input.query, input.region, input.apiKey),
    shoppingResponseSchema,
  );
  const fetchedAt = now();

  const candidates: ProductCandidate[] = [];
  for (const entry of response.shopping_results ?? []) {
    if (candidates.length >= limit) break;
    // A malformed result drops out alone, never the search.
    const item = itemSchema.safeParse(entry);
    if (item.success) candidates.push(candidateFromItem(item.data, input.region, fetchedAt));
  }
  return candidates;
};

// ---------- Account: plan and quota, for the status page ----------

export interface SerpApiAccountInput {
  apiKey: string;
  fetch?: FetchLike;
  now?: () => Date;
  meter?: Meter;
}

/** The plan and what is left of it. Never the key or the account's email. */
export interface SerpApiAccount {
  planName: string;
  searchesPerMonth: number | null;
  thisMonthUsage: number | null;
  /** Left on the plan this month, before extra credits. */
  planSearchesLeft: number | null;
  /** Left this month counting extra credits. */
  totalSearchesLeft: number | null;
  fetchedAt: Date;
}

const optionalCount = z.number().nullable().optional().catch(null);

/**
 * The fields DealZ reads. The response also carries `api_key` and
 * `account_email`; they are read past and never kept.
 */
const accountResponseSchema = z.looseObject({
  error: z.string().optional(),
  plan_name: z.string().optional(),
  searches_per_month: optionalCount,
  this_month_usage: optionalCount,
  plan_searches_left: optionalCount,
  total_searches_left: optionalCount,
});

export function serpApiAccountUrl(apiKey: string): string {
  return `${SERPAPI_ACCOUNT_ENDPOINT}?${new URLSearchParams({ api_key: apiKey }).toString()}`;
}

/**
 * Asks SerpApi for the account's plan and remaining searches. Throws
 * SourceError under the "serpapi" slug, with the key redacted, as the search
 * does; "unparseable" when the answer names no plan.
 */
export async function fetchSerpApiAccount(input: SerpApiAccountInput): Promise<SerpApiAccount> {
  const now = input.now ?? (() => new Date());
  const response = await fetchSerpApi(
    input,
    "account",
    serpApiAccountUrl(input.apiKey),
    accountResponseSchema,
  );
  if (response.plan_name === undefined) {
    throw new SourceError("unparseable", SERPAPI_SLUG, "SerpApi account answer names no plan");
  }
  return {
    planName: response.plan_name,
    searchesPerMonth: response.searches_per_month ?? null,
    thisMonthUsage: response.this_month_usage ?? null,
    planSearchesLeft: response.plan_searches_left ?? null,
    totalSearchesLeft: response.total_searches_left ?? null,
    fetchedAt: now(),
  };
}
