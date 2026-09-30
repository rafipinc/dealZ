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

import type { PageSourceMethod } from "@/sources";

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
