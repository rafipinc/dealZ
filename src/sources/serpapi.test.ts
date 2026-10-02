import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ENTITY_CONFIDENCE,
  FALLBACK_CONFIDENCE,
  MAX_CANDIDATES,
  SERPAPI_ACCOUNT_ENDPOINT,
  SERPAPI_ENDPOINT,
  fetchSerpApiAccount,
  isCandidate,
  readSearchCondition,
  readShippingCents,
  readStoreAvailability,
  redactApiKey,
  searchGoogleShopping,
  serpApiAccountUrl,
  serpApiImmersiveUrl,
  serpApiRequestUrl,
  storesVerify,
} from "./serpapi";
import { SourceError, type FetchLike, type SearchSourceInput, type SourceCall } from "./types";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

const shoppingBody = fixture("serpapi-google-shopping-s85h.json");
const immersiveBody = fixture("serpapi-immersive-s85h-65.json");
const shopping = JSON.parse(shoppingBody) as {
  shopping_results: Record<string, unknown>[];
};

const API_KEY = "sk-test-0123456789abcdef";
const QUERY = "Samsung QA65S85HAEXXY";
const MUST_MATCH = ["S85H"];
const VERIFY = ["65", "QA65S85HAEXXY"];
const FIXED_NOW = new Date("2026-09-28T02:15:41.000Z");
/** The Good Guys result, position 4: the right entity, token TOKEN-4. */
const TGG_RESULT = shopping.shopping_results[3];
const TGG_PRODUCT_LINK = TGG_RESULT.product_link as string;

type Call = { url: string; init?: RequestInit };
type Responder = (url: string) => Response | Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Routes by engine: hop 1 gets `shopping`, hop 2 gets `immersive` keyed by
 * page_token. Defaults replay the recorded pair, TOKEN-4 being the only
 * token hop 2 knows.
 */
function fakeFetch(
  handlers: {
    shopping?: Responder;
    immersive?: Record<string, Responder>;
  } = {},
) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const params = new URL(url).searchParams;
    const engine = params.get("engine");
    if (engine === "google_shopping") {
      return (handlers.shopping ?? (() => new Response(shoppingBody, { status: 200 })))(url);
    }
    if (engine === "google_immersive_product") {
      const token = params.get("page_token") ?? "";
      const byToken = handlers.immersive ?? {
        "TOKEN-4": () => new Response(immersiveBody, { status: 200 }),
      };
      const respond = byToken[token];
      if (respond === undefined) throw new Error(`No hop-2 fixture for ${token}`);
      return respond(url);
    }
    throw new Error(`Unexpected engine: ${engine}`);
  };
  return { fetch, calls };
}

function tokensRequested(calls: Call[]): string[] {
  return calls
    .map((call) => new URL(call.url).searchParams.get("page_token"))
    .filter((token): token is string => token !== null);
}

function inputWith(fetch: FetchLike, patch: Partial<SearchSourceInput> = {}): SearchSourceInput {
  return {
    query: QUERY,
    mustMatch: MUST_MATCH,
    verifyTokens: VERIFY,
    region: "AU",
    apiKey: API_KEY,
    fetch,
    now: () => FIXED_NOW,
    ...patch,
  };
}

/** A hop-1 result with the S85H title and an optional token. */
function result(position: number, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    position,
    title: "OLED S85H 4K Samsung AI Smart TV",
    product_link: `https://www.google.com.au/shopping/product/${position}?gl=au`,
    source: `Seller ${position}`,
    price: `$${position},000.00`,
    extracted_price: position * 1000,
    ...patch,
  };
}

/** A hop-2 body whose stores all carry `size` in their titles. */
function entityOf(size: string, count = 4): unknown {
  return {
    product_results: {
      stores: Array.from({ length: count }, (_, i) => ({
        name: `Store ${i}`,
        link: `https://store${i}.example.com.au/tv`,
        title: `Samsung ${size}" OLED S85H`,
        extracted_price: 1000 + i,
      })),
    },
  };
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

describe("serpApiRequestUrl", () => {
  it("asks google.com.au for au and google.com elsewhere, with the region lower-cased", () => {
    const au = new URL(serpApiRequestUrl(QUERY, "AU", API_KEY));
    expect(au.origin + au.pathname).toBe(SERPAPI_ENDPOINT);
    expect(au.searchParams.get("engine")).toBe("google_shopping");
    expect(au.searchParams.get("q")).toBe(QUERY);
    expect(au.searchParams.get("gl")).toBe("au");
    expect(au.searchParams.get("hl")).toBe("en");
    expect(au.searchParams.get("google_domain")).toBe("google.com.au");
    expect(au.searchParams.get("api_key")).toBe(API_KEY);

    const nz = new URL(serpApiRequestUrl(QUERY, "nz", API_KEY));
    expect(nz.searchParams.get("gl")).toBe("nz");
    expect(nz.searchParams.get("google_domain")).toBe("google.com");
  });
});

describe("serpApiImmersiveUrl", () => {
  it("asks the immersive product engine for every store of the token's entity", () => {
    const url = new URL(serpApiImmersiveUrl("TOKEN-4", API_KEY));
    expect(url.origin + url.pathname).toBe(SERPAPI_ENDPOINT);
    expect(url.searchParams.get("engine")).toBe("google_immersive_product");
    expect(url.searchParams.get("page_token")).toBe("TOKEN-4");
    expect(url.searchParams.get("more_stores")).toBe("true");
    expect(url.searchParams.get("api_key")).toBe(API_KEY);
  });
});

describe("redactApiKey", () => {
  it("replaces the key wherever it sits in the query string", () => {
    expect(redactApiKey(`https://x/?api_key=${API_KEY}&q=a`)).toBe(
      "https://x/?api_key=REDACTED&q=a",
    );
    expect(redactApiKey(`https://x/?q=a&api_key=${API_KEY}`)).toBe(
      "https://x/?q=a&api_key=REDACTED",
    );
    expect(redactApiKey("https://x/?q=a")).toBe("https://x/?q=a");
  });
});

describe("readSearchCondition", () => {
  it("defaults to new and reads refurbished or used from the condition, tag or title", () => {
    expect(readSearchCondition({ title: "Samsung 65 S85H" })).toBe("new");
    expect(readSearchCondition({ title: "TV", second_hand_condition: "Refurbished" })).toBe(
      "refurbished",
    );
    expect(readSearchCondition({ title: "TV", tag: "USED" })).toBe("used");
    expect(readSearchCondition({ title: "Samsung TV Pre-Owned" })).toBe("used");
    expect(readSearchCondition({ title: "Samsung TV - Refurb" })).toBe("refurbished");
    expect(readSearchCondition({ title: "Focused TV stand" })).toBe("new");
  });
});

describe("readStoreAvailability", () => {
  it("reads in stock and out of stock from the details, case-insensitively", () => {
    expect(readStoreAvailability(["In stock online", "Delivery $59"])).toBe("in_stock");
    expect(readStoreAvailability(["OUT OF STOCK"])).toBe("out_of_stock");
    expect(readStoreAvailability(["Contact for online availability"])).toBe("unknown");
    expect(readStoreAvailability(undefined)).toBe("unknown");
  });
});

describe("readShippingCents", () => {
  it("takes the extracted figure, then Free as 0, then the text, then null", () => {
    expect(readShippingCents({ shipping: "+ $59.00", shipping_extracted: 59 })).toBe(5900);
    expect(readShippingCents({ shipping: "Free" })).toBe(0);
    expect(readShippingCents({ shipping: "+ $43.75" })).toBe(4375);
    expect(readShippingCents({})).toBeNull();
  });
});

describe("isCandidate", () => {
  const input = { mustMatch: MUST_MATCH, verifyTokens: VERIFY };

  it("needs every mustMatch token in the title, case-insensitively", () => {
    expect(isCandidate("OLED S85H 4K Samsung AI Smart TV", input)).toBe(true);
    expect(isCandidate("oled s85h 4k", input)).toBe(true);
    expect(isCandidate("Samsung OLED S85F 4K Vision AI Smart TV", input)).toBe(false);
    expect(isCandidate("Anything", { mustMatch: [], verifyTokens: [] })).toBe(true);
  });

  it("rejects a title carrying a model code that is not one of the verify tokens", () => {
    expect(isCandidate("Samsung QE48S85HAEXZT TV 121.9 cm 4K", input)).toBe(false);
    expect(isCandidate("Samsung QA65S85HAEXXY 65 S85H", input)).toBe(true);
    expect(
      isCandidate("Samsung qa65s85haexxy S85H", { ...input, verifyTokens: ["QA65S85HAEXXY"] }),
    ).toBe(true);
  });
});

describe("storesVerify", () => {
  it("accepts when at least half the stores name the variant, and never an empty list", () => {
    const store = (title: string) => ({ name: "S", title });
    expect(storesVerify([store('65" S85H'), store("55 S85H")], ["65"])).toBe(true);
    expect(storesVerify([store('65" S85H'), store("55"), store("55")], ["65"])).toBe(false);
    expect(storesVerify([{ name: "Samsung 65 outlet" }], ["65"])).toBe(true);
    expect(storesVerify([], ["65"])).toBe(false);
    expect(storesVerify([store("65")], [])).toBe(false);
  });
});

describe("searchGoogleShopping", () => {
  it("reads the recorded pair into thirteen store quotes, cheapest first", async () => {
    const { fetch, calls } = fakeFetch();
    const quotes = await searchGoogleShopping(inputWith(fetch));

    expect(calls).toHaveLength(2);
    const hop1 = new URL(calls[0].url);
    expect(hop1.searchParams.get("engine")).toBe("google_shopping");
    expect(hop1.searchParams.get("q")).toBe(QUERY);
    expect(hop1.searchParams.get("gl")).toBe("au");
    expect(hop1.searchParams.get("google_domain")).toBe("google.com.au");
    expect(hop1.searchParams.get("api_key")).toBe(API_KEY);
    expect(new Headers(calls[0].init?.headers).get("accept")).toBe("application/json");
    const hop2 = new URL(calls[1].url);
    expect(hop2.searchParams.get("engine")).toBe("google_immersive_product");
    expect(hop2.searchParams.get("page_token")).toBe("TOKEN-4");
    expect(hop2.searchParams.get("more_stores")).toBe("true");
    expect(hop2.searchParams.get("api_key")).toBe(API_KEY);

    expect(quotes).toHaveLength(13);
    expect(quotes.map((q) => q.priceCents)).toEqual(
      [...quotes.map((q) => q.priceCents)].sort((a, b) => a - b),
    );
    expect(quotes.slice(0, 2).map((q) => [q.retailerSlug, q.priceCents])).toEqual([
      ["appliance-central", 238800],
      ["powerland", 238800],
    ]);
    expect(quotes.every((q) => q.method === "serpapi_google_shopping")).toBe(true);
    expect(quotes.every((q) => q.currency === "AUD")).toBe(true);
    expect(quotes.every((q) => q.confidence === ENTITY_CONFIDENCE)).toBe(true);
    expect(quotes.every((q) => q.fetchedAt === FIXED_NOW && q.observedAt === FIXED_NOW)).toBe(true);
    expect(quotes.every((q) => q.provenance.kind === "search")).toBe(true);
    expect(quotes.every((q) => q.provenance.via === TGG_PRODUCT_LINK)).toBe(true);
    expect(quotes.every((q) => q.evidence === q.title && q.title !== null)).toBe(true);
    expect(quotes.every((q) => q.condition === "new")).toBe(true);
  });

  it("reads price, strikethrough and shipping from each store", async () => {
    const { fetch } = fakeFetch();
    const quotes = await searchGoogleShopping(inputWith(fetch));
    const by = (slug: string) => quotes.filter((q) => q.retailerSlug === slug);

    const [hn] = by("harvey-norman-australia");
    expect(hn.retailerName).toBe("Harvey Norman Australia");
    expect(hn.priceCents).toBe(278800);
    expect(hn.strikethroughCents).toBe(329500);
    expect(hn.shippingCents).toBe(5900);
    expect(hn.availability).toBe("in_stock");
    expect(hn.identifiers).toEqual({ gtin: null, mpn: null, retailerSku: null });

    const [bingLee] = by("bing-lee-electrics");
    expect(bingLee.priceCents).toBe(279500);
    expect(bingLee.shippingCents).toBe(4000);
    expect(bingLee.identifiers.mpn).toBe("QA65S85HAEXXY");

    const ebay = by("ebay");
    expect(ebay).toHaveLength(2);
    expect(ebay.map((q) => q.shippingCents)).toEqual([19000, 19000]);
    expect(ebay.map((q) => q.availability)).toEqual(["in_stock", "unknown"]);

    expect(by("appliance-central")[0].shippingCents).toBe(0);
    expect(by("billy-guyatts")[0].shippingCents).toBeNull();
    expect(by("billy-guyatts")[0].strikethroughCents).toBeNull();
    expect(by("countdowndeals-com-au")[0].shippingCents).toBe(4375);
  });

  it("canonicalises store links and keeps the store, without its logo, as raw", async () => {
    const { fetch } = fakeFetch();
    const quotes = await searchGoogleShopping(inputWith(fetch));

    const tgg = quotes.find((q) => q.retailerSlug === "the-good-guys");
    expect(tgg?.url).toBe(
      "https://www.thegoodguys.com.au/samsung-65-inches-oled-s85h-4k-smart-ai-tv-2026-qa65s85haexxy",
    );
    expect(tgg?.url).not.toContain("srsltid");
    expect(tgg?.title).toBe("Samsung 65-inch OLED S85H 4K UHD Smart AI TV 2026 - QA65S85HAEXXY");
    expect(tgg?.evidence).toBe(tgg?.title);

    const countdown = quotes.find((q) => q.retailerSlug === "countdowndeals-com-au");
    expect(countdown?.url).not.toContain("utm_");
    expect(countdown?.url).toContain("variant=47695047819517");

    const raw = tgg?.raw as Record<string, unknown>;
    expect(raw.name).toBe("The Good Guys");
    expect(raw.extracted_price).toBe(2795);
    expect(raw).not.toHaveProperty("product_results");
    expect(raw).not.toHaveProperty("search_metadata");
    expect(JSON.stringify(quotes)).not.toContain(API_KEY);
  });

  it("drops the logo from raw and falls back to the Google product link when the store link is not http", async () => {
    const { fetch } = fakeFetch({
      shopping: () =>
        jsonResponse({ shopping_results: [result(1, { immersive_product_page_token: "T" })] }),
      immersive: {
        T: () =>
          jsonResponse({
            product_results: {
              stores: [
                {
                  name: "Shop & Co",
                  link: "shopping://item/1",
                  title: 'Samsung 65" OLED S85H',
                  logo: "https://serpapi.com/logo.png",
                  price: "$2,000.00",
                },
                { name: "No price", title: "65", link: "https://x.example/" },
              ],
            },
          }),
      },
    });
    const quotes = await searchGoogleShopping(inputWith(fetch));
    expect(quotes).toHaveLength(1);
    expect(quotes[0].retailerSlug).toBe("shop-and-co");
    expect(quotes[0].priceCents).toBe(200000);
    expect(quotes[0].url).toBe("https://www.google.com.au/shopping/product/1?gl=au");
    expect(quotes[0].raw).not.toHaveProperty("logo");
    expect(quotes[0].raw).toHaveProperty("link", "shopping://item/1");
  });

  it("never treats the 48-inch EU result as a candidate, even when the accepted entity comes later", async () => {
    const { fetch, calls } = fakeFetch({
      immersive: {
        "TOKEN-4": () => new Response(immersiveBody, { status: 200 }),
        "TOKEN-1": () => jsonResponse(entityOf("77")),
        "TOKEN-2": () => jsonResponse(entityOf("77")),
        "TOKEN-5": () => jsonResponse(entityOf("77")),
      },
    });
    // With nothing to match on, every result but the EU model is a candidate.
    const quotes = await searchGoogleShopping(inputWith(fetch, { mustMatch: [] }));
    expect(tokensRequested(calls)).not.toContain("TOKEN-3");
    expect(tokensRequested(calls)).toEqual(["TOKEN-1", "TOKEN-2", "TOKEN-4"]);
    expect(quotes).toHaveLength(13);
  });

  it("rejects an entity whose stores fail verification and tries the next candidate", async () => {
    const { fetch, calls } = fakeFetch({
      shopping: () =>
        jsonResponse({
          shopping_results: [
            result(1, { immersive_product_page_token: "WRONG-SIZE" }),
            result(2, { immersive_product_page_token: "TOKEN-4" }),
          ],
        }),
      immersive: {
        "WRONG-SIZE": () => jsonResponse(entityOf("55")),
        "TOKEN-4": () => new Response(immersiveBody, { status: 200 }),
      },
    });
    const quotes = await searchGoogleShopping(inputWith(fetch));
    expect(tokensRequested(calls)).toEqual(["WRONG-SIZE", "TOKEN-4"]);
    expect(quotes).toHaveLength(13);
    expect(
      quotes.every(
        (q) => q.provenance.via === "https://www.google.com.au/shopping/product/2?gl=au",
      ),
    ).toBe(true);
  });

  it("stops at the first accepted entity and tries at most three candidates", async () => {
    const { fetch, calls } = fakeFetch({
      shopping: () =>
        jsonResponse({
          shopping_results: [1, 2, 3, 4].map((n) =>
            result(n, { immersive_product_page_token: `T${n}` }),
          ),
        }),
      immersive: {
        T1: () => jsonResponse(entityOf("55")),
        T2: () => jsonResponse(entityOf("55")),
        T3: () => jsonResponse(entityOf("55")),
        T4: () => jsonResponse(entityOf("65")),
      },
    });
    const quotes = await searchGoogleShopping(inputWith(fetch));
    expect(MAX_CANDIDATES).toBe(3);
    expect(tokensRequested(calls)).toEqual(["T1", "T2", "T3"]);
    // Nothing accepted: hop-1 results, unverified.
    expect(quotes).toHaveLength(4);
    expect(quotes.every((q) => q.confidence === FALLBACK_CONFIDENCE)).toBe(true);

    const accepted = fakeFetch({
      shopping: () =>
        jsonResponse({
          shopping_results: [1, 2].map((n) => result(n, { immersive_product_page_token: `T${n}` })),
        }),
      immersive: {
        T1: () => jsonResponse(entityOf("65")),
        T2: () => {
          throw new Error("must not be called");
        },
      },
    });
    const first = await searchGoogleShopping(inputWith(accepted.fetch));
    expect(tokensRequested(accepted.calls)).toEqual(["T1"]);
    expect(first).toHaveLength(4);
  });

  it("moves on when hop 2 fails for one candidate and another answers", async () => {
    const { fetch, calls } = fakeFetch({
      shopping: () =>
        jsonResponse({
          shopping_results: [
            result(1, { immersive_product_page_token: "BROKEN" }),
            result(2, { immersive_product_page_token: "NOT-JSON" }),
            result(3, { immersive_product_page_token: "TOKEN-4" }),
          ],
        }),
      immersive: {
        BROKEN: () => new Response("error", { status: 500 }),
        "NOT-JSON": () => new Response("<html>oops</html>", { status: 200 }),
        "TOKEN-4": () => new Response(immersiveBody, { status: 200 }),
      },
    });
    const quotes = await searchGoogleShopping(inputWith(fetch));
    expect(tokensRequested(calls)).toEqual(["BROKEN", "NOT-JSON", "TOKEN-4"]);
    expect(quotes).toHaveLength(13);
  });

  it("falls back to hop-1 results when hop 2 fails for some candidates and rejects the rest", async () => {
    const { fetch } = fakeFetch({
      shopping: () =>
        jsonResponse({
          shopping_results: [
            result(1, { immersive_product_page_token: "BROKEN" }),
            result(2, { immersive_product_page_token: "WRONG-SIZE" }),
          ],
        }),
      immersive: {
        BROKEN: () => new Response("error", { status: 500 }),
        "WRONG-SIZE": () => jsonResponse(entityOf("55")),
      },
    });
    const quotes = await searchGoogleShopping(inputWith(fetch));
    expect(quotes).toHaveLength(2);
    expect(quotes.every((q) => q.confidence === FALLBACK_CONFIDENCE)).toBe(true);
  });

  it("throws the last hop-2 error, without the key, when every candidate fails", async () => {
    const { fetch } = fakeFetch({
      shopping: () =>
        jsonResponse({
          shopping_results: [
            result(1, { immersive_product_page_token: "BROKEN" }),
            result(2, { immersive_product_page_token: "REFUSED" }),
          ],
        }),
      immersive: {
        BROKEN: () => new Response("error", { status: 500 }),
        REFUSED: () => jsonResponse({ error: "Your account has run out of searches." }),
      },
    });
    const error = await sourceErrorFrom(searchGoogleShopping(inputWith(fetch)));
    expect(error.kind).toBe("http");
    expect(error.retailerSlug).toBe("serpapi");
    expect(error.message).toContain("run out of searches");
    expect(error.message).not.toContain(API_KEY);
  });

  it("falls back to hop-1 mapping at confidence 0.5 when no candidate carries a token", async () => {
    const { fetch, calls } = fakeFetch({
      shopping: () =>
        jsonResponse({
          shopping_results: [
            result(2, {
              source: "JB Hi-Fi",
              title: 'Samsung 65" S85H OLED 4K Smart AI TV [2026]',
              link: "https://www.jbhifi.com.au/products/samsung-65-s85h?srsltid=AfmBOoq1",
              old_price: "$3,295.00",
              extracted_old_price: 3295,
              delivery: "Free delivery",
              thumbnail: "https://serpapi.com/thumb.png",
            }),
            result(1, { title: "Samsung 65 S85H QA65S85HAEXXY", tag: "Refurbished" }),
            result(3, { title: "Samsung OLED S85F 4K Vision AI Smart TV" }),
            result(4, { title: "Samsung QE48S85HAEXZT TV 4K" }),
            { source: "No title", extracted_price: 5 },
            { title: "S85H no source", extracted_price: 5 },
            "not an object",
          ],
        }),
    });
    const quotes = await searchGoogleShopping(inputWith(fetch));

    expect(calls).toHaveLength(1);
    expect(quotes.map((q) => [q.retailerSlug, q.priceCents])).toEqual([
      ["seller-1", 100000],
      ["jb-hi-fi", 200000],
    ]);
    expect(quotes.every((q) => q.confidence === FALLBACK_CONFIDENCE)).toBe(true);
    expect(quotes.every((q) => q.availability === "unknown")).toBe(true);
    expect(quotes.every((q) => q.evidence === q.title)).toBe(true);

    const [refurb, jb] = quotes;
    expect(refurb.condition).toBe("refurbished");
    expect(refurb.identifiers.mpn).toBe("QA65S85HAEXXY");
    expect(refurb.shippingCents).toBeNull();

    // The URL is the Google product link, not the seller link.
    expect(jb.url).toBe("https://www.google.com.au/shopping/product/2?gl=au");
    expect(jb.provenance).toEqual({
      kind: "search",
      via: "https://www.google.com.au/shopping/product/2?gl=au",
    });
    expect(jb.strikethroughCents).toBe(329500);
    expect(jb.shippingCents).toBe(0);
    expect(jb.condition).toBe("new");
    expect(jb.identifiers.mpn).toBeNull();
    expect(jb.raw).toEqual({
      position: 2,
      title: 'Samsung 65" S85H OLED 4K Smart AI TV [2026]',
      product_link: "https://www.google.com.au/shopping/product/2?gl=au",
      link: "https://www.jbhifi.com.au/products/samsung-65-s85h?srsltid=AfmBOoq1",
      source: "JB Hi-Fi",
      price: "$2,000.00",
      extracted_price: 2000,
      old_price: "$3,295.00",
      extracted_old_price: 3295,
      delivery: "Free delivery",
    });
  });

  it("reads the price string when extracted_price is absent and ignores an old price at or under the price", async () => {
    const { fetch } = fakeFetch({
      shopping: () =>
        jsonResponse({
          shopping_results: [
            { title: "A S85H", source: "Shop A", price: "$1,234.50", old_price: "$1,234.50" },
            { title: "B S85H", source: "Shop B", price: "$999.00", extracted_old_price: 1299 },
            { title: "C S85H", source: "Shop C", price: "call us" },
          ],
        }),
    });
    const quotes = await searchGoogleShopping(inputWith(fetch));
    expect(quotes.map((q) => [q.retailerSlug, q.priceCents, q.strikethroughCents])).toEqual([
      ["shop-b", 99900, 129900],
      ["shop-a", 123450, null],
    ]);
  });

  it("uses the Google Shopping page, a placeholder slug and the region code when the item says little", async () => {
    const { fetch } = fakeFetch({
      shopping: () =>
        jsonResponse({ shopping_results: [{ title: "A", source: "***", extracted_price: 10 }] }),
    });
    const [quote] = await searchGoogleShopping(inputWith(fetch, { region: "nz", mustMatch: [] }));
    expect(quote.retailerSlug).toBe("unknown-seller");
    expect(quote.retailerName).toBe("***");
    expect(quote.url).toBe("https://www.google.com/shopping");
    expect(quote.provenance).toEqual({ kind: "search", via: null });
    expect(quote.currency).toBe("NZ");
  });

  it("returns an empty array when shopping_results is empty or missing", async () => {
    const { fetch: empty, calls } = fakeFetch({
      shopping: () => jsonResponse({ shopping_results: [] }),
    });
    const { fetch: missing } = fakeFetch({
      shopping: () => jsonResponse({ search_metadata: { status: "Success" } }),
    });
    expect(await searchGoogleShopping(inputWith(empty))).toEqual([]);
    expect(await searchGoogleShopping(inputWith(missing))).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("returns an empty array when the accepted entity has no store with a price", async () => {
    const { fetch } = fakeFetch({
      shopping: () =>
        jsonResponse({ shopping_results: [result(1, { immersive_product_page_token: "T" })] }),
      immersive: {
        T: () =>
          jsonResponse({ product_results: { stores: [{ name: "S", title: "65", price: "n/a" }] } }),
      },
    });
    expect(await searchGoogleShopping(inputWith(fetch))).toEqual([]);
  });

  it("throws http with the message when the hop-1 payload carries an error", async () => {
    const { fetch } = fakeFetch({
      shopping: () => jsonResponse({ error: "Google hasn't returned any results for this query." }),
    });
    const error = await sourceErrorFrom(searchGoogleShopping(inputWith(fetch)));
    expect(error.kind).toBe("http");
    expect(error.retailerSlug).toBe("serpapi");
    expect(error.message).toContain("Google hasn't returned any results");
  });

  it("throws http on a 401 without the key in the message", async () => {
    const { fetch } = fakeFetch({
      shopping: () => jsonResponse({ error: "Invalid API key" }, 401),
    });
    const error = await sourceErrorFrom(searchGoogleShopping(inputWith(fetch)));
    expect(error.kind).toBe("http");
    expect(error.status).toBe(401);
    expect(error.message).not.toContain(API_KEY);
    expect(error.message).toContain("api_key=REDACTED");
  });

  it("throws network without the key in the message when fetch rejects", async () => {
    const cause = new Error("ECONNRESET");
    const fetch: FetchLike = async () => {
      throw cause;
    };
    const error = await sourceErrorFrom(searchGoogleShopping(inputWith(fetch)));
    expect(error.kind).toBe("network");
    expect(error.message).not.toContain(API_KEY);
    expect(error.cause).toBe(cause);
  });

  it("throws unparseable without the key when the body is not JSON or has the wrong shape", async () => {
    const { fetch: notJson } = fakeFetch({
      shopping: () => new Response("<html>oops</html>", { status: 200 }),
    });
    const { fetch: wrongShape } = fakeFetch({ shopping: () => jsonResponse([1, 2, 3]) });
    const a = await sourceErrorFrom(searchGoogleShopping(inputWith(notJson)));
    const b = await sourceErrorFrom(searchGoogleShopping(inputWith(wrongShape)));
    expect(a.kind).toBe("unparseable");
    expect(b.kind).toBe("unparseable");
    expect(a.message).not.toContain(API_KEY);
    expect(b.message).not.toContain(API_KEY);
  });

  it("never records the key in a quote or a hop-2 error", async () => {
    const { fetch } = fakeFetch({
      shopping: () =>
        jsonResponse({ shopping_results: [result(1, { immersive_product_page_token: "BROKEN" })] }),
      immersive: { BROKEN: () => new Response("no", { status: 503 }) },
    });
    const error = await sourceErrorFrom(searchGoogleShopping(inputWith(fetch)));
    expect(error.status).toBe(503);
    expect(error.message).not.toContain(API_KEY);
    expect(error.message).toContain("api_key=REDACTED");
    expect(error.message).toContain("page_token=BROKEN");

    const { fetch: good } = fakeFetch();
    const quotes = await searchGoogleShopping(inputWith(good));
    expect(JSON.stringify(quotes)).not.toContain(API_KEY);
    expect(quotes.every((q) => !q.url.includes("api_key"))).toBe(true);
  });
});

describe("searchGoogleShopping metering", () => {
  /** An input whose meter collects, with a clock that advances 700 ms a read. */
  function metered(fetch: FetchLike, patch: Partial<SearchSourceInput> = {}) {
    const calls: SourceCall[] = [];
    let reads = 0;
    const input = inputWith(fetch, {
      now: () => new Date(FIXED_NOW.getTime() + 700 * reads++),
      meter: (call) => void calls.push(call),
      ...patch,
    });
    return { input, calls };
  }

  it("reports one call per hop for the recorded pair, with no retailer, model or tokens", async () => {
    const { fetch, calls: requests } = fakeFetch();
    const { input, calls } = metered(fetch);
    await searchGoogleShopping(input);

    expect(requests).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.operation)).toEqual([
      "google_shopping",
      "google_immersive_product",
    ]);
    expect(calls[0]).toEqual({
      provider: "serpapi",
      operation: "google_shopping",
      startedAt: FIXED_NOW,
      durationMs: 700,
      outcome: "ok",
      errorKind: null,
      httpStatus: 200,
      model: null,
      inputTokens: null,
      outputTokens: null,
      retailerSlug: null,
    });
  });

  it("reports every hop-2 request, one per candidate tried", async () => {
    const { fetch, calls: requests } = fakeFetch({
      shopping: () =>
        jsonResponse({
          shopping_results: [1, 2, 3].map((n) =>
            result(n, { immersive_product_page_token: `T-${n}` }),
          ),
        }),
      immersive: {
        "T-1": () => jsonResponse(entityOf("55")),
        "T-2": () => jsonResponse({}, 500),
        "T-3": () => jsonResponse(entityOf("65")),
      },
    });
    const { input, calls } = metered(fetch);
    await searchGoogleShopping(input);

    expect(calls).toHaveLength(requests.length);
    expect(calls.map((call) => [call.operation, call.outcome, call.errorKind])).toEqual([
      ["google_shopping", "ok", null],
      ["google_immersive_product", "ok", null],
      ["google_immersive_product", "failed", "http"],
      ["google_immersive_product", "ok", null],
    ]);
    expect(calls[2].httpStatus).toBe(500);
  });

  it("reports an error in a 200 payload as a failed call with the 200", async () => {
    const { fetch } = fakeFetch({ shopping: () => jsonResponse({ error: "Out of searches" }) });
    const { input, calls } = metered(fetch);
    await sourceErrorFrom(searchGoogleShopping(input));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ outcome: "failed", errorKind: "http", httpStatus: 200 });
  });

  it("reports a body that is not JSON as a failed unparseable call", async () => {
    const { fetch } = fakeFetch({ shopping: () => new Response("<html>", { status: 200 }) });
    const { input, calls } = metered(fetch);
    await sourceErrorFrom(searchGoogleShopping(input));
    expect(calls[0]).toMatchObject({
      outcome: "failed",
      errorKind: "unparseable",
      httpStatus: 200,
    });
  });

  it("reports a 401 as http and a rejected fetch as network, never with the key", async () => {
    const denied = metered(fakeFetch({ shopping: () => jsonResponse({}, 401) }).fetch);
    await sourceErrorFrom(searchGoogleShopping(denied.input));
    expect(denied.calls).toHaveLength(1);
    expect(denied.calls[0]).toMatchObject({
      outcome: "failed",
      errorKind: "http",
      httpStatus: 401,
    });

    const down = metered(async (url) => {
      throw new Error(`connect failed for ${url}`);
    });
    await sourceErrorFrom(searchGoogleShopping(down.input));
    expect(down.calls).toHaveLength(1);
    expect(down.calls[0]).toMatchObject({
      outcome: "failed",
      errorKind: "network",
      httpStatus: null,
    });
    expect(JSON.stringify([...denied.calls, ...down.calls])).not.toContain(API_KEY);
  });

  it("never puts the key or a URL in a call", async () => {
    const { input, calls } = metered(fakeFetch().fetch);
    await searchGoogleShopping(input);
    const text = JSON.stringify(calls);
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain("serpapi.com");
  });

  it("returns the quotes even when the meter throws", async () => {
    const { input } = metered(fakeFetch().fetch, {
      meter: () => {
        throw new Error("ledger down");
      },
    });
    expect(await searchGoogleShopping(input)).toHaveLength(13);
  });
});

describe("fetchSerpApiAccount", () => {
  const accountBody = fixture("serpapi-account.json");

  function accountFetch(respond: () => Response | Promise<Response>) {
    const calls: Call[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return respond();
    };
    return { fetch, calls };
  }

  it("builds the account URL with the key as a parameter", () => {
    expect(serpApiAccountUrl("a b&c")).toBe(`${SERPAPI_ACCOUNT_ENDPOINT}?api_key=a+b%26c`);
    expect(redactApiKey(serpApiAccountUrl(API_KEY))).toBe(
      `${SERPAPI_ACCOUNT_ENDPOINT}?api_key=REDACTED`,
    );
  });

  it("reads the plan and what is left of it from the fixture", async () => {
    const { fetch, calls } = accountFetch(() => new Response(accountBody, { status: 200 }));
    const account = await fetchSerpApiAccount({ apiKey: API_KEY, fetch, now: () => FIXED_NOW });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(serpApiAccountUrl(API_KEY));
    expect(account).toEqual({
      planName: "Free Plan",
      searchesPerMonth: 250,
      thisMonthUsage: 38,
      planSearchesLeft: 212,
      totalSearchesLeft: 212,
      fetchedAt: FIXED_NOW,
    });
  });

  it("keeps neither the key nor the account's email", async () => {
    const body = JSON.stringify({
      ...(JSON.parse(accountBody) as Record<string, unknown>),
      api_key: API_KEY,
      account_email: "someone@example.com",
    });
    const { fetch } = accountFetch(() => new Response(body, { status: 200 }));
    const text = JSON.stringify(await fetchSerpApiAccount({ apiKey: API_KEY, fetch }));
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain("someone@example.com");
  });

  it("has no real key or email in its fixture", () => {
    const recorded = JSON.parse(accountBody) as Record<string, unknown>;
    expect(recorded.api_key).toBe("REDACTED");
    expect(recorded.account_email).toBe("redacted@example.com");
  });

  it("reads absent or malformed counts as null", async () => {
    const { fetch } = accountFetch(() =>
      jsonResponse({ plan_name: "Developer", searches_per_month: "many" }),
    );
    const account = await fetchSerpApiAccount({ apiKey: API_KEY, fetch, now: () => FIXED_NOW });
    expect(account).toEqual({
      planName: "Developer",
      searchesPerMonth: null,
      thisMonthUsage: null,
      planSearchesLeft: null,
      totalSearchesLeft: null,
      fetchedAt: FIXED_NOW,
    });
  });

  it("throws unparseable when the answer names no plan", async () => {
    const { fetch } = accountFetch(() => jsonResponse({ account_status: "Active" }));
    const error = await sourceErrorFrom(fetchSerpApiAccount({ apiKey: API_KEY, fetch }));
    expect(error.kind).toBe("unparseable");
    expect(error.retailerSlug).toBe("serpapi");
  });

  it("throws http with SerpApi's message when the payload carries an error", async () => {
    const { fetch } = accountFetch(() => jsonResponse({ error: "Invalid API key." }));
    const error = await sourceErrorFrom(fetchSerpApiAccount({ apiKey: API_KEY, fetch }));
    expect(error.kind).toBe("http");
    expect(error.message).toContain("Invalid API key.");
  });

  it("throws http on a 401 and network on a rejected fetch, never with the key", async () => {
    const denied = await sourceErrorFrom(
      fetchSerpApiAccount({
        apiKey: API_KEY,
        fetch: accountFetch(() => jsonResponse({}, 401)).fetch,
      }),
    );
    expect(denied.kind).toBe("http");
    expect(denied.status).toBe(401);
    expect(denied.message).not.toContain(API_KEY);
    expect(denied.message).toContain("api_key=REDACTED");

    const down = await sourceErrorFrom(
      fetchSerpApiAccount({
        apiKey: API_KEY,
        fetch: async (url) => {
          throw new Error(`connect failed for ${url}`);
        },
      }),
    );
    expect(down.kind).toBe("network");
    expect(down.message).not.toContain(API_KEY);
  });

  it("throws unparseable, without the key, when the body is not JSON", async () => {
    const { fetch } = accountFetch(() => new Response("<html>", { status: 200 }));
    const error = await sourceErrorFrom(fetchSerpApiAccount({ apiKey: API_KEY, fetch }));
    expect(error.kind).toBe("unparseable");
    expect(error.message).not.toContain(API_KEY);
  });

  it("reports one account call to the meter, ok or failed", async () => {
    const calls: SourceCall[] = [];
    const meter = (call: SourceCall) => void calls.push(call);
    const ok = accountFetch(() => new Response(accountBody, { status: 200 }));
    await fetchSerpApiAccount({ apiKey: API_KEY, fetch: ok.fetch, now: () => FIXED_NOW, meter });
    const bad = accountFetch(() => jsonResponse({ error: "Invalid API key." }));
    await sourceErrorFrom(
      fetchSerpApiAccount({ apiKey: API_KEY, fetch: bad.fetch, now: () => FIXED_NOW, meter }),
    );

    expect(calls.map((call) => [call.provider, call.operation, call.outcome])).toEqual([
      ["serpapi", "account", "ok"],
      ["serpapi", "account", "failed"],
    ]);
    expect(JSON.stringify(calls)).not.toContain(API_KEY);
  });
});
