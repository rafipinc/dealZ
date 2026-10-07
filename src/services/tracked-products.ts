// Hand-maintained stand-in for the product, variant, retailer and listing
// tables until the catalog and listings services exist (STATUS.md, phase 1).
// One entry per variant we watch, with the retailer pages known to sell it.
//
// Retailer facts here come from docs/research/2026-09-28-s85h-live-fetch.md
// and docs/research/2026-09-28-serpapi-and-wayback.md.
// A retailer with `source: null` is one we do not fetch live: its site
// answers automated requests with a bot challenge and DealZ does not work
// around that (ARCHITECTURE.md section 9). Search and archive sources still
// cover it: Google Shopping reads its feed and the Wayback Machine may hold
// a capture.

import { z } from "zod";
import { canonicaliseUrl } from "@/lib/url";
import type { PageSourceMethod } from "@/sources";
import { ValidationError } from "./errors";

export interface TrackedRetailerPage {
  retailerSlug: string;
  retailerName: string;
  /** Other names an aggregator may print for this seller, lower-case. */
  aliases: string[];
  url: string;
  /** Which page source can read this page live, or null with a reason when none can. */
  source: PageSourceMethod | null;
  note: string | null;
}

export interface TrackedSearch {
  method: "serpapi_google_shopping";
  query: string;
}

export interface TrackedVariant {
  slug: string;
  displayName: string;
  brand: string;
  series: string;
  releaseYear: number;
  size: string;
  region: string;
  mpn: string;
  /** 14-digit GTIN. */
  gtin: string;
  /** Manufacturer's list price in cents, from the brand's own store. */
  rrpCents: number;
  /** ISO date the product went on sale; archive lookups start here. */
  onSaleFrom: string;
  pages: TrackedRetailerPage[];
  /** At least one, so the search panel always has a query. */
  searches: [TrackedSearch, ...TrackedSearch[]];
}

/** A Shopify storefront whose predictive search answers scripted requests (ADR-0016 item 2). */
export interface SearchableStorefront {
  retailerSlug: string;
  retailerName: string;
  /** The storefront origin, e.g. https://www.jbhifi.com.au */
  origin: string;
  note: string | null;
}

// Bing Lee is a Shopify store too, but DataDome answers its search with a
// challenge page, the same as its product pages, so it is absent: a
// bot-protected store is not searched (ADR-0012 item 5).
export const searchableStorefronts: readonly SearchableStorefront[] = [
  {
    retailerSlug: "jb-hi-fi",
    retailerName: "JB Hi-Fi",
    origin: "https://www.jbhifi.com.au",
    note: "Predictive search answers a title or GTIN query; titles carry no model code (research note 2026-10-06).",
  },
  {
    retailerSlug: "powerland",
    retailerName: "Powerland",
    origin: "https://powerland.com.au",
    note: "Titles end with the model code.",
  },
];

/** A storefront collection the catalogue index pulls on refresh (ADR-0017 item 2). */
export interface SeededCollection {
  retailerSlug: string;
  retailerName: string;
  /** The storefront origin, e.g. https://powerland.com.au */
  origin: string;
  /** The collection handle, e.g. "televisions". */
  collection: string;
  note: string | null;
}

export const seededCollections: readonly SeededCollection[] = [
  {
    retailerSlug: "powerland",
    retailerName: "Powerland",
    origin: "https://powerland.com.au",
    collection: "televisions",
    note: "Decided by Rafi on 2026-10-06: Powerland's TV collection is pulled; JB Hi-Fi is learned from use until its terms are read (ADR-0017).",
  },
];

export const trackedVariants: readonly TrackedVariant[] = [
  {
    slug: "samsung-s85h-65-au",
    displayName: 'Samsung 65" OLED S85H 4K Smart AI TV (2026)',
    brand: "Samsung",
    series: "S85H",
    releaseYear: 2026,
    size: "65",
    region: "AU",
    mpn: "QA65S85HAEXXY",
    gtin: "08806097962670",
    rrpCents: 329900,
    onSaleFrom: "2026-04-01",
    searches: [{ method: "serpapi_google_shopping", query: "Samsung QA65S85HAEXXY" }],
    pages: [
      {
        retailerSlug: "jb-hi-fi",
        aliases: ["jb hi-fi", "jb hifi", "jbhifi"],
        retailerName: "JB Hi-Fi",
        url: "https://www.jbhifi.com.au/products/samsung-65-s85h-oled-4k-smart-ai-tv-2026",
        source: "shopify_json",
        note: null,
      },
      {
        retailerSlug: "the-good-guys",
        aliases: ["the good guys", "good guys", "thegoodguys"],
        retailerName: "The Good Guys",
        url: "https://www.thegoodguys.com.au/samsung-65-inches-oled-s85h-4k-smart-ai-tv-2026-qa65s85haexxy",
        source: "json_ld",
        note: null,
      },
      {
        retailerSlug: "samsung-au",
        aliases: ["samsung", "samsung australia", "samsung au"],
        retailerName: "Samsung AU",
        url: "https://www.samsung.com/au/tvs/oled-tv/s85h-65-inch-oled-4k-smart-tv-qa65s85haexxy/",
        source: "json_ld",
        note: "Manufacturer's store. Its list price is the RRP reference.",
      },
      {
        retailerSlug: "powerland",
        aliases: ["powerland", "powerland appliances"],
        retailerName: "Powerland",
        url: "https://powerland.com.au/products/samsung-65-s85h-4k-vision-ai-oled-smart-tv-qa65s85haexxy",
        source: "json_ld",
        note: "Independent Shopify store found through Google Shopping on 2026-09-28.",
      },
      {
        retailerSlug: "toptek",
        aliases: ["toptek"],
        retailerName: "Toptek",
        url: "https://toptek.com.au/product/samsung-65-oled-s85h-4k-tv-qa65s85haexxy/",
        source: "json_ld",
        note: "Independent WooCommerce store. Listed out of stock on 2026-09-28.",
      },
      {
        retailerSlug: "harvey-norman",
        aliases: ["harvey norman", "harveynorman", "harvey norman australia"],
        retailerName: "Harvey Norman",
        url: "https://www.harveynorman.com.au/samsung-65-inch-s85h-ai-4k-oled-smart-tv.html",
        source: null,
        note: "Imperva bot challenge answers automated requests. Not fetched.",
      },
      {
        retailerSlug: "bing-lee",
        aliases: ["bing lee", "binglee", "bing lee electrics"],
        retailerName: "Bing Lee",
        url: "https://www.binglee.com.au/products/65-oled-s85h-4k-smart-ai-tv-2026-qa65s85haexxy",
        source: null,
        note: "DataDome returns 403 to automated requests. Not fetched.",
      },
    ],
  },
];

// ---------- Matching a found product to a tracked variant ----------

/** Which identifier tied a found product to a tracked variant, in trust order (ADR-0004). */
export type MatchedBy = "gtin" | "mpn" | "url";

export interface TrackedMatch {
  /** The tracked variant this product already is, or null for a new product. */
  trackedVariantSlug: string | null;
  matchedBy: MatchedBy | null;
}

/** What a found product offers for matching: its page and whatever identifiers it carried. */
export interface Identified {
  url: string;
  identifiers: { gtin: string | null; mpn: string | null; retailerSku: string | null };
}

// A candidate or a quote passes whole; only the page and the identifiers are read.
const identifiedSchema = z.object({
  url: z.string(),
  identifiers: z.object({
    gtin: z.string().nullable(),
    mpn: z.string().nullable(),
    retailerSku: z.string().nullable(),
  }),
});

function normaliseCode(value: string | null): string | null {
  return value === null ? null : value.trim().toUpperCase();
}

/** The tracked variant's page URLs, canonicalised the way a candidate's is. */
function trackedUrlsOf(variant: TrackedVariant): string[] {
  return variant.pages.map((page) => canonicaliseUrl(page.url));
}

/**
 * The tracked variant a found product already is, by GTIN first, then model
 * code (the MPN, or a retailer SKU that is the model code), then page URL.
 * Null for a product the tracked table does not hold. Shared by the
 * discovery and catalogue-index services so "held" means one thing. Throws
 * ValidationError for a product without a URL or identifiers.
 */
export function matchTrackedVariant(input: Identified): TrackedMatch {
  const parsed = identifiedSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Invalid matchTrackedVariant input", parsed.error.issues);
  }
  const found = parsed.data;
  const mpn = normaliseCode(found.identifiers.mpn);
  const sku = normaliseCode(found.identifiers.retailerSku);
  for (const variant of trackedVariants) {
    if (found.identifiers.gtin !== null && found.identifiers.gtin === variant.gtin) {
      return { trackedVariantSlug: variant.slug, matchedBy: "gtin" };
    }
    const target = normaliseCode(variant.mpn);
    if (mpn === target || sku === target) {
      return { trackedVariantSlug: variant.slug, matchedBy: "mpn" };
    }
    if (trackedUrlsOf(variant).includes(found.url)) {
      return { trackedVariantSlug: variant.slug, matchedBy: "url" };
    }
  }
  return { trackedVariantSlug: null, matchedBy: null };
}
