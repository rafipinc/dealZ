// The catalogue-index service with the query helpers replaced: the mapping
// of candidates and quotes to rows, the refresh, and the search's judging,
// grouping and routing. The real rows are in catalogue-index.integration.test.ts.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  countCatalogueCandidates,
  databaseNow,
  searchCatalogueCandidates,
  upsertCatalogueCandidates,
  type CatalogueCandidateInsert,
  type CatalogueCandidateRow,
} from "@/db/queries/catalogue-candidates";
import type { QueryDb } from "@/db/queries/db";
import type { FetchLike, PriceQuote, ProductCandidate } from "@/sources";
import {
  CANDIDATE_ROWS,
  DEFAULT_SEARCH_LIMIT,
  indexStatus,
  MAX_SEARCH_LIMIT,
  refreshIndex,
  remember,
  rememberInspect,
  searchIndex,
  type DatabaseNow,
  type DeleteUnseenListingRows,
} from "./catalogue-index";
import { defaultDb } from "./default-db";
import { NotFoundError, ValidationError } from "./errors";

// The helpers reach a database; here they record what they were asked.
vi.mock("@/db/queries/catalogue-candidates", () => ({
  upsertCatalogueCandidates: vi.fn(async (_db: unknown, rows: unknown[]) => rows.length),
  searchCatalogueCandidates: vi.fn(async () => []),
  countCatalogueCandidates: vi.fn(async () => ({ total: 0, byRetailer: [] })),
  deleteUnseenListingRows: vi.fn(async () => 0),
  // The database's clock, a different instant from the application's so a test can tell them apart.
  databaseNow: vi.fn(async () => new Date("2026-10-06T01:02:00.500Z")),
}));
// The application database is never opened here.
vi.mock("./default-db", () => ({ defaultDb: vi.fn(async () => ({ name: "application db" })) }));
// The real recorder writes to the application database.
vi.mock("./usage", () => ({ record: vi.fn(async () => undefined) }));

const upsert = vi.mocked(upsertCatalogueCandidates);
const search = vi.mocked(searchCatalogueCandidates);
const count = vi.mocked(countCatalogueCandidates);
const clock = vi.mocked(databaseNow);

const db = { name: "injected db" } as unknown as QueryDb;
const FIXED_NOW = new Date("2026-10-06T01:02:03.000Z");
/** What the mocked databaseNow answers: behind the application clock, as a skewed host would be. */
const DB_NOW = new Date("2026-10-06T01:02:00.500Z");
const POWERLAND_ORIGIN = "https://powerland.com.au";

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../sources/fixtures/${name}`, import.meta.url)),
    "utf8",
  );
}

function candidate(overrides: Partial<ProductCandidate> = {}): ProductCandidate {
  return {
    retailerSlug: "powerland",
    retailerName: "Powerland",
    method: "storefront_search",
    fetchedAt: FIXED_NOW,
    title: 'Samsung 65" QN80H 4K Vision AI UHD Neo QLED Smart TV QA65QN80HAWXXY',
    brand: "Samsung",
    storeType: "4K QLED UHD",
    url: `${POWERLAND_ORIGIN}/products/samsung-65-qn80h`,
    handle: "samsung-65-qn80h",
    priceCents: 181900,
    currency: "AUD",
    strikethroughCents: 219900,
    availability: "in_stock",
    imageUrl: "https://cdn.example/qn80h.jpg",
    identifiers: { gtin: null, mpn: "QA65QN80HAWXXY", retailerSku: "QA65QN80HAWXXY" },
    provenance: { kind: "search", via: null },
    raw: { id: 1 },
    ...overrides,
  };
}

function quote(overrides: Partial<PriceQuote> = {}): PriceQuote {
  return {
    retailerSlug: "jb-hi-fi",
    retailerName: "JB Hi-Fi",
    url: "https://www.jbhifi.com.au/products/samsung-65-s85h-oled-4k-smart-ai-tv-2026",
    method: "shopify_json",
    fetchedAt: FIXED_NOW,
    observedAt: FIXED_NOW,
    title: 'Samsung 65" OLED S85H 4K Smart AI TV [2026]',
    priceCents: 279500,
    currency: "AUD",
    strikethroughCents: null,
    shippingCents: null,
    availability: "in_stock",
    condition: "new",
    identifiers: { gtin: "08806097962670", mpn: null, retailerSku: "902825" },
    provenance: { kind: "live", via: null },
    confidence: 1,
    evidence: null,
    raw: { vendor: "SAMSUNG", product_type: "VISUAL", handle: "from-raw" },
    ...overrides,
  };
}

function row(overrides: Partial<CatalogueCandidateRow> = {}): CatalogueCandidateRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    retailerSlug: "powerland",
    handle: "samsung-65-qn80h",
    canonicalUrl: `${POWERLAND_ORIGIN}/products/samsung-65-qn80h`,
    title: 'Samsung 65" QN80H 4K Vision AI UHD Neo QLED Smart TV QA65QN80HAWXXY',
    brand: "Samsung",
    storeType: "4K QLED UHD",
    mpn: "QA65QN80HAWXXY",
    gtin: null,
    retailerSku: "QA65QN80HAWXXY",
    priceCents: 181900,
    compareAtCents: 219900,
    currency: "AUD",
    available: true,
    imageUrl: "https://cdn.example/qn80h.jpg",
    source: "listing",
    raw: {},
    firstSeenAt: FIXED_NOW,
    lastSeenAt: FIXED_NOW,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

/** The rows the last upsert was asked to write. */
function writtenRows(): CatalogueCandidateInsert[] {
  const call = upsert.mock.calls.at(-1);
  if (call === undefined) throw new Error("upsert was not called");
  return call[1];
}

beforeEach(() => {
  upsert.mockClear();
  search.mockClear();
  count.mockClear();
  clock.mockClear();
  search.mockResolvedValue([]);
  count.mockResolvedValue({ total: 0, byRetailer: [] });
  vi.mocked(defaultDb).mockClear();
});

describe("remember", () => {
  it("maps each candidate to a row, stock flag and compare-at price included, and returns the count", async () => {
    const result = await remember({
      candidates: [
        candidate(),
        candidate({ handle: "out", availability: "out_of_stock", strikethroughCents: null }),
        candidate({ handle: "unknown", availability: "unknown", priceCents: null }),
      ],
      source: "search",
      db,
    });

    expect(result).toEqual({ written: 3 });
    expect(upsert).toHaveBeenCalledWith(db, expect.any(Array));
    const [first, out, unknown] = writtenRows();
    expect(first).toEqual({
      retailerSlug: "powerland",
      handle: "samsung-65-qn80h",
      canonicalUrl: `${POWERLAND_ORIGIN}/products/samsung-65-qn80h`,
      title: 'Samsung 65" QN80H 4K Vision AI UHD Neo QLED Smart TV QA65QN80HAWXXY',
      brand: "Samsung",
      storeType: "4K QLED UHD",
      mpn: "QA65QN80HAWXXY",
      gtin: null,
      retailerSku: "QA65QN80HAWXXY",
      priceCents: 181900,
      compareAtCents: 219900,
      currency: "AUD",
      available: true,
      imageUrl: "https://cdn.example/qn80h.jpg",
      source: "search",
      raw: { id: 1 },
    });
    expect(out).toMatchObject({ handle: "out", available: false, compareAtCents: null });
    expect(unknown).toMatchObject({ handle: "unknown", available: null, priceCents: null });
  });

  it("stores a GTIN in its 14-digit form and drops one that is not a GTIN", async () => {
    await remember({
      candidates: [
        candidate({ identifiers: { gtin: "8806097962670", mpn: null, retailerSku: null } }),
        candidate({
          handle: "bad",
          identifiers: { gtin: "8806097962671", mpn: null, retailerSku: null },
        }),
      ],
      source: "inspect",
      db,
    });
    expect(writtenRows().map((r) => r.gtin)).toEqual(["08806097962670", null]);
  });

  it("skips a candidate without a handle and counts only the rows written", async () => {
    const result = await remember({
      candidates: [candidate({ handle: null }), candidate({ handle: "" }), candidate()],
      source: "search",
      db,
    });
    expect(result).toEqual({ written: 1 });
    expect(writtenRows()).toHaveLength(1);
  });

  it("writes the last sighting when one batch names a handle twice", async () => {
    await remember({
      candidates: [candidate({ priceCents: 1 }), candidate({ priceCents: 2 })],
      source: "listing",
      db,
    });
    expect(writtenRows().map((r) => r.priceCents)).toEqual([2]);
  });

  it("writes nothing for an empty batch", async () => {
    expect(await remember({ candidates: [], source: "listing", db })).toEqual({ written: 0 });
    expect(writtenRows()).toEqual([]);
  });

  it("uses the application database when none is injected", async () => {
    await remember({ candidates: [candidate()], source: "search" });
    expect(defaultDb).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0]).toEqual({ name: "application db" });
  });

  it("throws ValidationError for an unknown source", async () => {
    await expect(
      remember({ candidates: [candidate()], source: "crawl" as "listing", db }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("throws ValidationError for a retailer slug the table would refuse", async () => {
    await expect(
      remember({ candidates: [candidate({ retailerSlug: "JB HiFi" })], source: "search", db }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("propagates a database failure as it is", async () => {
    upsert.mockRejectedValueOnce(new Error("connection refused"));
    await expect(remember({ candidates: [candidate()], source: "search", db })).rejects.toThrow(
      "connection refused",
    );
  });
});

describe("rememberInspect", () => {
  it("writes the quote's GTIN, SKU and price with the handle, vendor and type the product JSON carries", async () => {
    expect(await rememberInspect({ quote: quote(), db })).toEqual({ written: 1 });
    expect(writtenRows()).toEqual([
      {
        retailerSlug: "jb-hi-fi",
        handle: "from-raw",
        canonicalUrl: "https://www.jbhifi.com.au/products/samsung-65-s85h-oled-4k-smart-ai-tv-2026",
        title: 'Samsung 65" OLED S85H 4K Smart AI TV [2026]',
        brand: "SAMSUNG",
        storeType: "VISUAL",
        mpn: null,
        gtin: "08806097962670",
        retailerSku: "902825",
        priceCents: 279500,
        compareAtCents: null,
        currency: "AUD",
        available: true,
        imageUrl: null,
        source: "inspect",
        raw: { vendor: "SAMSUNG", product_type: "VISUAL", handle: "from-raw" },
      },
    ]);
  });

  it("takes the handle from the page URL when the product JSON names none", async () => {
    await rememberInspect({ quote: quote({ raw: {} }), db });
    expect(writtenRows()[0]).toMatchObject({
      handle: "samsung-65-s85h-oled-4k-smart-ai-tv-2026",
      brand: null,
      storeType: null,
    });
  });

  it("fills the store fields from the candidate when the caller has it", async () => {
    await rememberInspect({
      quote: quote({ title: null, raw: {} }),
      candidate: candidate({ retailerSlug: "jb-hi-fi" }),
      db,
    });
    expect(writtenRows()[0]).toMatchObject({
      handle: "samsung-65-qn80h",
      title: 'Samsung 65" QN80H 4K Vision AI UHD Neo QLED Smart TV QA65QN80HAWXXY',
      brand: "Samsung",
      storeType: "4K QLED UHD",
      imageUrl: "https://cdn.example/qn80h.jpg",
      // The candidate's model code stands when the page carried none.
      mpn: "QA65QN80HAWXXY",
      gtin: "08806097962670",
    });
  });

  it("reads the model code from the title, else from a SKU that is one", async () => {
    await rememberInspect({
      quote: quote({ title: "Samsung 65 QN80H TV QA65QN80HAWXXY", raw: {} }),
      db,
    });
    // "QN80H" would pass the general rule (a known false positive), so the title carries no such token.
    await rememberInspect({
      quote: quote({
        title: "Samsung 65 inch Neo QLED TV",
        identifiers: { gtin: null, mpn: null, retailerSku: "QA65QN80HAWXXY" },
        raw: {},
      }),
      db,
    });
    await rememberInspect({ quote: quote({ title: "Samsung TV", raw: {} }), db });
    expect(upsert.mock.calls.map((call) => call[1][0].mpn)).toEqual([
      "QA65QN80HAWXXY",
      "QA65QN80HAWXXY",
      null,
    ]);
  });

  it("writes nothing when nothing names the product", async () => {
    expect(await rememberInspect({ quote: quote({ title: null, raw: {} }), db })).toEqual({
      written: 0,
    });
    expect(
      await rememberInspect({
        quote: quote({ url: "https://www.jbhifi.com.au/collections/tvs", raw: {} }),
        db,
      }),
    ).toEqual({ written: 0 });
    expect(upsert.mock.calls.every((call) => call[1].length === 0)).toBe(true);
  });

  it("throws ValidationError for a malformed quote", async () => {
    await expect(rememberInspect({ quote: quote({ priceCents: 1.5 }), db })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe("refreshIndex", () => {
  const televisions = fixture("powerland-collection-televisions.json");
  const bingLee = fixture("binglee-challenge.html");

  function fakeFetch(body: string, type: string, calls: string[] = []): FetchLike {
    return async (url) => {
      calls.push(url);
      return new Response(body, { status: 200, headers: { "content-type": type } });
    };
  }

  /** A delete that records what it was asked and answers `removed`, in the order of `events`. */
  function fakeDelete(removed: number, events: string[] = []): DeleteUnseenListingRows {
    return vi.fn(async () => {
      events.push("delete");
      return removed;
    });
  }

  it("pulls each seeded collection, remembers what it lists as listing rows and meters every page", async () => {
    const calls: string[] = [];
    const written: unknown[] = [];
    const report = await refreshIndex({
      fetch: fakeFetch(televisions, "application/json", calls),
      now: () => FIXED_NOW,
      recordUsage: async (entry) => void written.push(entry),
      deleteUnseen: fakeDelete(0),
      db,
    });

    // The database's clock, the one last_seen_at is stamped by, not the application's.
    expect(report.refreshedAt).toEqual(DB_NOW);
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
    expect(written[0]).toMatchObject({
      provider: "retailer",
      operation: "listing",
      outcome: "ok",
      retailerSlug: "powerland",
      variantSlug: null,
    });
    expect(calls).toEqual([
      `${POWERLAND_ORIGIN}/collections/televisions/products.json?limit=250&page=1`,
    ]);
    const rows = writtenRows();
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.source === "listing" && r.retailerSlug === "powerland")).toBe(true);
    expect(rows.find((r) => r.handle?.includes("qa65qn80hawxxy"))).toMatchObject({
      mpn: "QA65QN80HAWXXY",
      retailerSku: "QA65QN80HAWXXY",
      priceCents: 181900,
      compareAtCents: 219900,
      available: true,
      gtin: null,
    });
  });

  it("drops the store's listing rows last seen before the refresh began, once the pull is remembered", async () => {
    const events: string[] = [];
    upsert.mockImplementationOnce(async (_db, rows) => {
      events.push("upsert");
      return rows.length;
    });
    const deleteUnseen = fakeDelete(2, events);
    const report = await refreshIndex({
      fetch: fakeFetch(televisions, "application/json"),
      now: () => FIXED_NOW,
      recordUsage: async () => undefined,
      deleteUnseen,
      db,
    });

    expect(report.collections[0]).toMatchObject({ status: "ok", written: 6, removed: 2 });
    expect(deleteUnseen).toHaveBeenCalledTimes(1);
    expect(deleteUnseen).toHaveBeenCalledWith(db, {
      retailerSlug: "powerland",
      seenSince: DB_NOW,
    });
    expect(events).toEqual(["upsert", "delete"]);
  });

  it("takes the cut-off from the database clock, before any request, not from the application clock", async () => {
    const events: string[] = [];
    const dbTime = new Date("2026-10-06T00:59:59.123Z");
    const databaseNowStub = vi.fn(async (handle: QueryDb) => {
      events.push("clock");
      expect(handle).toBe(db);
      return dbTime;
    });
    const deleteUnseen = fakeDelete(0);
    const report = await refreshIndex({
      fetch: async (url) => {
        events.push("fetch");
        return fakeFetch(televisions, "application/json")(url);
      },
      now: () => FIXED_NOW,
      recordUsage: async () => undefined,
      deleteUnseen,
      databaseNow: databaseNowStub,
      db,
    });

    expect(databaseNowStub).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["clock", "fetch"]);
    expect(deleteUnseen).toHaveBeenCalledWith(db, { retailerSlug: "powerland", seenSince: dbTime });
    expect(report.refreshedAt).toBe(dbTime);
    expect(clock).not.toHaveBeenCalled();
  });

  it("propagates a database clock failure before any request is made", async () => {
    const calls: string[] = [];
    await expect(
      refreshIndex({
        fetch: fakeFetch(televisions, "application/json", calls),
        recordUsage: async () => undefined,
        databaseNow: async () => {
          throw new Error("connection refused");
        },
        db,
      }),
    ).rejects.toThrow("connection refused");
    expect(calls).toEqual([]);
  });

  it("removes nothing when a collection lists no products, and reports it as failed", async () => {
    const deleteUnseen = fakeDelete(9);
    const report = await refreshIndex({
      fetch: fakeFetch(JSON.stringify({ products: [] }), "application/json"),
      recordUsage: async () => undefined,
      deleteUnseen,
      db,
    });

    expect(deleteUnseen).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(report.collections).toEqual([
      {
        retailerSlug: "powerland",
        retailerName: "Powerland",
        collection: "televisions",
        status: "failed",
        kind: "unparseable",
        message: "The collection returned no products; nothing was removed",
      },
    ]);
    expect(report.usage).toEqual({ calls: 1, recorded: 1 });
  });

  it("drops nothing for a store whose pull failed", async () => {
    const deleteUnseen = fakeDelete(9);
    const report = await refreshIndex({
      fetch: fakeFetch(bingLee, "text/html"),
      recordUsage: async () => undefined,
      deleteUnseen,
      db,
    });
    expect(report.collections[0].status).toBe("failed");
    expect(deleteUnseen).not.toHaveBeenCalled();
  });

  it("drops nothing when the write failed", async () => {
    upsert.mockRejectedValueOnce(new Error("connection refused"));
    const deleteUnseen = fakeDelete(9);
    await expect(
      refreshIndex({
        fetch: fakeFetch(televisions, "application/json"),
        recordUsage: async () => undefined,
        deleteUnseen,
        db,
      }),
    ).rejects.toThrow("connection refused");
    expect(deleteUnseen).not.toHaveBeenCalled();
  });

  it("reports a store that cannot be read as a failed outcome, writing nothing", async () => {
    const report = await refreshIndex({
      fetch: fakeFetch(bingLee, "text/html"),
      now: () => FIXED_NOW,
      recordUsage: async () => undefined,
      db,
    });
    expect(report.collections).toEqual([
      {
        retailerSlug: "powerland",
        retailerName: "Powerland",
        collection: "televisions",
        status: "failed",
        kind: "blocked",
        message: expect.stringContaining("bot challenge"),
      },
    ]);
    expect(report.usage).toEqual({ calls: 1, recorded: 1 });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("pulls one seeded store when asked by slug", async () => {
    const report = await refreshIndex({
      retailerSlug: "powerland",
      fetch: fakeFetch(televisions, "application/json"),
      recordUsage: async () => undefined,
      db,
    });
    expect(report.collections.map((c) => c.retailerSlug)).toEqual(["powerland"]);
  });

  it("throws NotFoundError, naming the retailer, for one that is not seeded, before any request", async () => {
    const calls: string[] = [];
    const attempt = refreshIndex({
      retailerSlug: "jb-hi-fi",
      fetch: fakeFetch("", "text/html", calls),
      db,
    });
    await expect(attempt).rejects.toBeInstanceOf(NotFoundError);
    await expect(attempt).rejects.toThrow('No seeded collection for retailer "jb-hi-fi"');
    expect(calls).toEqual([]);
  });

  it("throws ValidationError for a malformed input", async () => {
    await expect(refreshIndex({ retailerSlug: "" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("throws ValidationError for a database clock that is not a function", async () => {
    const calls: string[] = [];
    const attempt = refreshIndex({
      fetch: fakeFetch(televisions, "application/json", calls),
      databaseNow: "now()" as unknown as DatabaseNow,
      db,
    });
    await expect(attempt).rejects.toBeInstanceOf(ValidationError);
    await expect(attempt).rejects.toThrow("Invalid refreshIndex input");
    expect(calls).toEqual([]);
  });

  it("propagates a database failure: the write is the point", async () => {
    upsert.mockRejectedValueOnce(new Error("connection refused"));
    await expect(
      refreshIndex({
        fetch: fakeFetch(televisions, "application/json"),
        recordUsage: async () => undefined,
        db,
      }),
    ).rejects.toThrow("connection refused");
  });
});

describe("searchIndex", () => {
  const qn80h65 = row();
  const qn80h75 = row({
    id: "00000000-0000-0000-0000-000000000002",
    handle: "samsung-75-qn80h",
    canonicalUrl: `${POWERLAND_ORIGIN}/products/samsung-75-qn80h`,
    title: 'Samsung 75" QN80H 4K Vision AI UHD Neo QLED Smart TV QA75QN80HAWXXY',
    mpn: "QA75QN80HAWXXY",
    retailerSku: "QA75QN80HAWXXY",
    priceCents: 242900,
  });
  const dvd = row({
    id: "00000000-0000-0000-0000-000000000003",
    handle: "laser-dvd",
    title: "Laser DVD Player with HDMI",
    brand: "Laser",
    mpn: null,
    retailerSku: null,
    priceCents: 4900,
    compareAtCents: null,
  });

  it("returns nothing for a blank query without asking the index", async () => {
    expect(await searchIndex({ query: "   ", db })).toEqual({
      query: "",
      queryKind: "text",
      gtin: null,
      products: [],
      total: 0,
    });
    expect(search).not.toHaveBeenCalled();
  });

  it("asks the index for a wide set of rows, judges each and drops the unrelated ones", async () => {
    search.mockResolvedValueOnce([dvd, qn80h75, qn80h65]);
    const report = await searchIndex({ query: "samsung 65 qn80h", db });

    expect(search).toHaveBeenCalledWith(db, { query: "samsung 65 qn80h", limit: CANDIDATE_ROWS });
    expect(report.queryKind).toBe("text");
    expect(report.total).toBe(2);
    expect(report.products.map((p) => [p.key, p.relevance.tier])).toEqual([
      ["mpn:QA65QN80HAWXXY", "match"],
      ["mpn:QA75QN80HAWXXY", "partial"],
    ]);
    expect(report.products[0]).toMatchObject({
      title: qn80h65.title,
      brand: "Samsung",
      mpn: "QA65QN80HAWXXY",
      gtin: null,
      imageUrl: "https://cdn.example/qn80h.jpg",
      cheapest: { retailerSlug: "powerland", priceCents: 181900 },
      trackedVariantSlug: null,
      matchedBy: null,
    });
    expect(report.products[0].offers).toEqual([
      {
        retailerSlug: "powerland",
        retailerName: "Powerland",
        priceCents: 181900,
        compareAtCents: 219900,
        available: true,
        canonicalUrl: `${POWERLAND_ORIGIN}/products/samsung-65-qn80h`,
        lastSeenAt: FIXED_NOW,
        source: "listing",
        via: "storefront",
      },
    ]);
  });

  it("names a Google Shopping row's seller as Google printed it and marks the offer via Google Shopping", async () => {
    const googleRaw = {
      position: 4,
      title: "OLED S85H 4K Samsung AI Smart TV",
      product_id: "1202807262352129590",
      product_link: "https://www.google.com.au/shopping/product/1202807262352129590?gl=au",
      source: "The Good Guys",
      price: "$2,795.00",
      extracted_price: 2795,
    };
    search.mockResolvedValueOnce([
      row({
        id: "50",
        retailerSlug: "the-good-guys",
        handle: "1202807262352129590",
        canonicalUrl: "https://www.thegoodguys.com.au/samsung-65-s85h",
        title: "Samsung 65 S85H OLED TV QA65S85HAEXXY",
        brand: null,
        mpn: "QA65S85HAEXXY",
        retailerSku: null,
        priceCents: 279500,
        source: "search",
        raw: googleRaw,
      }),
      // A tracked store listed by Google keeps the tracked tables' name.
      row({
        id: "51",
        retailerSlug: "jb-hi-fi",
        handle: "1202807262352129590",
        canonicalUrl: "https://www.jbhifi.com.au/products/samsung-65-s85h-oled-4k-smart-ai-tv-2026",
        title: "Samsung 65 S85H OLED TV QA65S85HAEXXY",
        mpn: "QA65S85HAEXXY",
        priceCents: 279900,
        source: "search",
        raw: { ...googleRaw, source: "JB Hi-Fi" },
      }),
      // A storefront row whose raw names neither a product id nor a link is a storefront offer.
      row({
        id: "52",
        retailerSlug: "other-store",
        handle: "x",
        title: "Samsung 65 S85H OLED TV QA65S85HAEXXY",
        mpn: "QA65S85HAEXXY",
        priceCents: 289900,
        source: "search",
        raw: { source: "not google", title: "x" },
      }),
    ]);
    const report = await searchIndex({ query: "S85H", db });
    expect(report.products).toHaveLength(1);
    expect(report.products[0].offers.map((o) => [o.retailerName, o.via])).toEqual([
      ["The Good Guys", "google_shopping"],
      ["JB Hi-Fi", "google_shopping"],
      ["other-store", "storefront"],
    ]);
  });

  it("groups rows sharing a GTIN, then a model code, then a title, with every store's offer", async () => {
    const jbByGtin = row({
      id: "10",
      retailerSlug: "jb-hi-fi",
      handle: "jb-qn80h",
      canonicalUrl: "https://www.jbhifi.com.au/products/jb-qn80h",
      title: 'Samsung 65" QN80H Neo QLED 4K Smart TV [2026]',
      mpn: null,
      gtin: "04006381333931",
      retailerSku: "111",
      priceCents: 179900,
      imageUrl: null,
      source: "search",
    });
    const powerlandByGtin = row({ gtin: "04006381333931" });
    const otherByMpn = row({
      id: "11",
      retailerSlug: "other-store",
      handle: "other-qn80h",
      canonicalUrl: "https://other.example/products/other-qn80h",
      title: 'Samsung 65" QN80H QA65QN80HAWXXY',
      gtin: null,
      priceCents: null,
      imageUrl: null,
    });
    const byTitleA = row({
      id: "12",
      retailerSlug: "store-a",
      handle: "a",
      title: "Samsung 65 QN80H bundle",
      mpn: null,
      gtin: null,
      retailerSku: null,
      priceCents: 200000,
    });
    const byTitleB = row({
      id: "13",
      retailerSlug: "store-b",
      handle: "b",
      title: "SAMSUNG 65 QN80H  Bundle",
      mpn: null,
      gtin: null,
      retailerSku: null,
      priceCents: 190000,
    });
    search.mockResolvedValueOnce([powerlandByGtin, jbByGtin, otherByMpn, byTitleA, byTitleB]);

    const report = await searchIndex({ query: "samsung 65 qn80h", db });

    expect(report.total).toBe(2);
    // The GTIN rows and the model-code row are one product: the Powerland row carries both.
    const product = report.products.find((p) => p.key === "gtin:04006381333931");
    const bundle = report.products.find((p) => p.key === "title:samsung 65 qn80h bundle");
    if (product === undefined || bundle === undefined) throw new Error("expected both groups");
    // The shortest title names the group; the first row with each field fills it.
    expect(product.title).toBe('Samsung 65" QN80H QA65QN80HAWXXY');
    expect(product.gtin).toBe("04006381333931");
    expect(product.mpn).toBe("QA65QN80HAWXXY");
    expect(product.imageUrl).toBe("https://cdn.example/qn80h.jpg");
    // Cheapest first, a row without a price last; the slug stands in for a store no table names.
    expect(product.offers.map((o) => [o.retailerName, o.priceCents])).toEqual([
      ["JB Hi-Fi", 179900],
      ["Powerland", 181900],
      ["other-store", null],
    ]);
    expect(product.cheapest).toEqual({ retailerSlug: "jb-hi-fi", priceCents: 179900 });
    expect(bundle.offers.map((o) => o.retailerSlug)).toEqual(["store-b", "store-a"]);
  });

  it("keeps apart two rows with one title but different model codes", async () => {
    search.mockResolvedValueOnce([
      row({ id: "20", handle: "x", title: "Samsung 65 TV", mpn: "AAA111" }),
      row({ id: "21", handle: "y", title: "Samsung 65 TV", mpn: "BBB222" }),
      row({ id: "22", handle: "z", title: "Samsung 65 TV", mpn: null }),
    ]);
    const report = await searchIndex({ query: "samsung 65", db });
    // The row without a code joins the first group whose title it shares.
    expect(report.products.map((p) => [p.key, p.offers.length])).toEqual([
      ["mpn:AAA111", 2],
      ["mpn:BBB222", 1],
    ]);
  });

  it("matches a GTIN query exactly, in 14-digit form, and takes the index's match as a match", async () => {
    search.mockResolvedValueOnce([
      row({ gtin: "08806097962670" }),
      row({ id: "30", handle: "other", gtin: "04006381333931" }),
      row({ id: "31", handle: "none", gtin: null }),
    ]);
    const report = await searchIndex({ query: "8806097962670", db });

    expect(search).toHaveBeenCalledWith(db, { query: "08806097962670", limit: CANDIDATE_ROWS });
    expect(report).toMatchObject({
      query: "8806097962670",
      queryKind: "gtin",
      gtin: "08806097962670",
    });
    expect(report.total).toBe(1);
    expect(report.products[0].relevance).toEqual({
      tier: "match",
      score: 1,
      matched: [],
      missing: [],
      reason: "the index matched the barcode",
    });
    // That GTIN is the tracked variant's.
    expect(report.products[0].trackedVariantSlug).toBe("samsung-s85h-65-au");
    expect(report.products[0].matchedBy).toBe("gtin");
  });

  it("marks a product held when any of its rows matches a tracked variant by model code or URL", async () => {
    search.mockResolvedValueOnce([
      row({ title: "Samsung 65 S85H OLED TV", mpn: "QA65S85HAEXXY", gtin: null }),
      row({
        id: "40",
        handle: "jb",
        retailerSlug: "jb-hi-fi",
        title: "Samsung 65 S85H OLED TV",
        mpn: null,
        gtin: null,
        retailerSku: null,
        canonicalUrl: "https://www.jbhifi.com.au/products/samsung-65-s85h-oled-4k-smart-ai-tv-2026",
      }),
    ]);
    const report = await searchIndex({ query: "S85H", db });
    expect(report.products).toHaveLength(1);
    expect(report.products[0]).toMatchObject({
      trackedVariantSlug: "samsung-s85h-65-au",
      matchedBy: "mpn",
    });
  });

  it("applies the limit, defaulting to eight, and reports the total before it", async () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      row({
        id: String(i),
        handle: `h${i}`,
        title: `Samsung TV ${i}`,
        mpn: null,
        retailerSku: null,
      }),
    );
    search.mockResolvedValue(many);
    expect(DEFAULT_SEARCH_LIMIT).toBe(8);
    expect(MAX_SEARCH_LIMIT).toBe(50);

    const byDefault = await searchIndex({ query: "samsung", db });
    expect(byDefault.products).toHaveLength(8);
    expect(byDefault.total).toBe(12);

    const three = await searchIndex({ query: "samsung", limit: 3, db });
    expect(three.products).toHaveLength(3);
    expect(three.total).toBe(12);
  });

  it("throws ValidationError for a query over 200 characters or a limit outside 1 to 50", async () => {
    await expect(searchIndex({ query: "x".repeat(201), db })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(searchIndex({ query: "tv", limit: 0, db })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(searchIndex({ query: "tv", limit: 51, db })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(search).not.toHaveBeenCalled();
  });

  it("uses the application database when none is injected", async () => {
    await searchIndex({ query: "tv" });
    expect(search.mock.calls[0][0]).toEqual({ name: "application db" });
  });

  it("propagates a database failure as it is", async () => {
    search.mockRejectedValueOnce(new Error("connection refused"));
    await expect(searchIndex({ query: "tv", db })).rejects.toThrow("connection refused");
  });
});

describe("indexStatus", () => {
  it("shapes the counts with each store's name", async () => {
    const later = new Date("2026-10-06T02:00:00.000Z");
    count.mockResolvedValueOnce({
      total: 131,
      byRetailer: [
        { retailerSlug: "jb-hi-fi", count: 2, lastSeenAt: FIXED_NOW },
        { retailerSlug: "powerland", count: 129, lastSeenAt: later },
      ],
    });
    expect(await indexStatus({ db })).toEqual({
      total: 131,
      stores: [
        {
          retailerSlug: "jb-hi-fi",
          retailerName: "JB Hi-Fi",
          known: true,
          count: 2,
          lastSeenAt: FIXED_NOW,
        },
        {
          retailerSlug: "powerland",
          retailerName: "Powerland",
          known: true,
          count: 129,
          lastSeenAt: later,
        },
      ],
    });
    expect(count).toHaveBeenCalledWith(db);
  });

  it("marks a seller learned from Google Shopping as not known to the tracked tables", async () => {
    count.mockResolvedValueOnce({
      total: 1,
      byRetailer: [{ retailerSlug: "the-good-guys", count: 1, lastSeenAt: FIXED_NOW }],
    });
    expect((await indexStatus({ db })).stores[0]).toMatchObject({
      retailerName: "the-good-guys",
      known: false,
    });
  });

  it("reports an empty index", async () => {
    expect(await indexStatus()).toEqual({ total: 0, stores: [] });
    expect(count.mock.calls[0][0]).toEqual({ name: "application db" });
  });

  it("propagates a database failure as it is", async () => {
    count.mockRejectedValueOnce(new Error("connection refused"));
    await expect(indexStatus({ db })).rejects.toThrow("connection refused");
  });

  it("throws ValidationError for a database handle that is not an object, before any query", async () => {
    const attempt = indexStatus({ db: "postgres://localhost" as unknown as QueryDb });
    await expect(attempt).rejects.toBeInstanceOf(ValidationError);
    await expect(attempt).rejects.toThrow("Invalid indexStatus input");
    expect(count).not.toHaveBeenCalled();
  });
});
