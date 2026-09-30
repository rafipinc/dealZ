import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fetchJsonLdQuote, quoteFromJsonLdHtml } from "./json-ld";
import { SourceError, type FetchLike } from "./types";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

const theGoodGuys = fixture("thegoodguys-s85h-65.html");
const samsung = fixture("samsung-au-s85h-65.html");
const bingLee = fixture("binglee-challenge.html");

const TGG_URL =
  "https://www.thegoodguys.com.au/samsung-65-inches-oled-s85h-4k-smart-ai-tv-2026-qa65s85haexxy";
const SAMSUNG_URL =
  "https://www.samsung.com/au/tvs/oled-tv/s85h-65-inch-oled-4k-smart-tv-qa65s85haexxy/";
const BING_LEE_URL =
  "https://www.binglee.com.au/products/65-oled-s85h-4k-smart-ai-tv-2026-qa65s85haexxy";
const FIXED_NOW = new Date("2026-09-28T01:02:03.000Z");

type Call = { url: string; init?: RequestInit };

function fakeFetch(respond: (url: string) => Response, calls: Call[] = []) {
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return respond(url);
  };
  return { fetch, calls };
}

function ldPage(...nodes: unknown[]): string {
  const scripts = nodes
    .map((node) => `<script type="application/ld+json">${JSON.stringify(node)}</script>`)
    .join("\n");
  return `<html><head>${scripts}</head><body></body></html>`;
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

describe("fetchJsonLdQuote", () => {
  it("reads The Good Guys fixture into a quote", async () => {
    const { fetch, calls } = fakeFetch(() => new Response(theGoodGuys, { status: 200 }));
    const quote = await fetchJsonLdQuote({
      retailerSlug: "the-good-guys",
      retailerName: "The Good Guys",
      url: `${TGG_URL}?utm_source=x&fbclid=y`,
      fetch,
      now: () => FIXED_NOW,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(TGG_URL);
    expect(new Headers(calls[0].init?.headers).get("accept")).toBe("text/html");

    expect(quote.retailerSlug).toBe("the-good-guys");
    expect(quote.retailerName).toBe("The Good Guys");
    expect(quote.url).toBe(TGG_URL);
    expect(quote.method).toBe("json_ld");
    expect(quote.fetchedAt).toBe(FIXED_NOW);
    expect(quote.observedAt).toBe(FIXED_NOW);
    expect(quote.condition).toBe("new");
    expect(quote.provenance).toEqual({ kind: "live", via: null });
    expect(quote.confidence).toBe(1);
    expect(quote.evidence).toBeNull();
    // The page states shippingDetails with delivery times but no shippingRate.
    expect(quote.shippingCents).toBeNull();
    expect(quote.title).toBe('Samsung 65" OLED S85H 4K Smart AI TV 2026');
    expect(quote.priceCents).toBe(279500);
    expect(quote.strikethroughCents).toBe(329500);
    expect(quote.currency).toBe("AUD");
    expect(quote.availability).toBe("in_stock");
    expect(quote.identifiers).toEqual({
      gtin: "08806097962670",
      mpn: "QA65S85HAEXXY",
      retailerSku: "50098484",
    });
    expect(quote.raw).toMatchObject({ "@type": "Product", sku: "50098484" });
  });

  it("reads the Samsung fixture, whose bare inStock token and model-code SKU are kept as seen", async () => {
    const { fetch } = fakeFetch(() => new Response(samsung, { status: 200 }));
    const quote = await fetchJsonLdQuote({ retailerSlug: "samsung-au", url: SAMSUNG_URL, fetch });

    expect(quote.url).toBe(SAMSUNG_URL);
    expect(quote.priceCents).toBe(279900);
    expect(quote.strikethroughCents).toBeNull();
    expect(quote.currency).toBe("AUD");
    expect(quote.availability).toBe("in_stock");
    // The page labels the model code as sku and exposes no mpn or model.
    // The quotes service treats a SKU equal to the tracked MPN as an MPN match.
    expect(quote.identifiers).toEqual({
      gtin: null,
      mpn: null,
      retailerSku: "QA65S85HAEXXY",
    });
    expect(quote.fetchedAt).toBeInstanceOf(Date);
    expect(quote.observedAt).toBe(quote.fetchedAt);
    expect(quote.retailerName).toBeNull();
  });

  it("reports unknown condition when the offer has no itemCondition", async () => {
    const page = ldPage({
      "@type": "Product",
      name: "TV",
      offers: { "@type": "Offer", price: "10.00" },
    });
    const { fetch } = fakeFetch(() => new Response(page, { status: 200 }));
    const quote = await fetchJsonLdQuote({ retailerSlug: "x", url: TGG_URL, fetch });
    expect(quote.condition).toBe("unknown");
  });

  it("takes mpn over model when both are present and assumes AUD without a currency", async () => {
    const page = ldPage({
      "@type": "Product",
      name: "TV",
      mpn: "MPN-1",
      model: "MODEL-1",
      offers: { "@type": "Offer", price: "10.00" },
    });
    const { fetch } = fakeFetch(() => new Response(page, { status: 200 }));
    const quote = await fetchJsonLdQuote({ retailerSlug: "x", url: TGG_URL, fetch });
    expect(quote.identifiers.mpn).toBe("MPN-1");
    expect(quote.currency).toBe("AUD");
    expect(quote.priceCents).toBe(1000);
  });

  it("reads the shipping rate when the offer carries shippingDetails", async () => {
    const page = ldPage({
      "@type": "Product",
      name: "TV",
      offers: {
        "@type": "Offer",
        price: "10.00",
        shippingDetails: { "@type": "OfferShippingDetails", shippingRate: { value: "5.00" } },
      },
    });
    const { fetch } = fakeFetch(() => new Response(page, { status: 200 }));
    const quote = await fetchJsonLdQuote({ retailerSlug: "x", url: TGG_URL, fetch });
    expect(quote.shippingCents).toBe(500);
  });

  it("throws unparseable when the page has no Product", async () => {
    const page = ldPage({ "@type": "Organization", name: "Shop" });
    const { fetch } = fakeFetch(() => new Response(page, { status: 200 }));
    const error = await sourceErrorFrom(
      fetchJsonLdQuote({ retailerSlug: "x", url: TGG_URL, fetch }),
    );
    expect(error.kind).toBe("unparseable");
    expect(error.retailerSlug).toBe("x");
  });

  it("throws unparseable when the Product has no offers", async () => {
    const page = ldPage({ "@type": "Product", name: "TV", sku: "1" });
    const { fetch } = fakeFetch(() => new Response(page, { status: 200 }));
    const error = await sourceErrorFrom(
      fetchJsonLdQuote({ retailerSlug: "x", url: TGG_URL, fetch }),
    );
    expect(error.kind).toBe("unparseable");
  });

  it("throws blocked with status 403 on the Bing Lee DataDome response", async () => {
    const { fetch } = fakeFetch(() => new Response(bingLee, { status: 403 }));
    const error = await sourceErrorFrom(
      fetchJsonLdQuote({ retailerSlug: "bing-lee", url: BING_LEE_URL, fetch }),
    );
    expect(error.kind).toBe("blocked");
    expect(error.status).toBe(403);
    expect(error.retailerSlug).toBe("bing-lee");
  });
});

describe("quoteFromJsonLdHtml", () => {
  const OBSERVED = new Date("2026-05-14T02:51:41.000Z");
  const context = {
    pageUrl: TGG_URL,
    method: "wayback" as const,
    input: { retailerSlug: "the-good-guys", retailerName: "The Good Guys" },
    fetchedAt: FIXED_NOW,
    observedAt: OBSERVED,
    provenance: { kind: "archive" as const, via: `https://web.archive.org/web/1id_/${TGG_URL}` },
    confidence: 0.9,
  };

  it("maps the page with the context's method, dates, provenance and confidence", () => {
    const quote = quoteFromJsonLdHtml(theGoodGuys, context);
    expect(quote.method).toBe("wayback");
    expect(quote.fetchedAt).toBe(FIXED_NOW);
    expect(quote.observedAt).toBe(OBSERVED);
    expect(quote.provenance).toEqual(context.provenance);
    expect(quote.confidence).toBe(0.9);
    expect(quote.evidence).toBeNull();
    expect(quote.retailerName).toBe("The Good Guys");
    expect(quote.priceCents).toBe(279500);
    expect(quote.condition).toBe("new");
  });

  it("throws unparseable when the page has no Product or no price", () => {
    expect(() => quoteFromJsonLdHtml("<html></html>", context)).toThrowError(SourceError);
    const noPrice = ldPage({ "@type": "Product", name: "TV" });
    try {
      quoteFromJsonLdHtml(noPrice, context);
    } catch (error) {
      expect(error).toBeInstanceOf(SourceError);
      expect((error as SourceError).kind).toBe("unparseable");
      expect((error as SourceError).message).toContain("no readable price");
    }
  });
});
