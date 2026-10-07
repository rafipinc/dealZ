// storefront_search: asks a Shopify storefront's predictive search for the
// products matching one query, at /search/suggest.json. One request, many
// ProductCandidates, no key (ADR-0016 item 5; the field work is
// docs/research/2026-10-06-shopify-storefront-search.md).
//
// A candidate is not a price fact. The suggest response carries no barcode
// and no SKU; fetchCandidateIdentifiers reads the product JSON for one
// candidate when the developer asks (ADR-0016 item 6).

import { z } from "zod";
import { readModelCode } from "../lib/model-code";
import { parseCents } from "../lib/money";
import { canonicaliseUrl } from "../lib/url";
import { fetchText, originOf } from "./http";
import { fetchShopifyQuote } from "./shopify";
import {
  SourceError,
  type Availability,
  type DiscoverySource,
  type ProductCandidate,
  type Source,
} from "./types";

export const SUGGEST_PATH = "/search/suggest.json";
export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 20;

const SEARCH_CALL = { provider: "retailer", operation: "search" } as const;

const nullableString = z.string().nullable().catch(null);
const nullablePrice = z.union([z.string(), z.number()]).nullable().catch(null);

/** Shopify sends `featured_image` as an object with `url`, older themes as a plain URL string. */
const imageSchema = z
  .union([z.string(), z.looseObject({ url: nullableString })])
  .nullable()
  .catch(null);

const productSchema = z.looseObject({
  title: nullableString,
  vendor: nullableString,
  type: nullableString,
  handle: nullableString,
  url: nullableString,
  price: nullablePrice,
  compare_at_price_min: nullablePrice,
  available: z.boolean().nullable().catch(null),
  tags: z
    .union([z.string(), z.array(z.string())])
    .nullable()
    .catch(null),
  featured_image: imageSchema,
  image: nullableString,
});

/** Whatever each product is, the parse decides per product; a bad one is skipped, not fatal. */
const envelopeSchema = z.looseObject({
  resources: z.looseObject({
    results: z.looseObject({ products: z.array(z.unknown()) }),
  }),
});

type SuggestProduct = z.infer<typeof productSchema>;

/** Keys dropped from `raw`: the HTML description is bulky and never needed to replay a parse. */
const OMITTED_RAW_KEYS: ReadonlySet<string> = new Set(["body"]);

/** The predictive search URL for one query. The brackets are percent-encoded; Shopify accepts both forms. */
export function suggestUrl(origin: string, query: string, limit: number): string {
  const params = new URLSearchParams({
    q: query,
    "resources[type]": "product",
    "resources[limit]": String(limit),
  });
  return `${origin}${SUGGEST_PATH}?${params.toString()}`;
}

function readTags(tags: string | string[] | null): string[] {
  if (tags === null) return [];
  const list = Array.isArray(tags) ? tags : tags.split(",");
  return list.map((tag) => tag.trim().toLowerCase());
}

/** A stock tag is the store's own word and wins; `available` is the fallback. */
function readAvailability(product: SuggestProduct): Availability {
  const tags = readTags(product.tags);
  if (tags.includes("instock")) return "in_stock";
  if (tags.includes("outofstock") || tags.includes("soldout")) return "out_of_stock";
  if (product.available === null) return "unknown";
  return product.available ? "in_stock" : "out_of_stock";
}

function readImageUrl(product: SuggestProduct): string | null {
  const featured = product.featured_image;
  if (typeof featured === "string") return featured;
  if (featured !== null && featured.url !== null) return featured.url;
  return product.image;
}

/** The product page as an absolute, canonical URL. Null when the path is missing or not a URL. */
function readPageUrl(origin: string, path: string | null): string | null {
  if (path === null) return null;
  try {
    return canonicaliseUrl(new URL(path, origin).toString());
  } catch {
    return null;
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

export const searchStorefront: DiscoverySource = async (input) => {
  const origin = originOf(input);
  const url = suggestUrl(origin, input.query, clampLimit(input.limit));
  const now = input.now ?? (() => new Date());

  const body = await fetchText({ ...input, url }, url, {
    headers: { accept: "application/json" },
    call: SEARCH_CALL,
  });

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (cause) {
    throw new SourceError("unparseable", input.retailerSlug, `${url} is not JSON`, { cause });
  }
  const parsed = envelopeSchema.safeParse(json);
  if (!parsed.success) {
    throw new SourceError(
      "unparseable",
      input.retailerSlug,
      `${url} is not a predictive search response`,
      { cause: parsed.error },
    );
  }

  const fetchedAt = now();
  const candidates: ProductCandidate[] = [];
  for (const entry of parsed.data.resources.results.products) {
    const product = productSchema.safeParse(entry);
    // A result without a title or a page is not a product we can show; skip it, never fail the search.
    if (!product.success || product.data.title === null) continue;
    const pageUrl = readPageUrl(origin, product.data.url);
    if (pageUrl === null) continue;

    const priceCents = parseCents(product.data.price);
    const compareAtCents = parseCents(product.data.compare_at_price_min);
    // "0.00" means no compare-at price; one at or below the price is not a strikethrough.
    const strikethroughCents =
      priceCents !== null && compareAtCents !== null && compareAtCents > priceCents
        ? compareAtCents
        : null;

    const raw = Object.fromEntries(
      Object.entries(product.data).filter(([key]) => !OMITTED_RAW_KEYS.has(key)),
    );

    candidates.push({
      retailerSlug: input.retailerSlug,
      retailerName: input.retailerName ?? null,
      method: "storefront_search",
      fetchedAt,
      title: product.data.title,
      brand: product.data.vendor,
      storeType: product.data.type,
      url: pageUrl,
      handle: product.data.handle,
      priceCents,
      // Predictive search carries no currency; a store on an .au domain
      // prices in AUD. Revisit if a source outside Australia is added.
      currency: "AUD",
      strikethroughCents,
      availability: readAvailability(product.data),
      imageUrl: readImageUrl(product.data),
      identifiers: {
        gtin: null,
        // The only identifier a title can carry; the product JSON has the rest.
        mpn: readModelCode(product.data.title),
        retailerSku: null,
      },
      provenance: { kind: "search", via: url },
      raw,
    });
  }
  return candidates;
};

/**
 * The lazy identifier fetch of ADR-0016 item 6: reads one candidate's product
 * JSON through the shopify_json reader. The quote's identifiers carry the
 * barcode as a 14-digit GTIN and the store's SKU. One request, metered as a page.
 */
export const fetchCandidateIdentifiers: Source = (input) => fetchShopifyQuote(input);
