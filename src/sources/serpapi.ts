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

import { z } from "zod";
import { parseCents } from "../lib/money";
import { slugify } from "../lib/slug";
import { canonicaliseUrl } from "../lib/url";
import { fetchText } from "./http";
import {
  SourceError,
  type Availability,
  type PriceQuote,
  type QuoteCondition,
  type SearchSource,
  type SearchSourceInput,
  type SourceInput,
} from "./types";

export const SERPAPI_ENDPOINT = "https://serpapi.com/search.json";
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

/** Provider fields are tolerated on the way in but never kept. The token is read, not kept. */
const itemSchema = z.looseObject({
  ...rawItemShape,
  immersive_product_page_token: z.string().optional(),
});

/** z.object strips unknown keys and omits absent optional ones, so `raw` is exactly rawItemShape. */
const rawItemSchema = z.object(rawItemShape);

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

function readModelCode(title: string): string | null {
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
  const modelCode = readModelCode(title);
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
      mpn: title === null ? null : readModelCode(title),
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
    identifiers: { gtin: null, mpn: readModelCode(item.title), retailerSku: null },
    provenance: { kind: "search", via: item.product_link ?? null },
    confidence: FALLBACK_CONFIDENCE,
    evidence: item.title,
    raw: rawItemSchema.parse(item),
  };
}

/** Re-throws a SourceError from fetchText with the key stripped from its message. */
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
async function fetchSerpApi<T extends { error?: string }>(
  input: SearchSourceInput,
  requestUrl: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const safeUrl = redactApiKey(requestUrl);
  const fetchInput: SourceInput = { retailerSlug: SERPAPI_SLUG, url: safeUrl, fetch: input.fetch };

  let body: string;
  try {
    body = await fetchText(fetchInput, requestUrl, { headers: { accept: "application/json" } });
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
