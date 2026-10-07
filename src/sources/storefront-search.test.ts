import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIMIT,
  fetchCandidateIdentifiers,
  MAX_LIMIT,
  searchStorefront,
  suggestUrl,
} from "./storefront-search";
import { SourceError, type FetchLike, type SourceCall } from "./types";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

const jbLgC5 = fixture("jbhifi-suggest-lg-c5-65.json");
const jbGtinS85h = fixture("jbhifi-suggest-gtin-s85h.json");
const jbEmpty = fixture("jbhifi-suggest-empty.json");
const powerlandLgC5 = fixture("powerland-suggest-lg-c5-65.json");
const bingLee = fixture("binglee-challenge.html");
const jbS85hProduct = fixture("jbhifi-s85h-65.shopify.json");

const JB_ORIGIN = "https://www.jbhifi.com.au";
const POWERLAND_ORIGIN = "https://powerland.com.au";
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

const jbInput = {
  retailerSlug: "jb-hi-fi",
  retailerName: "JB Hi-Fi",
  origin: JB_ORIGIN,
  query: "LG C5 65",
  now: () => FIXED_NOW,
};

describe("suggestUrl", () => {
  it("builds the predictive search URL with the query encoded", () => {
    expect(suggestUrl(JB_ORIGIN, "LG C5 65", 10)).toBe(
      `${JB_ORIGIN}/search/suggest.json?q=LG+C5+65&resources%5Btype%5D=product&resources%5Blimit%5D=10`,
    );
  });

  it("encodes a query with reserved characters", () => {
    expect(suggestUrl(JB_ORIGIN, 'LG 65" C5 & more', 5)).toContain("q=LG+65%22+C5+%26+more");
  });
});

describe("searchStorefront", () => {
  it("reads the JB Hi-Fi title query into four LG candidates", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(jbLgC5));
    const candidates = await searchStorefront({ ...jbInput, fetch });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(suggestUrl(JB_ORIGIN, "LG C5 65", DEFAULT_LIMIT));
    expect(new Headers(calls[0].init?.headers).get("accept")).toBe("application/json");

    expect(candidates).toHaveLength(4);
    expect(candidates.map((candidate) => candidate.title)).toEqual([
      'LG 65" OLED EVO AI C6 4K Smart TV [2026]',
      'LG 65" OLED EVO AI G6 4K Smart TV [2026]',
      'LG 65" OLED AI B6 4K Smart TV [2026]',
      'LG 65" QNED70B AI Mini-LED 4K Smart TV [2026]',
    ]);

    const [first] = candidates;
    expect(first.retailerSlug).toBe("jb-hi-fi");
    expect(first.retailerName).toBe("JB Hi-Fi");
    expect(first.method).toBe("storefront_search");
    expect(first.fetchedAt).toBe(FIXED_NOW);
    expect(first.brand).toBe("LG");
    expect(first.storeType).toBe("VISUAL");
    expect(first.handle).toBe("lg-65-oled-evo-ai-c6-4k-smart-tv-2026");
    // The search's position and query parameters are tracking; the page URL is canonical.
    expect(first.url).toBe(`${JB_ORIGIN}/products/lg-65-oled-evo-ai-c6-4k-smart-tv-2026`);
    expect(first.priceCents).toBe(326600);
    expect(first.currency).toBe("AUD");
    expect(first.strikethroughCents).toBe(399500);
    expect(first.availability).toBe("in_stock");
    expect(first.imageUrl).toBe(
      "https://cdn.shopify.com/s/files/1/0024/9803/5810/files/891999-Product-0-I-639082669206429411.jpg?v=1790122086",
    );
    expect(first.provenance).toEqual({ kind: "search", via: calls[0].url });
  });

  it("carries no identifiers from a JB Hi-Fi title: the model code is not printed", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(jbLgC5));
    const candidates = await searchStorefront({ ...jbInput, fetch });
    // The first three titles name a series only; the fourth's "QNED70B" passes the general rule.
    expect(candidates.slice(0, 3).map((candidate) => candidate.identifiers)).toEqual([
      { gtin: null, mpn: null, retailerSku: null },
      { gtin: null, mpn: null, retailerSku: null },
      { gtin: null, mpn: null, retailerSku: null },
    ]);
    expect(candidates[3].identifiers).toEqual({ gtin: null, mpn: "QNED70B", retailerSku: null });
  });

  it("reads a strikethrough of 0.00 as none", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(jbLgC5));
    const candidates = await searchStorefront({ ...jbInput, fetch });
    expect(candidates[2].priceCents).toBe(329500);
    expect(candidates[2].strikethroughCents).toBeNull();
    expect(candidates[3].strikethroughCents).toBeNull();
  });

  it("reads the Powerland title query with the model code at the end of each title", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(powerlandLgC5));
    const candidates = await searchStorefront({
      retailerSlug: "powerland",
      retailerName: "Powerland",
      origin: POWERLAND_ORIGIN,
      query: "LG C5 65",
      fetch,
      now: () => FIXED_NOW,
    });

    expect(calls[0].url).toBe(suggestUrl(POWERLAND_ORIGIN, "LG C5 65", DEFAULT_LIMIT));
    expect(candidates).toHaveLength(3);
    expect(candidates.map((candidate) => candidate.identifiers.mpn)).toEqual([
      "65QNED70BSA",
      "OLED65B6PSA",
      "65QNED86BSA",
    ]);
    expect(candidates.map((candidate) => candidate.storeType)).toEqual([
      "4K QNED TV",
      "OLED",
      "4K QNED TV",
    ]);
    expect(candidates[1].url).toBe(
      `${POWERLAND_ORIGIN}/products/lg-65-ai-b6-4k-smart-oled-tv-2026-oled65b6psa`,
    );
    expect(candidates[1].priceCents).toBe(298900);
    expect(candidates[1].strikethroughCents).toBe(329900);
    // Powerland tags carry no stock word, so `available` decides.
    expect(candidates[1].availability).toBe("in_stock");
  });

  it("reads the JB Hi-Fi GTIN query into one Samsung candidate", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(jbGtinS85h));
    const candidates = await searchStorefront({ ...jbInput, query: "8806097962670", fetch });

    expect(calls[0].url).toBe(suggestUrl(JB_ORIGIN, "8806097962670", DEFAULT_LIMIT));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].title).toBe('Samsung 65" S85H OLED 4K Smart AI TV [2026]');
    expect(candidates[0].brand).toBe("SAMSUNG");
    expect(candidates[0].url).toBe(
      `${JB_ORIGIN}/products/samsung-65-s85h-oled-4k-smart-ai-tv-2026`,
    );
    expect(candidates[0].priceCents).toBe(279500);
    expect(candidates[0].strikethroughCents).toBe(329500);
    expect(candidates[0].identifiers).toEqual({ gtin: null, mpn: null, retailerSku: null });
  });

  it("returns an empty list, not an error, when the store suggests nothing", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(jbEmpty));
    expect(await searchStorefront({ ...jbInput, query: "QA65S85HAEXXY", fetch })).toEqual([]);
  });

  it("keeps the product as raw without its body", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(jbGtinS85h));
    const [candidate] = await searchStorefront({ ...jbInput, fetch });
    const raw = candidate.raw as Record<string, unknown>;
    expect(raw).not.toHaveProperty("body");
    expect(raw.handle).toBe("samsung-65-s85h-oled-4k-smart-ai-tv-2026");
    expect(raw.vendor).toBe("SAMSUNG");
  });

  it("passes the limit through, clamped to the store's maximum", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(jbEmpty));
    await searchStorefront({ ...jbInput, limit: 5, fetch });
    await searchStorefront({ ...jbInput, limit: 50, fetch });
    await searchStorefront({ ...jbInput, limit: 0, fetch });
    expect(calls.map((call) => call.url)).toEqual([
      suggestUrl(JB_ORIGIN, "LG C5 65", 5),
      suggestUrl(JB_ORIGIN, "LG C5 65", MAX_LIMIT),
      suggestUrl(JB_ORIGIN, "LG C5 65", 1),
    ]);
  });

  describe("tolerant parsing", () => {
    function suggest(products: unknown[]): string {
      return JSON.stringify({ resources: { results: { products } } });
    }
    const base = {
      title: "Example 4K TV AB12CD",
      url: "/products/example",
      price: "100.00",
    };

    it("skips a product without a title or a page, and keeps the rest", async () => {
      const { fetch } = fakeFetch(() =>
        jsonResponse(
          suggest([
            { url: "/products/no-title", price: "1.00" },
            base,
            "junk",
            { ...base, url: null },
          ]),
        ),
      );
      const candidates = await searchStorefront({ ...jbInput, fetch });
      expect(candidates.map((candidate) => candidate.title)).toEqual([base.title]);
    });

    it("reads availability from `available` when the tags say nothing, and unknown when both are missing", async () => {
      const { fetch } = fakeFetch(() =>
        jsonResponse(
          suggest([
            { ...base, available: false },
            { ...base, available: true, tags: "Brand:LG, OutOfStock" },
            { ...base, tags: ["SoldOut"] },
            { ...base },
          ]),
        ),
      );
      const candidates = await searchStorefront({ ...jbInput, fetch });
      expect(candidates.map((candidate) => candidate.availability)).toEqual([
        "out_of_stock",
        "out_of_stock",
        "out_of_stock",
        "unknown",
      ]);
    });

    it("reads the image from a string, an object, the fallback field or nothing", async () => {
      const { fetch } = fakeFetch(() =>
        jsonResponse(
          suggest([
            { ...base, featured_image: "https://cdn.example/a.jpg" },
            { ...base, featured_image: { url: "https://cdn.example/b.jpg" } },
            { ...base, featured_image: { alt: "no url" }, image: "https://cdn.example/c.jpg" },
            { ...base, featured_image: 42 },
          ]),
        ),
      );
      const candidates = await searchStorefront({ ...jbInput, fetch });
      expect(candidates.map((candidate) => candidate.imageUrl)).toEqual([
        "https://cdn.example/a.jpg",
        "https://cdn.example/b.jpg",
        "https://cdn.example/c.jpg",
        null,
      ]);
    });

    it("reads a missing or unreadable price as null, with no strikethrough", async () => {
      const { fetch } = fakeFetch(() =>
        jsonResponse(
          suggest([
            { ...base, price: null, compare_at_price_min: "200.00" },
            { ...base, price: "abc", compare_at_price_min: 200 },
            { ...base, price: 100, compare_at_price_min: 0 },
            { ...base, price: 100, compare_at_price_min: 150 },
          ]),
        ),
      );
      const candidates = await searchStorefront({ ...jbInput, fetch });
      expect(
        candidates.map((candidate) => [candidate.priceCents, candidate.strikethroughCents]),
      ).toEqual([
        [null, null],
        [null, null],
        [10000, null],
        [10000, 15000],
      ]);
    });

    it("builds the page URL from an absolute product URL too", async () => {
      const { fetch } = fakeFetch(() =>
        jsonResponse(suggest([{ ...base, url: "https://www.jbhifi.com.au/products/abs?_pos=1" }])),
      );
      const [candidate] = await searchStorefront({ ...jbInput, fetch });
      expect(candidate.url).toBe(`${JB_ORIGIN}/products/abs`);
    });
  });

  describe("failures", () => {
    it("throws blocked for a bot challenge page", async () => {
      const { fetch } = fakeFetch(
        () => new Response(bingLee, { status: 200, headers: { "content-type": "text/html" } }),
      );
      const error = await sourceErrorFrom(
        searchStorefront({
          retailerSlug: "bing-lee",
          origin: "https://www.binglee.com.au",
          query: "LG C5 65",
          fetch,
        }),
      );
      expect(error.kind).toBe("blocked");
      expect(error.retailerSlug).toBe("bing-lee");
    });

    it("throws unparseable for a body that is not JSON", async () => {
      const { fetch } = fakeFetch(() => new Response("<html>not json</html>", { status: 200 }));
      const error = await sourceErrorFrom(searchStorefront({ ...jbInput, fetch }));
      expect(error.kind).toBe("unparseable");
      expect(error.message).toContain("is not JSON");
    });

    it("throws unparseable for JSON that is not a predictive search response", async () => {
      const { fetch } = fakeFetch(() => jsonResponse(JSON.stringify({ products: [] })));
      const error = await sourceErrorFrom(searchStorefront({ ...jbInput, fetch }));
      expect(error.kind).toBe("unparseable");
      expect(error.message).toContain("not a predictive search response");
    });

    it("throws http for a 500", async () => {
      const { fetch } = fakeFetch(() => new Response("down", { status: 500 }));
      const error = await sourceErrorFrom(searchStorefront({ ...jbInput, fetch }));
      expect(error.kind).toBe("http");
      expect(error.status).toBe(500);
    });

    it("throws unparseable for an origin that is not a URL, before any request", async () => {
      const { fetch, calls } = fakeFetch(() => jsonResponse(jbEmpty));
      const error = await sourceErrorFrom(
        searchStorefront({ ...jbInput, origin: "jbhifi.com.au", fetch }),
      );
      expect(error.kind).toBe("unparseable");
      const ftp = await sourceErrorFrom(
        searchStorefront({ ...jbInput, origin: "ftp://jbhifi.com.au", fetch }),
      );
      expect(ftp.kind).toBe("unparseable");
      expect(calls).toHaveLength(0);
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
          ...jbInput,
          fetch,
          now: () => new Date(T0.getTime() + 40 * reads++),
          meter: (call: SourceCall) => void calls.push(call),
        },
      };
    }

    it("reports one ok retailer search call", async () => {
      const { input, calls } = metered(async () => jsonResponse(jbLgC5));
      await searchStorefront(input);
      expect(calls).toEqual([
        {
          provider: "retailer",
          operation: "search",
          startedAt: T0,
          durationMs: 40,
          outcome: "ok",
          errorKind: null,
          httpStatus: 200,
          model: null,
          inputTokens: null,
          outputTokens: null,
          retailerSlug: "jb-hi-fi",
        },
      ]);
    });

    it("reports a failed search call with its kind and status on a 500", async () => {
      const { input, calls } = metered(async () => new Response("down", { status: 500 }));
      await sourceErrorFrom(searchStorefront(input));
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        provider: "retailer",
        operation: "search",
        outcome: "failed",
        errorKind: "http",
        httpStatus: 500,
        retailerSlug: "jb-hi-fi",
      });
    });
  });
});

describe("fetchCandidateIdentifiers", () => {
  it("reads the candidate's product JSON into a quote with its GTIN and SKU, metered as a page", async () => {
    const calls: SourceCall[] = [];
    const { fetch, calls: requests } = fakeFetch(() => jsonResponse(jbS85hProduct));
    const quote = await fetchCandidateIdentifiers({
      retailerSlug: "jb-hi-fi",
      retailerName: "JB Hi-Fi",
      url: `${JB_ORIGIN}/products/samsung-65-s85h-oled-4k-smart-ai-tv-2026`,
      fetch,
      now: () => FIXED_NOW,
      meter: (call) => void calls.push(call),
    });
    expect(requests.map((request) => request.url)).toEqual([
      `${JB_ORIGIN}/products/samsung-65-s85h-oled-4k-smart-ai-tv-2026.json`,
    ]);
    expect(quote.method).toBe("shopify_json");
    expect(quote.identifiers).toEqual({
      gtin: "08806097962670",
      mpn: null,
      retailerSku: "902825",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ provider: "retailer", operation: "page", outcome: "ok" });
  });
});
