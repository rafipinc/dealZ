import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fetchShopifyQuote, readShopifyCondition, shopifyJsonUrl } from "./shopify";
import { SourceError, type FetchLike } from "./types";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

const jbHiFi = fixture("jbhifi-s85h-65.shopify.json");
const harveyNorman = fixture("harveynorman-challenge.html");

const PAGE_URL = "https://www.jbhifi.com.au/products/samsung-65-s85h-oled-4k-smart-ai-tv-2026";
const JSON_URL = `${PAGE_URL}.json`;
const FIXED_NOW = new Date("2026-09-28T01:02:03.000Z");

type Call = { url: string; init?: RequestInit };

function fakeFetch(respond: (url: string) => Response | Promise<Response>, calls: Call[] = []) {
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return respond(url);
  };
  return { fetch, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The JB Hi-Fi fixture with the first variant patched. */
function withVariant(patch: Record<string, unknown>): unknown {
  const parsed = JSON.parse(jbHiFi) as { product: { variants: Record<string, unknown>[] } };
  parsed.product.variants[0] = { ...parsed.product.variants[0], ...patch };
  return parsed;
}

function withProduct(patch: Record<string, unknown>): unknown {
  const parsed = JSON.parse(jbHiFi) as { product: Record<string, unknown> };
  parsed.product = { ...parsed.product, ...patch };
  return parsed;
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

describe("shopifyJsonUrl", () => {
  it("appends .json to the path and drops the query", () => {
    expect(shopifyJsonUrl(`${PAGE_URL}?variant=1`)).toBe(JSON_URL);
  });

  it("strips a trailing slash before appending", () => {
    expect(shopifyJsonUrl(`${PAGE_URL}/`)).toBe(JSON_URL);
  });

  it("leaves a path that already ends in .json alone", () => {
    expect(shopifyJsonUrl(JSON_URL)).toBe(JSON_URL);
  });
});

describe("readShopifyCondition", () => {
  it("reads refurbished from the title, case-insensitively, and new otherwise", () => {
    expect(readShopifyCondition("Samsung TV - REFURB")).toBe("refurbished");
    expect(readShopifyCondition("Samsung TV Refurbished Grade A")).toBe("refurbished");
    expect(readShopifyCondition("Samsung TV")).toBe("new");
    expect(readShopifyCondition(null)).toBe("new");
  });
});

describe("fetchShopifyQuote", () => {
  it("reads the JB Hi-Fi fixture into a quote", async () => {
    const { fetch, calls } = fakeFetch(() => new Response(jbHiFi, { status: 200 }));
    const quote = await fetchShopifyQuote({
      retailerSlug: "jb-hi-fi",
      retailerName: "JB Hi-Fi",
      url: `${PAGE_URL}?gclid=abc`,
      fetch,
      now: () => FIXED_NOW,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(JSON_URL);
    expect(new Headers(calls[0].init?.headers).get("accept")).toBe("application/json");

    expect(quote.retailerSlug).toBe("jb-hi-fi");
    expect(quote.retailerName).toBe("JB Hi-Fi");
    expect(quote.url).toBe(PAGE_URL);
    expect(quote.url).not.toContain("gclid");
    expect(quote.method).toBe("shopify_json");
    expect(quote.fetchedAt).toBe(FIXED_NOW);
    expect(quote.observedAt).toBe(FIXED_NOW);
    expect(quote.condition).toBe("new");
    expect(quote.provenance).toEqual({ kind: "live", via: null });
    expect(quote.confidence).toBe(1);
    expect(quote.evidence).toBeNull();
    expect(quote.shippingCents).toBeNull();
    expect(quote.title).toBe('Samsung 65" S85H OLED 4K Smart AI TV [2026]');
    expect(quote.priceCents).toBe(279500);
    expect(quote.strikethroughCents).toBe(329500);
    expect(quote.currency).toBe("AUD");
    expect(quote.availability).toBe("in_stock");
    expect(quote.identifiers).toEqual({
      gtin: "08806097962670",
      mpn: null,
      retailerSku: "902825",
    });
  });

  it("keeps the parsed product as raw without images, image, body_html and options", async () => {
    const { fetch } = fakeFetch(() => new Response(jbHiFi, { status: 200 }));
    const quote = await fetchShopifyQuote({ retailerSlug: "jb-hi-fi", url: PAGE_URL, fetch });
    const raw = quote.raw as Record<string, unknown>;
    expect(raw).toHaveProperty("title");
    expect(raw).toHaveProperty("variants");
    expect(raw).toHaveProperty("handle");
    expect(raw).not.toHaveProperty("images");
    expect(raw).not.toHaveProperty("image");
    expect(raw).not.toHaveProperty("body_html");
    expect(raw).not.toHaveProperty("options");
    expect(quote.fetchedAt).toBeInstanceOf(Date);
    expect(quote.retailerName).toBeNull();
  });

  it("marks a product whose title says refurbished as refurbished", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse(withProduct({ title: 'Samsung 65" S85H OLED TV (Refurbished)' })),
    );
    const quote = await fetchShopifyQuote({ retailerSlug: "jb-hi-fi", url: PAGE_URL, fetch });
    expect(quote.condition).toBe("refurbished");
  });

  it("reports no strikethrough when compare_at_price equals the price", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(withVariant({ compare_at_price: "2795.00" })));
    const quote = await fetchShopifyQuote({ retailerSlug: "jb-hi-fi", url: PAGE_URL, fetch });
    expect(quote.strikethroughCents).toBeNull();
  });

  it("reports no strikethrough when compare_at_price is absent", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(withVariant({ compare_at_price: null })));
    const quote = await fetchShopifyQuote({ retailerSlug: "jb-hi-fi", url: PAGE_URL, fetch });
    expect(quote.strikethroughCents).toBeNull();
  });

  it("reports a null GTIN for a barcode that fails the check digit and a null SKU when absent", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse(withVariant({ barcode: "8806097962671", sku: null })),
    );
    const quote = await fetchShopifyQuote({ retailerSlug: "jb-hi-fi", url: PAGE_URL, fetch });
    expect(quote.identifiers).toEqual({ gtin: null, mpn: null, retailerSku: null });
  });

  it("reads availability from an array of tags", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse(withProduct({ tags: ["Brand:Samsung", "instock"] })),
    );
    const quote = await fetchShopifyQuote({ retailerSlug: "jb-hi-fi", url: PAGE_URL, fetch });
    expect(quote.availability).toBe("in_stock");
  });

  it.each(["OutOfStock", "SoldOut"])("reports out_of_stock for the %s tag", async (tag) => {
    const { fetch } = fakeFetch(() => jsonResponse(withProduct({ tags: `Brand:Samsung, ${tag}` })));
    const quote = await fetchShopifyQuote({ retailerSlug: "jb-hi-fi", url: PAGE_URL, fetch });
    expect(quote.availability).toBe("out_of_stock");
  });

  it("reports unknown availability when the tags say nothing about stock or are missing", async () => {
    const { fetch: tagged } = fakeFetch(() => jsonResponse(withProduct({ tags: "Brand:Samsung" })));
    const { fetch: untagged } = fakeFetch(() => jsonResponse(withProduct({ tags: undefined })));
    const a = await fetchShopifyQuote({ retailerSlug: "jb-hi-fi", url: PAGE_URL, fetch: tagged });
    const b = await fetchShopifyQuote({ retailerSlug: "jb-hi-fi", url: PAGE_URL, fetch: untagged });
    expect(a.availability).toBe("unknown");
    expect(b.availability).toBe("unknown");
  });

  it("throws unparseable when the product has no variants", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ product: { title: "No variants" } }));
    const error = await sourceErrorFrom(
      fetchShopifyQuote({ retailerSlug: "jb-hi-fi", url: PAGE_URL, fetch }),
    );
    expect(error.kind).toBe("unparseable");
    expect(error.retailerSlug).toBe("jb-hi-fi");
  });

  it("throws unparseable when the price is not a number", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(withVariant({ price: "call for price" })));
    const error = await sourceErrorFrom(
      fetchShopifyQuote({ retailerSlug: "jb-hi-fi", url: PAGE_URL, fetch }),
    );
    expect(error.kind).toBe("unparseable");
  });

  it("throws unparseable when the body is not JSON", async () => {
    const { fetch } = fakeFetch(() => new Response("<html>not json</html>", { status: 200 }));
    const error = await sourceErrorFrom(
      fetchShopifyQuote({ retailerSlug: "jb-hi-fi", url: PAGE_URL, fetch }),
    );
    expect(error.kind).toBe("unparseable");
  });

  it("throws blocked with status 403 when the store refuses", async () => {
    const { fetch } = fakeFetch(() => new Response("forbidden", { status: 403 }));
    const error = await sourceErrorFrom(
      fetchShopifyQuote({ retailerSlug: "jb-hi-fi", url: PAGE_URL, fetch }),
    );
    expect(error.kind).toBe("blocked");
    expect(error.status).toBe(403);
  });

  it("throws http on a 500", async () => {
    const { fetch } = fakeFetch(() => new Response("error", { status: 500 }));
    const error = await sourceErrorFrom(
      fetchShopifyQuote({ retailerSlug: "jb-hi-fi", url: PAGE_URL, fetch }),
    );
    expect(error.kind).toBe("http");
    expect(error.status).toBe(500);
  });

  it("throws network when fetch rejects", async () => {
    const fetch: FetchLike = async () => {
      throw new Error("timeout");
    };
    const error = await sourceErrorFrom(
      fetchShopifyQuote({ retailerSlug: "jb-hi-fi", url: PAGE_URL, fetch }),
    );
    expect(error.kind).toBe("network");
  });

  it("throws blocked when a 200 body is a challenge page", async () => {
    const { fetch } = fakeFetch(() => new Response(harveyNorman, { status: 200 }));
    const error = await sourceErrorFrom(
      fetchShopifyQuote({ retailerSlug: "jb-hi-fi", url: PAGE_URL, fetch }),
    );
    expect(error.kind).toBe("blocked");
  });
});
