// storefront_listing: reads every product in one Shopify collection through
// the public /collections/<handle>/products.json, page by page. One
// collection in, many ProductCandidates out, no key (ADR-0016; decided by
// Rafi on 2026-10-06 for Powerland's `televisions` collection, 129 products
// in one request that day).
//
// Shopify serves at most 250 products a page. The walk asks for 250 and
// stops at the first page that returns fewer, or none, or when `maxPages`
// is reached. A politeness pause separates one page from the next.
//
// A candidate is not a price fact. The listing carries the first variant's
// price, SKU and stock flag but no barcode; fetchCandidateIdentifiers in
// storefront-search.ts reads the product JSON for one candidate on demand.

import { z } from "zod";
import { isModelCode, readModelCode } from "../lib/model-code";
import { parseCents } from "../lib/money";
import { canonicaliseUrl } from "../lib/url";
import { fetchText, originOf } from "./http";
import {
  SourceError,
  type Availability,
  type ListingSource,
  type ListingSourceInput,
  type ProductCandidate,
} from "./types";

/** The most products Shopify returns for one page; a shorter page is the last. */
export const PAGE_SIZE = 250;
export const DEFAULT_MAX_PAGES = 4;
export const MAX_PAGES = 40;
export const DEFAULT_DELAY_MS = 500;

const LISTING_CALL = { provider: "retailer", operation: "listing" } as const;

const nullableString = z.string().nullable().catch(null);
const nullablePrice = z.union([z.string(), z.number()]).nullable().catch(null);

const variantSchema = z.looseObject({
  price: nullablePrice,
  compare_at_price: nullablePrice,
  sku: nullableString,
  available: z.boolean().nullable().catch(null),
});

const imageSchema = z.looseObject({ src: nullableString });

/** Variants and images are parsed per entry below, so one odd entry never drops the product. */
const productSchema = z.looseObject({
  title: nullableString,
  handle: nullableString,
  vendor: nullableString,
  product_type: nullableString,
  tags: z
    .union([z.string(), z.array(z.string())])
    .nullable()
    .catch(null),
  variants: z.array(z.unknown()).nullable().catch(null),
  images: z.array(z.unknown()).nullable().catch(null),
});

/** Whatever each product is, the parse decides per product; a bad one is skipped, not fatal. */
const pageSchema = z.looseObject({ products: z.array(z.unknown()) });

type ListingProduct = z.infer<typeof productSchema>;
type ListingVariant = z.infer<typeof variantSchema>;

/** Keys dropped from `raw`: the HTML description is bulky and never needed to replay a parse. */
const OMITTED_RAW_KEYS: ReadonlySet<string> = new Set(["body_html"]);

/** The products.json URL for one page of a collection. */
export function listingUrl(origin: string, collection: string, page: number): string {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE), page: String(page) });
  return `${origin}/collections/${encodeURIComponent(collection)}/products.json?${params.toString()}`;
}

function clampMaxPages(maxPages: number | undefined): number {
  if (maxPages === undefined || !Number.isFinite(maxPages)) return DEFAULT_MAX_PAGES;
  return Math.min(MAX_PAGES, Math.max(1, Math.trunc(maxPages)));
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The first variant, or an empty one when the listing has none or it does not parse. */
function readVariant(product: ListingProduct): ListingVariant {
  const first = product.variants?.[0];
  const parsed = variantSchema.safeParse(first);
  return parsed.success
    ? parsed.data
    : { price: null, compare_at_price: null, sku: null, available: null };
}

function readImageUrl(product: ListingProduct): string | null {
  const parsed = imageSchema.safeParse(product.images?.[0]);
  return parsed.success ? parsed.data.src : null;
}

/** The listing's `available` is Shopify's own stock flag; nothing in the listing says more. */
function readAvailability(variant: ListingVariant): Availability {
  if (variant.available === null) return "unknown";
  return variant.available ? "in_stock" : "out_of_stock";
}

/**
 * The model code from the title, as the search source reads it. Powerland's
 * SKU is the model code itself ("OLED42C3PSA"), so a SKU that passes the
 * general rule stands in when the title carries none.
 */
function readMpn(title: string, sku: string | null): string | null {
  const fromTitle = readModelCode(title);
  if (fromTitle !== null) return fromTitle;
  return sku !== null && isModelCode(sku) ? sku : null;
}

/** The product page as a canonical URL, or null when the handle does not make one. */
function readPageUrl(origin: string, handle: string): string | null {
  try {
    return canonicaliseUrl(`${origin}/products/${handle}`);
  } catch {
    return null;
  }
}

function toCandidate(
  input: ListingSourceInput,
  origin: string,
  pageUrl: string,
  fetchedAt: Date,
  product: ListingProduct,
): ProductCandidate | null {
  // A product without a title or a handle has no page to show; skip it, never fail the walk.
  if (product.title === null || product.handle === null) return null;
  const url = readPageUrl(origin, product.handle);
  if (url === null) return null;

  const variant = readVariant(product);
  const priceCents = parseCents(variant.price);
  const compareAtCents = parseCents(variant.compare_at_price);
  // null or "0.00" means no compare-at price; one at or below the price is not a strikethrough.
  const strikethroughCents =
    priceCents !== null && compareAtCents !== null && compareAtCents > priceCents
      ? compareAtCents
      : null;

  const raw = Object.fromEntries(
    Object.entries(product)
      .filter(([key]) => !OMITTED_RAW_KEYS.has(key))
      .map(([key, value]) =>
        key === "images" ? [key, product.images?.slice(0, 1) ?? null] : [key, value],
      ),
  );

  return {
    retailerSlug: input.retailerSlug,
    retailerName: input.retailerName ?? null,
    method: "storefront_listing",
    fetchedAt,
    title: product.title,
    brand: product.vendor,
    storeType: product.product_type,
    url,
    handle: product.handle,
    priceCents,
    // The listing carries no currency; a store on an .au domain prices in
    // AUD. Revisit if a source outside Australia is added.
    currency: "AUD",
    strikethroughCents,
    availability: readAvailability(variant),
    imageUrl: readImageUrl(product),
    identifiers: {
      // A listing never carries the barcode; the product JSON does.
      gtin: null,
      mpn: readMpn(product.title, variant.sku),
      retailerSku: variant.sku,
    },
    provenance: { kind: "search", via: pageUrl },
    raw,
  };
}

/** One page of the collection: what it listed, and what parsed. Stop rule reads `listed`, so a page of junk still ends the walk. */
interface ListingPage {
  listed: number;
  found: ProductCandidate[];
}

/** Fetches and parses one page. Throws SourceError as the HTTP layer and the parse decide. */
async function readPage(
  input: ListingSourceInput,
  origin: string,
  pageUrl: string,
  now: () => Date,
): Promise<ListingPage> {
  const body = await fetchText({ ...input, url: pageUrl }, pageUrl, {
    headers: { accept: "application/json" },
    call: LISTING_CALL,
  });

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (cause) {
    throw new SourceError("unparseable", input.retailerSlug, `${pageUrl} is not JSON`, { cause });
  }
  const parsed = pageSchema.safeParse(json);
  if (!parsed.success) {
    throw new SourceError(
      "unparseable",
      input.retailerSlug,
      `${pageUrl} is not a collection products listing`,
      { cause: parsed.error },
    );
  }

  const fetchedAt = now();
  const found: ProductCandidate[] = [];
  for (const entry of parsed.data.products) {
    const product = productSchema.safeParse(entry);
    if (!product.success) continue;
    const candidate = toCandidate(input, origin, pageUrl, fetchedAt, product.data);
    if (candidate !== null) found.push(candidate);
  }
  return { listed: parsed.data.products.length, found };
}

export const listStorefrontCollection: ListingSource = async (input) => {
  const origin = originOf(input);
  const maxPages = clampMaxPages(input.maxPages);
  const delayMs = input.delayMs ?? DEFAULT_DELAY_MS;
  const sleep = input.sleep ?? defaultSleep;
  const now = input.now ?? (() => new Date());

  const candidates: ProductCandidate[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    if (page > 1 && delayMs > 0) await sleep(delayMs);
    const pageUrl = listingUrl(origin, input.collection, page);
    const { listed, found } = await readPage(input, origin, pageUrl, now);
    candidates.push(...found);
    // A short page is the last one; an empty page means the previous was.
    if (listed < PAGE_SIZE) break;
  }
  return candidates;
};
