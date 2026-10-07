import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DELAY_MS,
  DEFAULT_MAX_PAGES,
  listingUrl,
  listStorefrontCollection,
  MAX_PAGES,
  PAGE_SIZE,
} from "./storefront-listing";
import { SourceError, type FetchLike, type SourceCall } from "./types";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

const televisions = fixture("powerland-collection-televisions.json");
const bingLee = fixture("binglee-challenge.html");

const ORIGIN = "https://powerland.com.au";
const FIXED_NOW = new Date("2026-10-06T01:02:03.000Z");

type Call = { url: string; init?: RequestInit };

function fakeFetch(respond: (url: string) => Response | Promise<Response>, calls: Call[] = []) {
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return respond(url);
  };
  return { fetch, calls };
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

async function sourceErrorFrom(promise: Promise<unknown>): Promise<SourceError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SourceError) return error;
    throw new Error(`Expected a SourceError, got ${String(error)}`);
  }
  throw new Error("Expected a rejection");
}

/** Page `n` of the fake fetch's URL, so a test can answer per page. */
function pageOf(url: string): number {
  return Number(new URL(url).searchParams.get("page"));
}

function listing(products: unknown[]): string {
  return JSON.stringify({ products });
}

/**
 * A full page: the six fixture products cloned with distinct handles until
 * there are PAGE_SIZE of them, each a real product as Shopify prints it.
 */
function fullPage(page: number): string {
  const fixtureProducts = (JSON.parse(televisions) as { products: Record<string, unknown>[] })
    .products;
  const products = Array.from({ length: PAGE_SIZE }, (_, index) => {
    const base = fixtureProducts[index % fixtureProducts.length];
    return { ...base, handle: `${String(base.handle)}-p${page}-${index}` };
  });
  return listing(products);
}

const baseInput = {
  retailerSlug: "powerland",
  retailerName: "Powerland",
  origin: ORIGIN,
  collection: "televisions",
  delayMs: 0,
  now: () => FIXED_NOW,
};

describe("listingUrl", () => {
  it("builds the collection products.json URL for a page", () => {
    expect(listingUrl(ORIGIN, "televisions", 1)).toBe(
      `${ORIGIN}/collections/televisions/products.json?limit=250&page=1`,
    );
    expect(listingUrl(ORIGIN, "televisions", 3)).toBe(
      `${ORIGIN}/collections/televisions/products.json?limit=250&page=3`,
    );
  });

  it("encodes a collection handle with reserved characters", () => {
    expect(listingUrl(ORIGIN, "tv & audio", 1)).toContain("/collections/tv%20%26%20audio/");
  });
});

describe("listStorefrontCollection", () => {
  it("reads the six Powerland televisions from one short page", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(televisions));
    const candidates = await listStorefrontCollection({ ...baseInput, fetch });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(listingUrl(ORIGIN, "televisions", 1));
    expect(new Headers(calls[0].init?.headers).get("accept")).toBe("application/json");

    expect(candidates).toHaveLength(6);
    expect(candidates.map((candidate) => candidate.title)).toEqual([
      'LG 42" Evo C3 4K Smart Gaming TV with Self Lit OLED Pixels OLED42C3PSA',
      'Samsung 55" S90F 4K Vision AI OLED Smart TV QA55S90FAWXXY',
      'Yokohama 55" QLED 4K UHD webOS Smart LED TV YOKT55Q8',
      'Samsung 75" QN80H 4K Vision AI UHD Neo QLED Smart TV QA75QN80HAWXXY',
      'Samsung 65" Mini LED M70H 4K Vision AI Smart TV UA65M70HAWXXY',
      'Samsung 65" QN80H 4K Vision AI UHD Neo QLED Smart TV QA65QN80HAWXXY',
    ]);

    const [lg, samsung, yokohama] = candidates;
    expect(lg.retailerSlug).toBe("powerland");
    expect(lg.retailerName).toBe("Powerland");
    expect(lg.method).toBe("storefront_listing");
    expect(lg.fetchedAt).toBe(FIXED_NOW);
    expect(lg.brand).toBe("LG");
    expect(lg.storeType).toBe("OLED");
    expect(lg.handle).toBe("lg-42-evo-c3-4k-smart-gaming-tv-with-self-lit-oled-pixels-oled42c3psa");
    expect(lg.url).toBe(
      `${ORIGIN}/products/lg-42-evo-c3-4k-smart-gaming-tv-with-self-lit-oled-pixels-oled42c3psa`,
    );
    expect(lg.priceCents).toBe(238900);
    expect(lg.currency).toBe("AUD");
    expect(lg.strikethroughCents).toBe(311900);
    expect(lg.availability).toBe("in_stock");
    expect(lg.imageUrl).toBe(
      "https://cdn.shopify.com/s/files/1/0700/1214/1807/files/oled42c3psa-1a-new.jpg?v=1772916341",
    );
    expect(lg.identifiers).toEqual({ gtin: null, mpn: "OLED42C3PSA", retailerSku: "OLED42C3PSA" });
    expect(lg.provenance).toEqual({ kind: "search", via: calls[0].url });

    expect(samsung.brand).toBe("Samsung");
    expect(samsung.priceCents).toBe(209900);
    expect(samsung.strikethroughCents).toBe(329900);
    expect(samsung.identifiers.mpn).toBe("QA55S90FAWXXY");

    expect(yokohama.storeType).toBe("4K QLED UHD");
    expect(yokohama.priceCents).toBe(59900);
    expect(yokohama.strikethroughCents).toBe(159000);
    expect(yokohama.identifiers).toEqual({ gtin: null, mpn: "YOKT55Q8", retailerSku: "YOKT55Q8" });

    expect(candidates.map((candidate) => candidate.brand)).toEqual([
      "LG",
      "Samsung",
      "Yokohama",
      "Samsung",
      "Samsung",
      "Samsung",
    ]);
    expect(candidates.map((candidate) => candidate.identifiers.retailerSku)).toEqual([
      "OLED42C3PSA",
      "QA55S90FAWXXY",
      "YOKT55Q8",
      "QA75QN80HAWXXY",
      "UA65M70HAWXXY",
      "QA65QN80HAWXXY",
    ]);
  });

  it("keeps the product as raw without its body and with the first image only", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse(
        listing([
          {
            title: "Example TV AB12CD34",
            handle: "example",
            body_html: "<p>long</p>",
            images: [{ src: "https://cdn.example/a.jpg" }, { src: "https://cdn.example/b.jpg" }],
            variants: [{ price: "1.00" }],
          },
        ]),
      ),
    );
    const [candidate] = await listStorefrontCollection({ ...baseInput, fetch });
    const raw = candidate.raw as Record<string, unknown>;
    expect(raw).not.toHaveProperty("body_html");
    expect(raw.images).toEqual([{ src: "https://cdn.example/a.jpg" }]);
    expect(raw.handle).toBe("example");
    expect(candidate.imageUrl).toBe("https://cdn.example/a.jpg");
  });

  it("returns an empty list, not an error, when the collection is empty", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(listing([])));
    expect(await listStorefrontCollection({ ...baseInput, fetch })).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  describe("pagination", () => {
    it("walks a second page when the first is full and stops at the short one", async () => {
      const { fetch, calls } = fakeFetch((url) =>
        jsonResponse(pageOf(url) === 1 ? fullPage(1) : televisions),
      );
      const candidates = await listStorefrontCollection({ ...baseInput, fetch });

      expect(calls.map((call) => call.url)).toEqual([
        listingUrl(ORIGIN, "televisions", 1),
        listingUrl(ORIGIN, "televisions", 2),
      ]);
      expect(candidates).toHaveLength(PAGE_SIZE + 6);
      expect(candidates[0].provenance.via).toBe(calls[0].url);
      expect(candidates[PAGE_SIZE].provenance.via).toBe(calls[1].url);
      expect(candidates[0].url).toBe(
        `${ORIGIN}/products/lg-42-evo-c3-4k-smart-gaming-tv-with-self-lit-oled-pixels-oled42c3psa-p1-0`,
      );
    });

    it("stops when a page after a full one is empty", async () => {
      const { fetch, calls } = fakeFetch((url) =>
        jsonResponse(pageOf(url) === 1 ? fullPage(1) : listing([])),
      );
      const candidates = await listStorefrontCollection({ ...baseInput, fetch });
      expect(calls).toHaveLength(2);
      expect(candidates).toHaveLength(PAGE_SIZE);
    });

    it("stops at maxPages while pages are still full", async () => {
      const { fetch, calls } = fakeFetch((url) => jsonResponse(fullPage(pageOf(url))));
      const candidates = await listStorefrontCollection({ ...baseInput, maxPages: 2, fetch });
      expect(calls.map((call) => pageOf(call.url))).toEqual([1, 2]);
      expect(candidates).toHaveLength(2 * PAGE_SIZE);
    });

    it("walks four pages by default and never more than forty", async () => {
      const { fetch, calls } = fakeFetch((url) => jsonResponse(fullPage(pageOf(url))));
      await listStorefrontCollection({ ...baseInput, fetch });
      expect(calls).toHaveLength(DEFAULT_MAX_PAGES);

      const capped = fakeFetch((url) => jsonResponse(fullPage(pageOf(url))));
      await listStorefrontCollection({ ...baseInput, maxPages: 100, fetch: capped.fetch });
      expect(capped.calls).toHaveLength(MAX_PAGES);

      const floor = fakeFetch((url) => jsonResponse(fullPage(pageOf(url))));
      await listStorefrontCollection({ ...baseInput, maxPages: 0, fetch: floor.fetch });
      expect(floor.calls).toHaveLength(1);
    });

    it("waits delayMs between pages and not before the first", async () => {
      const waits: number[] = [];
      const sleep = async (ms: number) => void waits.push(ms);
      const { fetch } = fakeFetch((url) =>
        jsonResponse(pageOf(url) === 1 ? fullPage(1) : televisions),
      );

      await listStorefrontCollection({ ...baseInput, delayMs: 250, sleep, fetch });
      expect(waits).toEqual([250]);

      waits.length = 0;
      await listStorefrontCollection({ ...baseInput, delayMs: undefined, sleep, fetch });
      expect(waits).toEqual([DEFAULT_DELAY_MS]);

      waits.length = 0;
      await listStorefrontCollection({ ...baseInput, delayMs: 0, sleep, fetch });
      expect(waits).toEqual([]);
    });

    it("does not wait at all for a single short page", async () => {
      const waits: number[] = [];
      const sleep = async (ms: number) => void waits.push(ms);
      const { fetch } = fakeFetch(() => jsonResponse(televisions));
      await listStorefrontCollection({ ...baseInput, delayMs: 500, sleep, fetch });
      expect(waits).toEqual([]);
    });
  });

  describe("tolerant parsing", () => {
    const base = {
      title: "Example 4K TV AB12CD34",
      handle: "example",
      variants: [{ price: "100.00", sku: "SKU-1", available: true }],
    };

    it("skips a product without a title or a handle, and keeps the rest", async () => {
      const { fetch } = fakeFetch(() =>
        jsonResponse(
          listing([{ handle: "no-title", variants: [] }, base, "junk", { ...base, handle: null }]),
        ),
      );
      const candidates = await listStorefrontCollection({ ...baseInput, fetch });
      expect(candidates.map((candidate) => candidate.title)).toEqual([base.title]);
    });

    it("falls back to the SKU for the mpn only when the SKU is itself a model code", async () => {
      const { fetch } = fakeFetch(() =>
        jsonResponse(
          listing([
            { ...base, title: "Example TV", variants: [{ sku: "QA55S90FAWXXY" }] },
            { ...base, title: "Example TV", variants: [{ sku: "123456" }] },
            { ...base, title: "Example TV", variants: [{ sku: null }] },
            { ...base, title: "Example TV", variants: [] },
            { ...base, title: "Example TV ZZ99YY", variants: [{ sku: "QA55S90FAWXXY" }] },
          ]),
        ),
      );
      const candidates = await listStorefrontCollection({ ...baseInput, fetch });
      expect(candidates.map((candidate) => candidate.identifiers)).toEqual([
        { gtin: null, mpn: "QA55S90FAWXXY", retailerSku: "QA55S90FAWXXY" },
        { gtin: null, mpn: null, retailerSku: "123456" },
        { gtin: null, mpn: null, retailerSku: null },
        { gtin: null, mpn: null, retailerSku: null },
        { gtin: null, mpn: "ZZ99YY", retailerSku: "QA55S90FAWXXY" },
      ]);
    });

    it("reads availability from the first variant's flag, and unknown when it is missing", async () => {
      const { fetch } = fakeFetch(() =>
        jsonResponse(
          listing([
            { ...base, variants: [{ available: true }] },
            { ...base, variants: [{ available: false }] },
            { ...base, variants: [{ available: "yes" }] },
            { ...base, variants: [] },
          ]),
        ),
      );
      const candidates = await listStorefrontCollection({ ...baseInput, fetch });
      expect(candidates.map((candidate) => candidate.availability)).toEqual([
        "in_stock",
        "out_of_stock",
        "unknown",
        "unknown",
      ]);
    });

    it("reads a missing, zero or lower compare-at as no strikethrough", async () => {
      const { fetch } = fakeFetch(() =>
        jsonResponse(
          listing([
            { ...base, variants: [{ price: "100.00", compare_at_price: null }] },
            { ...base, variants: [{ price: "100.00", compare_at_price: "0.00" }] },
            { ...base, variants: [{ price: "100.00", compare_at_price: "100.00" }] },
            { ...base, variants: [{ price: "100.00", compare_at_price: "150.00" }] },
            { ...base, variants: [{ price: null, compare_at_price: "150.00" }] },
            { ...base, variants: [{ price: 100, compare_at_price: 150 }] },
          ]),
        ),
      );
      const candidates = await listStorefrontCollection({ ...baseInput, fetch });
      expect(
        candidates.map((candidate) => [candidate.priceCents, candidate.strikethroughCents]),
      ).toEqual([
        [10000, null],
        [10000, null],
        [10000, null],
        [10000, 15000],
        [null, null],
        [10000, 15000],
      ]);
    });

    it("reads the image from the first entry's src, or nothing", async () => {
      const { fetch } = fakeFetch(() =>
        jsonResponse(
          listing([
            { ...base, images: [{ src: "https://cdn.example/a.jpg" }] },
            { ...base, images: [{ alt: "no src" }] },
            { ...base, images: [] },
            { ...base, images: "junk" },
            { ...base },
          ]),
        ),
      );
      const candidates = await listStorefrontCollection({ ...baseInput, fetch });
      expect(candidates.map((candidate) => candidate.imageUrl)).toEqual([
        "https://cdn.example/a.jpg",
        null,
        null,
        null,
        null,
      ]);
    });

    it("reads a missing vendor or product type as null", async () => {
      const { fetch } = fakeFetch(() => jsonResponse(listing([base])));
      const [candidate] = await listStorefrontCollection({ ...baseInput, fetch });
      expect(candidate.brand).toBeNull();
      expect(candidate.storeType).toBeNull();
      expect(candidate.url).toBe(`${ORIGIN}/products/example`);
    });
  });

  describe("failures", () => {
    it("throws blocked for a 403 with a bot challenge body", async () => {
      const { fetch } = fakeFetch(
        () => new Response(bingLee, { status: 403, headers: { "content-type": "text/html" } }),
      );
      const error = await sourceErrorFrom(
        listStorefrontCollection({
          ...baseInput,
          retailerSlug: "bing-lee",
          origin: "https://www.binglee.com.au",
          fetch,
        }),
      );
      expect(error.kind).toBe("blocked");
      expect(error.status).toBe(403);
      expect(error.retailerSlug).toBe("bing-lee");
    });

    it("throws blocked for a 200 that is a bot challenge page", async () => {
      const { fetch } = fakeFetch(
        () => new Response(bingLee, { status: 200, headers: { "content-type": "text/html" } }),
      );
      const error = await sourceErrorFrom(listStorefrontCollection({ ...baseInput, fetch }));
      expect(error.kind).toBe("blocked");
    });

    it("throws unparseable for a body that is not JSON", async () => {
      const { fetch } = fakeFetch(() => new Response("<html>not json</html>", { status: 200 }));
      const error = await sourceErrorFrom(listStorefrontCollection({ ...baseInput, fetch }));
      expect(error.kind).toBe("unparseable");
      expect(error.message).toContain("is not JSON");
    });

    it("throws unparseable for JSON that is not a products listing", async () => {
      const { fetch } = fakeFetch(() => jsonResponse(JSON.stringify({ collection: {} })));
      const error = await sourceErrorFrom(listStorefrontCollection({ ...baseInput, fetch }));
      expect(error.kind).toBe("unparseable");
      expect(error.message).toContain("not a collection products listing");
    });

    it("throws http for a 500", async () => {
      const { fetch } = fakeFetch(() => new Response("down", { status: 500 }));
      const error = await sourceErrorFrom(listStorefrontCollection({ ...baseInput, fetch }));
      expect(error.kind).toBe("http");
      expect(error.status).toBe(500);
    });

    it("throws unparseable for an origin that is not a URL, before any request", async () => {
      const { fetch, calls } = fakeFetch(() => jsonResponse(televisions));
      const error = await sourceErrorFrom(
        listStorefrontCollection({ ...baseInput, origin: "powerland.com.au", fetch }),
      );
      expect(error.kind).toBe("unparseable");
      expect(calls).toHaveLength(0);
    });

    it("surfaces a failure on the second page after the first page's candidates were read", async () => {
      const { fetch, calls } = fakeFetch((url) =>
        pageOf(url) === 1 ? jsonResponse(fullPage(1)) : new Response("down", { status: 500 }),
      );
      const error = await sourceErrorFrom(listStorefrontCollection({ ...baseInput, fetch }));
      expect(error.kind).toBe("http");
      expect(calls).toHaveLength(2);
    });
  });

  describe("metering", () => {
    const T0 = new Date("2026-10-06T00:00:00.000Z");

    function metered(fetch: FetchLike) {
      const calls: SourceCall[] = [];
      let reads = 0;
      return {
        calls,
        input: {
          ...baseInput,
          fetch,
          now: () => new Date(T0.getTime() + 40 * reads++),
          meter: (call: SourceCall) => void calls.push(call),
        },
      };
    }

    it("reports one ok listing call per page", async () => {
      const { input, calls } = metered(async (url) =>
        jsonResponse(pageOf(url) === 1 ? fullPage(1) : televisions),
      );
      await listStorefrontCollection(input);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual({
        provider: "retailer",
        operation: "listing",
        startedAt: T0,
        durationMs: 40,
        outcome: "ok",
        errorKind: null,
        httpStatus: 200,
        model: null,
        inputTokens: null,
        outputTokens: null,
        retailerSlug: "powerland",
      });
      expect(calls[1]).toMatchObject({ operation: "listing", outcome: "ok", httpStatus: 200 });
    });

    it("reports a failed listing call with its kind and status on a 500", async () => {
      const { input, calls } = metered(async () => new Response("down", { status: 500 }));
      await sourceErrorFrom(listStorefrontCollection(input));
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        provider: "retailer",
        operation: "listing",
        outcome: "failed",
        errorKind: "http",
        httpStatus: 500,
        retailerSlug: "powerland",
      });
    });
  });
});
