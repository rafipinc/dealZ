// schema.org JSON-LD as retailers embed it. Extraction is lenient: blocks
// that fail to parse are skipped, and a Product missing a field yields null
// for that field rather than an error.

import { z } from "zod";
import { normaliseGtin } from "./gtin";
import { parseCents } from "./money";

export type ProductAvailability = "in_stock" | "out_of_stock" | "unknown";

/** schema.org OfferItemCondition folded to what DealZ tracks. */
export type ProductCondition = "new" | "refurbished" | "used" | "unknown";

export interface ProductOffer {
  name: string | null;
  brand: string | null;
  sku: string | null;
  gtin: string | null;
  mpn: string | null;
  model: string | null;
  priceCents: number | null;
  currency: string | null;
  strikethroughCents: number | null;
  /** From offers.shippingDetails.shippingRate.value when present; null otherwise, 0 when free. */
  shippingCents: number | null;
  availability: ProductAvailability;
  condition: ProductCondition;
}

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const LD_JSON_TYPE_RE = /\btype\s*=\s*["']?\s*application\/ld\+json\s*["']?/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `@type` values of a node as a list of strings. */
function typesOf(node: unknown): string[] {
  if (!isRecord(node)) return [];
  const type = node["@type"];
  if (typeof type === "string") return [type];
  if (Array.isArray(type)) return type.filter((t): t is string => typeof t === "string");
  return [];
}

/**
 * Returns every JSON-LD node in the document, in order. A top-level array
 * contributes its elements; a node with an `@graph` array contributes the
 * graph's elements and not the wrapper. Blocks that are not valid JSON are
 * skipped.
 */
export function extractJsonLd(html: string): unknown[] {
  const nodes: unknown[] = [];
  for (const match of html.matchAll(SCRIPT_RE)) {
    const [, attributes, body] = match;
    if (!LD_JSON_TYPE_RE.test(attributes)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      if (isRecord(item) && Array.isArray(item["@graph"])) {
        nodes.push(...item["@graph"]);
      } else {
        nodes.push(item);
      }
    }
  }
  return nodes;
}

/** The first node whose `@type` is or includes "Product", or null. */
export function findProduct(nodes: unknown[]): unknown | null {
  const product = nodes.find((node) => typesOf(node).includes("Product"));
  return product === undefined ? null : product;
}

const nullableString = z.string().nullable().catch(null);
const nullableIdentifier = z
  .union([z.string(), z.number().transform((n) => String(n))])
  .nullable()
  .catch(null);
const nullablePrice = z.union([z.string(), z.number()]).nullable().catch(null);

const brandSchema = z
  .union([z.string(), z.looseObject({ name: z.string() }).transform((brand) => brand.name)])
  .nullable()
  .catch(null);

const productSchema = z.looseObject({
  name: nullableString,
  brand: brandSchema,
  sku: nullableString,
  mpn: nullableString,
  model: nullableString,
  gtin14: nullableIdentifier,
  gtin13: nullableIdentifier,
  gtin12: nullableIdentifier,
  gtin8: nullableIdentifier,
  gtin: nullableIdentifier,
  offers: z.unknown().optional(),
});

const offerSchema = z.looseObject({
  price: nullablePrice,
  lowPrice: nullablePrice,
  priceCurrency: nullableString,
  priceSpecification: z.unknown().optional(),
  shippingDetails: z.unknown().optional(),
  availability: nullableString,
  itemCondition: nullableString,
});

const priceSpecificationSchema = z.looseObject({
  priceType: nullableString,
  price: nullablePrice,
});

const shippingDetailsSchema = z.looseObject({
  shippingRate: z.looseObject({ value: nullablePrice }).nullable().catch(null),
});

const IN_STOCK_TOKENS: ReadonlySet<string> = new Set([
  "instock",
  "instoreonly",
  "onlineonly",
  "limitedavailability",
  "presale",
]);
const OUT_OF_STOCK_TOKENS: ReadonlySet<string> = new Set(["outofstock", "soldout", "discontinued"]);

/** The last path segment of a schema.org URL, or the bare token, lower-cased. */
function lastToken(value: string): string {
  const segments = value.trim().split("/");
  return segments[segments.length - 1].toLowerCase();
}

function readAvailability(value: string | null): ProductAvailability {
  if (value === null) return "unknown";
  const token = lastToken(value);
  if (IN_STOCK_TOKENS.has(token)) return "in_stock";
  if (OUT_OF_STOCK_TOKENS.has(token)) return "out_of_stock";
  return "unknown";
}

const CONDITION_BY_TOKEN: ReadonlyMap<string, ProductCondition> = new Map([
  ["newcondition", "new"],
  ["refurbishedcondition", "refurbished"],
  ["usedcondition", "used"],
  ["damagedcondition", "used"],
]);

function readCondition(value: string | null): ProductCondition {
  if (value === null) return "unknown";
  return CONDITION_BY_TOKEN.get(lastToken(value)) ?? "unknown";
}

function readStrikethroughCents(specification: unknown): number | null {
  const entries: unknown[] = Array.isArray(specification) ? specification : [specification];
  for (const entry of entries) {
    const parsed = priceSpecificationSchema.safeParse(entry);
    if (!parsed.success || parsed.data.priceType === null) continue;
    if (parsed.data.priceType.toLowerCase().endsWith("strikethroughprice")) {
      return parseCents(parsed.data.price);
    }
  }
  return null;
}

/** The first OfferShippingDetails' rate, or null when the offer states none. */
function readShippingCents(details: unknown): number | null {
  const first: unknown = Array.isArray(details) ? details[0] : details;
  const parsed = shippingDetailsSchema.safeParse(first);
  if (!parsed.success || parsed.data.shippingRate === null) return null;
  return parseCents(parsed.data.shippingRate.value);
}

const EMPTY_OFFER: ProductOffer = {
  name: null,
  brand: null,
  sku: null,
  gtin: null,
  mpn: null,
  model: null,
  priceCents: null,
  currency: null,
  strikethroughCents: null,
  shippingCents: null,
  availability: "unknown",
  condition: "unknown",
};

/**
 * Reads the fields DealZ cares about from a schema.org Product node.
 * Never throws on shape: anything missing or malformed becomes null, and an
 * unreadable availability becomes "unknown".
 */
export function readProductOffer(product: unknown): ProductOffer {
  const parsedProduct = productSchema.safeParse(product);
  if (!parsedProduct.success) return { ...EMPTY_OFFER };
  const p = parsedProduct.data;

  const rawGtin = p.gtin14 ?? p.gtin13 ?? p.gtin12 ?? p.gtin8 ?? p.gtin;
  const gtin = rawGtin === null ? null : normaliseGtin(rawGtin);

  const rawOffer: unknown = Array.isArray(p.offers) ? p.offers[0] : p.offers;
  const parsedOffer = offerSchema.safeParse(rawOffer);
  if (!parsedOffer.success) {
    return {
      ...EMPTY_OFFER,
      name: p.name,
      brand: p.brand,
      sku: p.sku,
      gtin,
      mpn: p.mpn,
      model: p.model,
    };
  }
  const offer = parsedOffer.data;

  const isAggregate = typesOf(rawOffer).includes("AggregateOffer");
  const price = isAggregate ? offer.lowPrice : offer.price;

  return {
    name: p.name,
    brand: p.brand,
    sku: p.sku,
    gtin,
    mpn: p.mpn,
    model: p.model,
    priceCents: parseCents(price),
    currency: offer.priceCurrency === null ? null : offer.priceCurrency.toUpperCase(),
    strikethroughCents: readStrikethroughCents(offer.priceSpecification),
    shippingCents: readShippingCents(offer.shippingDetails),
    availability: readAvailability(offer.availability),
    condition: readCondition(offer.itemCondition),
  };
}

/**
 * The first Product in a page and the offer read from it, or null when the
 * page carries no Product node. The three steps above in one call, for
 * sources that read whole pages.
 */
export function offerFromHtml(html: string): { product: unknown; offer: ProductOffer } | null {
  const product = findProduct(extractJsonLd(html));
  if (product === null) return null;
  return { product, offer: readProductOffer(product) };
}
