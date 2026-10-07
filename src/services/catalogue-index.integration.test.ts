// The catalogue-index service against the real schema in PGlite: rows
// written through the real listing source, then found by title, model code
// and GTIN, grouped into products; and discovery remembering what it
// finds, best effort.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/db/test-db";
import { normaliseGtin } from "@/lib/gtin";
import type { FetchLike, PriceQuote, ProductCandidate } from "@/sources";
import {
  indexStatus,
  refreshIndex,
  remember,
  rememberInspect,
  searchIndex,
} from "./catalogue-index";
import { discoverProducts, findProducts, inspectCandidate, type CountOkCalls } from "./discovery";

// The real recorder writes to the application database; the tests inject their own.
vi.mock("./usage", () => ({
  record: vi.fn(async () => undefined),
}));

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
});

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await t.truncate("catalogue_candidate");
});

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../sources/fixtures/${name}`, import.meta.url)),
    "utf8",
  );
}

const televisions = fixture("powerland-collection-televisions.json");
const jbLgC5 = fixture("jbhifi-suggest-lg-c5-65.json");
const powerlandLgC5 = fixture("powerland-suggest-lg-c5-65.json");
const jbS85hProduct = fixture("jbhifi-s85h-65.shopify.json");

const JB_ORIGIN = "https://www.jbhifi.com.au";
const POWERLAND_ORIGIN = "https://powerland.com.au";
const FIXED_NOW = new Date("2026-10-06T01:02:03.000Z");
const QN80H_65 = "QA65QN80HAWXXY";
const M70H_65 = "UA65M70HAWXXY";

type Responder = (url: string) => Response;

function json(body: string): Responder {
  return () => new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}

/** Routes by origin; a request to any other host is a test error. */
function fakeFetchByOrigin(routes: Record<string, Responder>): FetchLike {
  return async (url) => {
    const route = routes[new URL(url).origin];
    if (route === undefined) throw new Error(`Unexpected request to ${url}`);
    return route(url);
  };
}

const recordUsage = async () => undefined;

/** Pulls the six Powerland fixture products through the real listing source. */
async function seedPowerland() {
  return refreshIndex({
    fetch: fakeFetchByOrigin({ [POWERLAND_ORIGIN]: json(televisions) }),
    now: () => FIXED_NOW,
    recordUsage,
    db: t.db,
  });
}

const all = () =>
  t.db.query.catalogueCandidate.findMany({ orderBy: (c, { asc }) => asc(c.handle) });

describe("refreshIndex then searchIndex", () => {
  it("writes the Powerland collection and reports it in the status", async () => {
    const report = await seedPowerland();

    expect(report.collections).toEqual([
      {
        retailerSlug: "powerland",
        retailerName: "Powerland",
        collection: "televisions",
        status: "ok",
        found: 6,
        written: 6,
        removed: 0,
      },
    ]);
    expect(report.usage).toEqual({ calls: 1, recorded: 1 });
    const rows = await all();
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.source === "listing" && r.gtin === null)).toBe(true);

    const status = await indexStatus({ db: t.db });
    expect(status.total).toBe(6);
    expect(status.stores).toHaveLength(1);
    expect(status.stores[0]).toMatchObject({
      retailerSlug: "powerland",
      retailerName: "Powerland",
      count: 6,
    });
    expect(status.stores[0].lastSeenAt).toBeInstanceOf(Date);
  });

  it("drops a product the store no longer lists on the next refresh and keeps a search row", async () => {
    await seedPowerland();
    const [dropped, ...kept] = JSON.parse(televisions).products as { handle: string }[];
    const fromSearch: ProductCandidate = {
      retailerSlug: "powerland",
      retailerName: "Powerland",
      method: "storefront_search",
      fetchedAt: FIXED_NOW,
      title: "LG 65 inch C5 OLED evo 4K Smart TV OLED65C5PSA",
      brand: "LG",
      storeType: null,
      url: `${POWERLAND_ORIGIN}/products/lg-65-c5`,
      handle: "lg-65-c5",
      priceCents: 329900,
      currency: "AUD",
      strikethroughCents: null,
      availability: "in_stock",
      imageUrl: null,
      identifiers: { gtin: null, mpn: "OLED65C5PSA", retailerSku: null },
      provenance: { kind: "search", via: null },
      raw: {},
    };
    await remember({ candidates: [fromSearch], source: "search", db: t.db });
    // No pause: the cut is the database's clock, the same one that stamped
    // last_seen_at, read in a later statement, so it is past every row above.

    const report = await refreshIndex({
      fetch: fakeFetchByOrigin({
        [POWERLAND_ORIGIN]: json(JSON.stringify({ products: kept })),
      }),
      recordUsage,
      db: t.db,
    });

    expect(report.collections[0]).toMatchObject({
      status: "ok",
      found: 5,
      written: 5,
      removed: 1,
    });
    const rows = await all();
    expect(rows).toHaveLength(6);
    expect(rows.find((r) => r.handle === dropped.handle)).toBeUndefined();
    expect(rows.find((r) => r.handle === "lg-65-c5")).toMatchObject({ source: "search" });
    expect(rows.filter((r) => r.source === "listing")).toHaveLength(5);
  });

  it("keeps every row when the collection lists no products, and reports the pull as failed", async () => {
    await seedPowerland();

    const report = await refreshIndex({
      fetch: fakeFetchByOrigin({ [POWERLAND_ORIGIN]: json(JSON.stringify({ products: [] })) }),
      recordUsage,
      db: t.db,
    });

    expect(report.collections[0]).toMatchObject({
      status: "failed",
      kind: "unparseable",
      message: "The collection returned no products; nothing was removed",
    });
    expect(await all()).toHaveLength(6);
  });

  it("finds the two 65 inch Samsungs for 'samsung 65', as two products, ahead of the other sizes", async () => {
    await seedPowerland();
    const report = await searchIndex({ query: "samsung 65", db: t.db });

    expect(report.queryKind).toBe("text");
    // Four Samsungs carry the word; the two 65s carry both words.
    expect(report.total).toBe(4);
    const [first, second] = report.products;
    expect([first.mpn, second.mpn].sort()).toEqual([QN80H_65, M70H_65].sort());
    expect(first.relevance.tier).toBe("match");
    expect(second.relevance.tier).toBe("match");
    expect(first.key).not.toBe(second.key);
    expect(report.products.slice(2).every((p) => p.relevance.tier === "partial")).toBe(true);
    expect(first.offers).toHaveLength(1);
    expect(first.offers[0]).toMatchObject({
      retailerSlug: "powerland",
      retailerName: "Powerland",
      source: "listing",
      available: true,
    });
    expect(first.cheapest?.retailerSlug).toBe("powerland");
    expect(first.trackedVariantSlug).toBeNull();
  });

  it("finds a product by its model code", async () => {
    await seedPowerland();
    const report = await searchIndex({ query: QN80H_65, db: t.db });

    expect(report.total).toBe(1);
    expect(report.products[0]).toMatchObject({
      key: `mpn:${QN80H_65}`,
      mpn: QN80H_65,
      title: 'Samsung 65" QN80H 4K Vision AI UHD Neo QLED Smart TV QA65QN80HAWXXY',
      brand: "Samsung",
      cheapest: { retailerSlug: "powerland", priceCents: 181900 },
    });
    expect(report.products[0].offers[0].compareAtCents).toBe(219900);
  });

  it("finds a product by GTIN once an identifier read wrote one, and keeps the listing's image", async () => {
    await seedPowerland();
    const [listed] = (await all()).filter((r) => r.mpn === QN80H_65);
    const gtin = normaliseGtin("4006381333931");
    if (gtin === null) throw new Error("fixture GTIN must be valid");

    const quote: PriceQuote = {
      retailerSlug: "powerland",
      retailerName: "Powerland",
      url: listed.canonicalUrl,
      method: "shopify_json",
      fetchedAt: FIXED_NOW,
      observedAt: FIXED_NOW,
      title: listed.title,
      priceCents: 179900,
      currency: "AUD",
      strikethroughCents: 219900,
      shippingCents: null,
      availability: "in_stock",
      condition: "new",
      identifiers: { gtin, mpn: null, retailerSku: QN80H_65 },
      provenance: { kind: "live", via: null },
      confidence: 1,
      evidence: null,
      raw: { handle: listed.handle, vendor: "Samsung", product_type: "4K QLED UHD" },
    };
    expect(await rememberInspect({ quote, db: t.db })).toEqual({ written: 1 });

    const rows = await all();
    expect(rows).toHaveLength(6);
    const inspected = rows.find((r) => r.handle === listed.handle);
    expect(inspected).toMatchObject({
      id: listed.id,
      gtin,
      source: "inspect",
      priceCents: 179900,
      imageUrl: listed.imageUrl,
      mpn: QN80H_65,
    });

    const byGtin = await searchIndex({ query: "4006381333931", db: t.db });
    expect(byGtin).toMatchObject({ queryKind: "gtin", gtin, total: 1 });
    expect(byGtin.products[0]).toMatchObject({
      key: `gtin:${gtin}`,
      gtin,
      mpn: QN80H_65,
      relevance: { tier: "match", reason: "the index matched the barcode" },
      cheapest: { retailerSlug: "powerland", priceCents: 179900 },
    });

    // A later search row without the GTIN does not erase it (ADR-0017 item 5).
    const fromSearch: ProductCandidate = {
      retailerSlug: "powerland",
      retailerName: "Powerland",
      method: "storefront_search",
      fetchedAt: FIXED_NOW,
      title: listed.title,
      brand: "Samsung",
      storeType: null,
      url: listed.canonicalUrl,
      handle: listed.handle,
      priceCents: 185000,
      currency: "AUD",
      strikethroughCents: null,
      availability: "unknown",
      imageUrl: null,
      identifiers: { gtin: null, mpn: null, retailerSku: null },
      provenance: { kind: "search", via: null },
      raw: {},
    };
    await remember({ candidates: [fromSearch], source: "search", db: t.db });
    const again = (await all()).find((r) => r.handle === listed.handle);
    expect(again).toMatchObject({
      gtin,
      mpn: QN80H_65,
      imageUrl: listed.imageUrl,
      priceCents: 185000,
      available: null,
      source: "search",
    });
  });

  it("finds nothing for a query no title answers", async () => {
    await seedPowerland();
    const report = await searchIndex({ query: "xbox series s", db: t.db });
    expect(report).toMatchObject({ products: [], total: 0 });
  });

  it("reports an empty index as empty", async () => {
    expect(await indexStatus({ db: t.db })).toEqual({ total: 0, stores: [] });
  });
});

describe("discovery remembering what it finds", () => {
  it("findProducts writes every candidate the stores returned, source search, and reports the count", async () => {
    const report = await findProducts({
      query: "LG C5 65",
      fetch: fakeFetchByOrigin({
        [JB_ORIGIN]: json(jbLgC5),
        [POWERLAND_ORIGIN]: json(powerlandLgC5),
      }),
      now: () => FIXED_NOW,
      recordUsage,
      rememberCandidates: (input) => remember({ ...input, db: t.db }),
    });

    expect(report.total).toBe(7);
    expect(report.remembered).toBe(7);
    const rows = await all();
    expect(rows).toHaveLength(7);
    expect(rows.every((r) => r.source === "search")).toBe(true);
    expect(rows.map((r) => r.retailerSlug).sort()).toEqual([
      "jb-hi-fi",
      "jb-hi-fi",
      "jb-hi-fi",
      "jb-hi-fi",
      "powerland",
      "powerland",
      "powerland",
    ]);

    // What a live search wrote, the dropdown finds, grouped by model code.
    const found = await searchIndex({ query: "LG 65 B6", db: t.db });
    expect(found.products[0]).toMatchObject({ relevance: { tier: "match" } });
    expect(found.products[0].offers.length).toBeGreaterThanOrEqual(1);
  });

  it("findProducts still answers, with remembered 0, when the index cannot be written", async () => {
    const closed = await createTestDb();
    await closed.close();
    const report = await findProducts({
      query: "LG C5 65",
      fetch: fakeFetchByOrigin({
        [JB_ORIGIN]: json(jbLgC5),
        [POWERLAND_ORIGIN]: json(powerlandLgC5),
      }),
      now: () => FIXED_NOW,
      recordUsage,
      rememberCandidates: (input) => remember({ ...input, db: closed.db }),
    });
    expect(report.total).toBe(7);
    expect(report.remembered).toBe(0);
    expect(report.stores.every((store) => store.status === "ok")).toBe(true);
    expect(await all()).toEqual([]);
  });

  it("inspectCandidate writes the inspected product with its GTIN, source inspect", async () => {
    const url = `${JB_ORIGIN}/products/samsung-65-s85h-oled-4k-smart-ai-tv-2026`;
    const report = await inspectCandidate({
      retailerSlug: "jb-hi-fi",
      url,
      fetch: fakeFetchByOrigin({ [JB_ORIGIN]: json(jbS85hProduct) }),
      now: () => FIXED_NOW,
      recordUsage,
      rememberInspected: (input) => rememberInspect({ ...input, db: t.db }),
    });

    expect(report.outcome.status).toBe("ok");
    expect(report.remembered).toBe(1);
    const [row] = await all();
    expect(row).toMatchObject({
      retailerSlug: "jb-hi-fi",
      handle: "samsung-65-s85h-oled-4k-smart-ai-tv-2026",
      canonicalUrl: url,
      gtin: "08806097962670",
      retailerSku: "902825",
      brand: "SAMSUNG",
      storeType: "VISUAL",
      priceCents: 279500,
      source: "inspect",
    });

    const found = await searchIndex({ query: "8806097962670", db: t.db });
    expect(found.products).toHaveLength(1);
    expect(found.products[0]).toMatchObject({
      trackedVariantSlug: "samsung-s85h-65-au",
      matchedBy: "gtin",
    });
  });
});

describe("discoverProducts merging the sources in the index", () => {
  const SERPAPI_ORIGIN = "https://serpapi.com";

  /** A ledger with no SerpApi search today, only the free account call. */
  const noSerpApiToday: CountOkCalls = async () => [{ operation: "account", count: 1 }];

  /** A Powerland search answer and a Google Shopping answer naming the same model code. */
  const powerlandS85h = JSON.stringify({
    resources: {
      results: {
        products: [
          {
            title: 'Samsung 65" S85H 4K Vision AI OLED Smart TV QA65S85HAEXXY',
            vendor: "Samsung",
            handle: "samsung-65-s85h",
            url: "/products/samsung-65-s85h",
            price: "2888.00",
            available: true,
          },
        ],
      },
    },
  });
  const googleS85h = JSON.stringify({
    shopping_results: [
      {
        position: 1,
        title: "Samsung 65 inch OLED S85H 4K Smart AI TV 2026 QA65S85HAEXXY",
        product_id: "1202807262352129590",
        product_link: "https://www.google.com.au/shopping/product/1202807262352129590?gl=au",
        source: "The Good Guys",
        price: "$2,795.00",
        extracted_price: 2795,
        thumbnail: "https://serpapi.com/thumb.png",
      },
      {
        position: 2,
        title: "Samsung 77 inch OLED S85H QA77S85HAEXXY",
        product_id: "99",
        product_link: "https://www.google.com.au/shopping/product/99?gl=au",
        source: "Some Seller",
        extracted_price: 4999,
      },
    ],
  });

  it("returns a storefront row and a Google Shopping row with one model code as one product with two offers", async () => {
    vi.stubEnv("SERPAPI_DAILY_CAP", "");
    try {
      const report = await discoverProducts({
        query: "Samsung S85H",
        serpApiKey: "sk-test-0123456789abcdef",
        fetch: fakeFetchByOrigin({
          [JB_ORIGIN]: json(JSON.stringify({ resources: { results: { products: [] } } })),
          [POWERLAND_ORIGIN]: json(powerlandS85h),
          [SERPAPI_ORIGIN]: json(googleS85h),
        }),
        now: () => FIXED_NOW,
        recordUsage,
        countOkCalls: noSerpApiToday,
        db: t.db,
      });

      expect(report.source).toBe("fanout");
      expect(report.googleShopping).toMatchObject({ status: "ok", found: 2 });
      expect(report.found).toBe(3);
      expect(report.remembered).toBe(3);
      expect(report.budget).toEqual({ cap: 20, capSource: "default", usedToday: 0, remaining: 20 });

      const rows = await all();
      expect(rows.map((r) => [r.retailerSlug, r.handle, r.source])).toEqual([
        ["the-good-guys", "1202807262352129590", "search"],
        ["some-seller", "99", "search"],
        ["powerland", "samsung-65-s85h", "search"],
      ]);

      // Both rows carry QA65S85HAEXXY: one product, two offers, cheapest first, and held.
      expect(report.total).toBe(2);
      const product = report.products.find((p) => p.key === "mpn:QA65S85HAEXXY");
      const other = report.products.find((p) => p.key === "mpn:QA77S85HAEXXY");
      if (product === undefined || other === undefined) throw new Error("expected both products");
      expect(product.mpn).toBe("QA65S85HAEXXY");
      expect(product.imageUrl).toBe("https://serpapi.com/thumb.png");
      expect(product.trackedVariantSlug).toBe("samsung-s85h-65-au");
      expect(product.offers.map((o) => [o.retailerName, o.priceCents, o.via])).toEqual([
        ["The Good Guys", 279500, "google_shopping"],
        ["Powerland", 288800, "storefront"],
      ]);
      expect(other.offers.map((o) => [o.retailerName, o.via])).toEqual([
        ["Some Seller", "google_shopping"],
      ]);

      // Now the index holds two S85H products, below the bar, so a second Enter still fans out;
      // a model-code query it holds answers on its own.
      const again = await discoverProducts({
        query: "QA65S85HAEXXY",
        serpApiKey: "sk-test-0123456789abcdef",
        fetch: fakeFetchByOrigin({}),
        now: () => FIXED_NOW,
        recordUsage,
        countOkCalls: noSerpApiToday,
        db: t.db,
      });
      expect(again.source).toBe("fanout");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
