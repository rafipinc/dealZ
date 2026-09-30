// shopify_json: reads a Shopify store's public product JSON at
// /products/<handle>.json. Works where robots.txt allows the path
// (docs/research/2026-09-28-s85h-live-fetch.md). Reads the first variant.

import { z } from "zod";
import { normaliseGtin } from "../lib/gtin";
import { parseCents } from "../lib/money";
import { fetchText, pageUrlOf } from "./http";
import { SourceError, type Availability, type QuoteCondition, type Source } from "./types";

const nullableString = z.string().nullable().catch(null);
const nullablePrice = z.union([z.string(), z.number()]).nullable().catch(null);

const variantSchema = z.looseObject({
  price: nullablePrice,
  compare_at_price: nullablePrice,
  barcode: nullableString,
  sku: nullableString,
});

const productSchema = z.looseObject({
  title: nullableString,
  tags: z
    .union([z.string(), z.array(z.string())])
    .nullable()
    .catch(null),
  variants: z.array(variantSchema).min(1),
});

const envelopeSchema = z.looseObject({ product: productSchema });

/**
 * Confidence for a Shopify product JSON price: the store's own structured
 * data, read from the live endpoint with no interpretation, so 1.
 */
export const SHOPIFY_CONFIDENCE = 1;

/** Keys dropped from `raw`: bulky and never needed to replay a parse. */
const OMITTED_RAW_KEYS: ReadonlySet<string> = new Set(["images", "image", "body_html", "options"]);

/** The product JSON URL for a canonical page URL: origin plus path plus `.json`. */
export function shopifyJsonUrl(pageUrl: string): string {
  const url = new URL(pageUrl);
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path.endsWith(".json") ? path : `${path}.json`}`;
}

function readTags(tags: string | string[] | null): string[] {
  if (tags === null) return [];
  const list = Array.isArray(tags) ? tags : tags.split(",");
  return list.map((tag) => tag.trim().toLowerCase());
}

/**
 * Shopify product JSON has no condition field. A refurbished listing on an
 * AU retailer's store says so in its title ("Refurbished", "Refurb"); anything
 * else is sold as new. A heuristic, kept until a store proves it wrong.
 */
export function readShopifyCondition(title: string | null): QuoteCondition {
  return title !== null && /refurb/i.test(title) ? "refurbished" : "new";
}

function readAvailability(tags: string[]): Availability {
  if (tags.includes("instock")) return "in_stock";
  if (tags.includes("outofstock") || tags.includes("soldout")) return "out_of_stock";
  return "unknown";
}

export const fetchShopifyQuote: Source = async (input) => {
  const pageUrl = pageUrlOf(input);
  const jsonUrl = shopifyJsonUrl(pageUrl);
  const now = input.now ?? (() => new Date());

  const body = await fetchText(input, jsonUrl, { headers: { accept: "application/json" } });

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (cause) {
    throw new SourceError("unparseable", input.retailerSlug, `${jsonUrl} is not JSON`, { cause });
  }
  const parsed = envelopeSchema.safeParse(json);
  if (!parsed.success) {
    throw new SourceError(
      "unparseable",
      input.retailerSlug,
      `${jsonUrl} has no product with variants`,
      { cause: parsed.error },
    );
  }
  const { product } = parsed.data;
  const variant = product.variants[0];

  const priceCents = parseCents(variant.price);
  if (priceCents === null) {
    throw new SourceError("unparseable", input.retailerSlug, `${jsonUrl} has no readable price`);
  }
  const compareAtCents = parseCents(variant.compare_at_price);
  const strikethroughCents =
    compareAtCents !== null && compareAtCents > priceCents ? compareAtCents : null;

  const raw = Object.fromEntries(
    Object.entries(product).filter(([key]) => !OMITTED_RAW_KEYS.has(key)),
  );

  const fetchedAt = now();
  return {
    retailerSlug: input.retailerSlug,
    retailerName: input.retailerName ?? null,
    url: pageUrl,
    method: "shopify_json",
    fetchedAt,
    observedAt: fetchedAt,
    title: product.title,
    priceCents,
    // Shopify product JSON carries no currency; a store on an .au domain
    // prices in AUD. Revisit if a source outside Australia is added.
    currency: "AUD",
    strikethroughCents,
    // Product JSON says nothing about delivery cost.
    shippingCents: null,
    availability: readAvailability(readTags(product.tags)),
    condition: readShopifyCondition(product.title),
    identifiers: {
      gtin: variant.barcode === null ? null : normaliseGtin(variant.barcode),
      mpn: null,
      retailerSku: variant.sku,
    },
    provenance: { kind: "live", via: null },
    confidence: SHOPIFY_CONFIDENCE,
    // Structured data needs no choice of fragment; nothing to point at.
    evidence: null,
    raw,
  };
};
