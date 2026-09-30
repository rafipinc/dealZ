import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GEMINI_ENDPOINT } from "../sources/gemini";
import { SERPAPI_ENDPOINT } from "../sources/serpapi";
import { REVIEW_THRESHOLD, type FetchLike } from "../sources/types";
import { AVAILABILITY_ENDPOINT, CDX_ENDPOINT, waybackSnapshotUrl } from "../sources/wayback";
import { NotFoundError, ValidationError } from "./errors";
import {
  extractQuote,
  fetchHistory,
  fetchQuotes,
  searchQuotes,
  type ExtractReport,
  type HistoryPageOk,
  type QuoteOutcomeFailed,
  type QuoteOutcomeOk,
  type SearchReport,
} from "./quotes";
import { trackedVariants } from "./tracked-products";

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../sources/fixtures/${name}`, import.meta.url)),
    "utf8",
  );
}

const jbHiFi = fixture("jbhifi-s85h-65.shopify.json");
const theGoodGuys = fixture("thegoodguys-s85h-65.html");
const samsung = fixture("samsung-au-s85h-65.html");
const bingLee = fixture("binglee-challenge.html");
const googleShopping = fixture("serpapi-google-shopping-s85h.json");
const immersive = fixture("serpapi-immersive-s85h-65.json");
const cdxJbHiFi = fixture("wayback-cdx-jbhifi.json");
const geminiJbHiFi = fixture("gemini-extract-jbhifi.json");
const geminiSamsungDoubt = fixture("gemini-extract-samsung-doubt.json");

const SLUG = "samsung-s85h-65-au";
const variant = trackedVariants.find((candidate) => candidate.slug === SLUG);
if (variant === undefined) throw new Error(`Fixture variant ${SLUG} is missing`);
const pageUrl = (retailerSlug: string): string => {
  const page = variant.pages.find((candidate) => candidate.retailerSlug === retailerSlug);
  if (page === undefined) throw new Error(`No tracked page for ${retailerSlug}`);
  return page.url;
};

const JB_URL = pageUrl("jb-hi-fi");
const JB_JSON_URL = `${JB_URL}.json`;
const TGG_URL = pageUrl("the-good-guys");
const SAMSUNG_URL = pageUrl("samsung-au");
const POWERLAND_URL = pageUrl("powerland");
const TOPTEK_URL = pageUrl("toptek");
const FIXED_NOW = new Date("2026-09-28T01:02:03.000Z");
const GEMINI_KEY = "AIzaSy-test-key-0123456789";

/** A page with one schema.org Product, for the two independents that have no recorded fixture. */
function productPage(product: Record<string, unknown>): string {
  const node = { "@context": "https://schema.org", "@type": "Product", ...product };
  return `<html><body><script type="application/ld+json">${JSON.stringify(node)}</script></body></html>`;
}

/** Powerland: dearer than the chains here so the recorded tie for cheapest stands. */
const powerland = productPage({
  name: 'Samsung 65" S85H 4K Vision AI OLED Smart TV QA65S85HAEXXY',
  sku: "QA65S85HAEXXY",
  offers: { "@type": "Offer", price: "2888.00", priceCurrency: "AUD" },
});
const toptek = productPage({
  name: 'Samsung 65" OLED S85H 4K TV QA65S85HAEXXY',
  gtin13: "8806097962670",
  offers: {
    "@type": "Offer",
    price: "2995.00",
    priceCurrency: "AUD",
    availability: "https://schema.org/OutOfStock",
  },
});

/** A product page with no structured data, whose visible text carries the evidence the recorded JB answer cites. */
const noStructuredData = `<html><head><title>Samsung 65" OLED S85H | Example</title></head>
<body><h1>Samsung 65-inch S85H OLED 4K Smart TV</h1>
<p>Regular price: $3295</p><p>Sale price: $2795</p></body></html>`;

type Call = { url: string; init?: RequestInit };
type Responder = (url: string) => Response | Promise<Response>;

/** Routes by URL substring; the first route whose needle the URL contains answers. */
function fakeFetchBySubstring(routes: [string, Responder][], calls: Call[] = []): FetchLike {
  return async (url, init) => {
    calls.push({ url, init });
    const route = routes.find(([needle]) => url.includes(needle));
    if (route === undefined) throw new Error(`Unexpected request to ${url}`);
    return route[1](url);
  };
}

function html(body: string, status = 200): Responder {
  return () => new Response(body, { status, headers: { "content-type": "text/html" } });
}

function json(body: string, status = 200): Responder {
  return () => new Response(body, { status, headers: { "content-type": "application/json" } });
}

/** A Gemini answer built by hand, in the shape the recorded fixtures have. */
function geminiBody(extracted: unknown): string {
  return JSON.stringify({
    candidates: [{ content: { parts: [{ text: JSON.stringify(extracted) }] }, role: "model" }],
    usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 120 },
    modelVersion: "gemini-3.5-flash-lite",
  });
}

/** The recorded JB answer with its doubts removed: the one change that lifts it to the threshold. */
const jbAnswerWithoutDoubts = geminiBody({
  is_product_page: true,
  product_title: "Samsung 65-inch S85H OLED 4K Smart TV",
  current_price: 2795,
  currency: "AUD",
  was_price: 3295,
  price_evidence: "Sale price: $2795",
  model_code: "QA65S85HAEXXY",
  gtin: null,
  condition_words: [],
  is_bundle: false,
  availability: "unknown",
  doubts: "",
});

function geminiCalls(calls: Call[]): Call[] {
  return calls.filter((call) => call.url.startsWith(GEMINI_ENDPOINT));
}

function apiKeyHeaderOf(call: Call): string | null {
  return new Headers(call.init?.headers).get("x-goog-api-key");
}

const happyRoutes: [string, Responder][] = [
  [JB_JSON_URL, json(jbHiFi)],
  [TGG_URL, html(theGoodGuys)],
  [SAMSUNG_URL, html(samsung)],
  [POWERLAND_URL, html(powerland)],
  [TOPTEK_URL, html(toptek)],
];

/** The Good Guys page has no JSON-LD and the model answers with the recorded JB extraction. */
const modelRoutes: [string, Responder][] = [
  [GEMINI_ENDPOINT, json(geminiJbHiFi)],
  [TGG_URL, html(noStructuredData)],
  ...happyRoutes,
];

function okOutcomes(outcomes: { status: string }[]): QuoteOutcomeOk[] {
  return outcomes.filter((outcome): outcome is QuoteOutcomeOk => outcome.status === "ok");
}

function outcomeFor<T extends { retailerSlug: string }>(outcomes: T[], retailerSlug: string): T {
  const outcome = outcomes.find((candidate) => candidate.retailerSlug === retailerSlug);
  if (outcome === undefined) throw new Error(`No outcome for ${retailerSlug}`);
  return outcome;
}

describe("fetchQuotes", () => {
  // The search layer is off here; "fetchQuotes gap fill" below covers it.
  beforeEach(() => {
    vi.stubEnv("SERPAPI_API_KEY", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports every readable retailer as ok and the blocked ones as skipped", async () => {
    const report = await fetchQuotes({
      slug: SLUG,
      fetch: fakeFetchBySubstring(happyRoutes),
      now: () => FIXED_NOW,
    });

    expect(report.variant).toEqual({
      slug: SLUG,
      displayName: variant.displayName,
      mpn: "QA65S85HAEXXY",
      gtin: "08806097962670",
      rrpCents: 329900,
    });
    expect(report.outcomes).toHaveLength(7);
    expect(report.outcomes.map((outcome) => [outcome.retailerSlug, outcome.status])).toEqual([
      ["jb-hi-fi", "ok"],
      ["the-good-guys", "ok"],
      ["samsung-au", "ok"],
      ["powerland", "ok"],
      ["toptek", "ok"],
      ["harvey-norman", "skipped"],
      ["bing-lee", "skipped"],
    ]);

    const skipped = report.outcomes.filter((outcome) => outcome.status === "skipped");
    expect(skipped).toEqual([
      {
        status: "skipped",
        retailerSlug: "harvey-norman",
        retailerName: "Harvey Norman",
        url: pageUrl("harvey-norman"),
        reason: "Imperva bot challenge answers automated requests. Not fetched.",
      },
      {
        status: "skipped",
        retailerSlug: "bing-lee",
        retailerName: "Bing Lee",
        url: pageUrl("bing-lee"),
        reason: "DataDome returns 403 to automated requests. Not fetched.",
      },
    ]);
  });

  it("marks a page read from structured data as not read by the model and not for review", async () => {
    const report = await fetchQuotes({ slug: SLUG, fetch: fakeFetchBySubstring(happyRoutes) });
    for (const outcome of okOutcomes(report.outcomes)) {
      expect(outcome.readByModel).toBe(false);
      expect(outcome.needsReview).toBe(false);
      expect(outcome.quote.confidence).toBeGreaterThanOrEqual(REVIEW_THRESHOLD);
    }
  });

  it("picks the first of a tied price as cheapest and computes both deltas", async () => {
    const report = await fetchQuotes({ slug: SLUG, fetch: fakeFetchBySubstring(happyRoutes) });
    const [jb, tgg, samsungAu, powerlandAu, toptekAu] = okOutcomes(report.outcomes);

    expect(report.cheapest).toEqual({ retailerSlug: "jb-hi-fi", priceCents: 279500 });

    expect(jb.quote.priceCents).toBe(279500);
    expect(jb.isCheapest).toBe(true);
    expect(jb.deltaFromCheapestCents).toBe(0);
    expect(jb.deltaFromRrpCents).toBe(-50400);

    expect(tgg.quote.priceCents).toBe(279500);
    expect(tgg.isCheapest).toBe(false);
    expect(tgg.deltaFromCheapestCents).toBe(0);
    expect(tgg.deltaFromRrpCents).toBe(-50400);

    expect(samsungAu.quote.priceCents).toBe(279900);
    expect(samsungAu.isCheapest).toBe(false);
    expect(samsungAu.deltaFromCheapestCents).toBe(400);
    expect(samsungAu.deltaFromRrpCents).toBe(-50000);

    expect(powerlandAu.quote.priceCents).toBe(288800);
    expect(powerlandAu.deltaFromCheapestCents).toBe(9300);
    expect(toptekAu.quote.priceCents).toBe(299500);
    expect(toptekAu.quote.availability).toBe("out_of_stock");
    expect(toptekAu.deltaFromRrpCents).toBe(-30400);
  });

  it("reports which tracked identifier each page agreed with", async () => {
    const report = await fetchQuotes({ slug: SLUG, fetch: fakeFetchBySubstring(happyRoutes) });
    expect(okOutcomes(report.outcomes).map((outcome) => outcome.identifierMatch)).toEqual([
      "gtin",
      "gtin",
      "mpn",
      "mpn",
      "gtin",
    ]);
  });

  it("reports none when a page exposes no identifier the variant has", async () => {
    const stranger = productPage({
      name: "Something else",
      sku: "999",
      offers: { "@type": "Offer", price: "1.00", priceCurrency: "AUD" },
    });
    const report = await fetchQuotes({
      slug: SLUG,
      fetch: fakeFetchBySubstring([[TGG_URL, html(stranger)], ...happyRoutes]),
    });
    const tgg = outcomeFor(okOutcomes(report.outcomes), "the-good-guys");
    expect(tgg.identifierMatch).toBe("none");
    expect(tgg.isCheapest).toBe(true);
  });

  it("orders ok outcomes by price, then failed, then skipped", async () => {
    const report = await fetchQuotes({
      slug: SLUG,
      fetch: fakeFetchBySubstring([[JB_JSON_URL, html("", 500)], ...happyRoutes]),
    });
    expect(report.outcomes.map((outcome) => [outcome.retailerSlug, outcome.status])).toEqual([
      ["the-good-guys", "ok"],
      ["samsung-au", "ok"],
      ["powerland", "ok"],
      ["toptek", "ok"],
      ["jb-hi-fi", "failed"],
      ["harvey-norman", "skipped"],
      ["bing-lee", "skipped"],
    ]);
    expect(report.cheapest).toEqual({ retailerSlug: "the-good-guys", priceCents: 279500 });
  });

  it("reports a blocked retailer as failed without hiding the others", async () => {
    const report = await fetchQuotes({
      slug: SLUG,
      fetch: fakeFetchBySubstring([[TGG_URL, html(bingLee, 403)], ...happyRoutes]),
    });
    const failed = report.outcomes.find(
      (outcome): outcome is QuoteOutcomeFailed => outcome.status === "failed",
    );
    expect(failed).toMatchObject({
      retailerSlug: "the-good-guys",
      retailerName: "The Good Guys",
      url: TGG_URL,
      kind: "blocked",
    });
    expect(failed?.message).toContain("403");
    expect(okOutcomes(report.outcomes).map((outcome) => outcome.retailerSlug)).toEqual([
      "jb-hi-fi",
      "samsung-au",
      "powerland",
      "toptek",
    ]);
  });

  it("reports a rejection that is not a SourceError as a network failure", async () => {
    const report = await fetchQuotes({
      slug: SLUG,
      fetch: fakeFetchBySubstring([
        // A fetch that resolves to something that is not a Response.
        [SAMSUNG_URL, () => Promise.resolve(null as unknown as Response)],
        ...happyRoutes,
      ]),
    });
    const failed = report.outcomes.find(
      (outcome): outcome is QuoteOutcomeFailed => outcome.status === "failed",
    );
    expect(failed?.retailerSlug).toBe("samsung-au");
    expect(failed?.kind).toBe("network");
    expect(failed?.message.length).toBeGreaterThan(0);
    expect(okOutcomes(report.outcomes)).toHaveLength(4);
  });

  it("has no cheapest when nothing was readable", async () => {
    const report = await fetchQuotes({
      slug: SLUG,
      fetch: fakeFetchBySubstring([["", html("", 500)]]),
    });
    expect(report.cheapest).toBeNull();
    expect(report.outcomes.map((outcome) => outcome.status)).toEqual([
      "failed",
      "failed",
      "failed",
      "failed",
      "failed",
      "skipped",
      "skipped",
    ]);
  });

  it("stamps the report and every quote with the injected clock", async () => {
    const report = await fetchQuotes({
      slug: SLUG,
      fetch: fakeFetchBySubstring(happyRoutes),
      now: () => FIXED_NOW,
    });
    expect(report.fetchedAt).toBe(FIXED_NOW);
    for (const outcome of okOutcomes(report.outcomes)) {
      expect(outcome.quote.fetchedAt).toBe(FIXED_NOW);
    }
  });

  it("lets the model read a page with no structured data when a key is given, as a candidate for review", async () => {
    const calls: Call[] = [];
    const report = await fetchQuotes({
      slug: SLUG,
      geminiApiKey: GEMINI_KEY,
      fetch: fakeFetchBySubstring(modelRoutes, calls),
      now: () => FIXED_NOW,
    });

    const tgg = outcomeFor(okOutcomes(report.outcomes), "the-good-guys");
    expect(tgg.readByModel).toBe(true);
    expect(tgg.quote.method).toBe("llm_extract");
    expect(tgg.quote.retailerName).toBe("The Good Guys");
    expect(tgg.quote.priceCents).toBe(279500);
    expect(tgg.quote.evidence).toBe("Sale price: $2795");
    // Start 0.6, model code +0.1, doubts stated -0.2: the recorded answer names both prices.
    expect(tgg.quote.confidence).toBe(0.5);
    expect(tgg.needsReview).toBe(true);
    expect(tgg.identifierMatch).toBe("mpn");
    expect(tgg.isCheapest).toBe(false);
    expect(tgg.deltaFromCheapestCents).toBe(0);
    expect(report.cheapest).toEqual({ retailerSlug: "jb-hi-fi", priceCents: 279500 });

    const others = okOutcomes(report.outcomes).filter((o) => o.retailerSlug !== "the-good-guys");
    expect(others.every((outcome) => !outcome.readByModel && !outcome.needsReview)).toBe(true);

    const [gemini] = geminiCalls(calls);
    expect(geminiCalls(calls)).toHaveLength(1);
    expect(apiKeyHeaderOf(gemini)).toBe(GEMINI_KEY);
    expect(JSON.stringify(report)).not.toContain(GEMINI_KEY);
  });

  it("keeps the unparseable failure when no key is given and never calls the model", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const calls: Call[] = [];
    const report = await fetchQuotes({
      slug: SLUG,
      fetch: fakeFetchBySubstring(modelRoutes, calls),
    });

    const tgg = outcomeFor(report.outcomes, "the-good-guys");
    expect(tgg).toMatchObject({ status: "failed", kind: "unparseable" });
    if (tgg.status === "failed") expect(tgg.message).toContain("has no JSON-LD Product");
    expect(geminiCalls(calls)).toHaveLength(0);
    expect(okOutcomes(report.outcomes)).toHaveLength(4);
  });

  it("reads the key from GEMINI_API_KEY when the argument is absent and keeps it out of the report", async () => {
    vi.stubEnv("GEMINI_API_KEY", "env-gemini-key-0123456789");
    const calls: Call[] = [];
    const report = await fetchQuotes({
      slug: SLUG,
      fetch: fakeFetchBySubstring(modelRoutes, calls),
    });

    const tgg = outcomeFor(okOutcomes(report.outcomes), "the-good-guys");
    expect(tgg.readByModel).toBe(true);
    expect(apiKeyHeaderOf(geminiCalls(calls)[0])).toBe("env-gemini-key-0123456789");
    expect(JSON.stringify(report)).not.toContain("env-gemini-key-0123456789");
  });

  it("never lets a model-read outcome below the threshold become cheapest", async () => {
    const report = await fetchQuotes({
      slug: SLUG,
      geminiApiKey: GEMINI_KEY,
      fetch: fakeFetchBySubstring([[JB_JSON_URL, html("", 500)], ...modelRoutes]),
    });

    // The Good Guys at 279500 is the lowest ok price but only a candidate.
    expect(report.outcomes.map((outcome) => [outcome.retailerSlug, outcome.status])).toEqual([
      ["the-good-guys", "ok"],
      ["samsung-au", "ok"],
      ["powerland", "ok"],
      ["toptek", "ok"],
      ["jb-hi-fi", "failed"],
      ["harvey-norman", "skipped"],
      ["bing-lee", "skipped"],
    ]);
    expect(report.cheapest).toEqual({ retailerSlug: "samsung-au", priceCents: 279900 });
    const [tgg, samsungAu] = okOutcomes(report.outcomes);
    expect(tgg.needsReview).toBe(true);
    expect(tgg.isCheapest).toBe(false);
    expect(tgg.deltaFromCheapestCents).toBe(-400);
    expect(samsungAu.isCheapest).toBe(true);
    expect(samsungAu.deltaFromCheapestCents).toBe(0);
  });

  it("has no cheapest and zero deltas when every ok outcome needs review", async () => {
    const report = await fetchQuotes({
      slug: SLUG,
      geminiApiKey: GEMINI_KEY,
      fetch: fakeFetchBySubstring([
        [GEMINI_ENDPOINT, json(geminiJbHiFi)],
        [TGG_URL, html(noStructuredData)],
        ["", html("", 500)],
      ]),
    });
    expect(report.cheapest).toBeNull();
    expect(report.outcomes.map((outcome) => outcome.status)).toEqual([
      "ok",
      "failed",
      "failed",
      "failed",
      "failed",
      "skipped",
      "skipped",
    ]);
    const [tgg] = okOutcomes(report.outcomes);
    expect(tgg.readByModel).toBe(true);
    expect(tgg.needsReview).toBe(true);
    expect(tgg.isCheapest).toBe(false);
    expect(tgg.deltaFromCheapestCents).toBe(0);
  });

  it("lets a model-read outcome at the threshold be cheapest when the model states no doubts", async () => {
    const report = await fetchQuotes({
      slug: SLUG,
      geminiApiKey: GEMINI_KEY,
      fetch: fakeFetchBySubstring([
        [GEMINI_ENDPOINT, json(jbAnswerWithoutDoubts)],
        [JB_JSON_URL, html("", 500)],
        ...modelRoutes,
      ]),
    });
    const tgg = outcomeFor(okOutcomes(report.outcomes), "the-good-guys");
    expect(tgg.readByModel).toBe(true);
    expect(tgg.quote.confidence).toBe(REVIEW_THRESHOLD);
    expect(tgg.needsReview).toBe(false);
    expect(tgg.isCheapest).toBe(true);
    expect(report.cheapest).toEqual({ retailerSlug: "the-good-guys", priceCents: 279500 });
  });

  it("reports a model that answers 429 as a blocked failure for that page only", async () => {
    const report = await fetchQuotes({
      slug: SLUG,
      geminiApiKey: GEMINI_KEY,
      fetch: fakeFetchBySubstring([
        [GEMINI_ENDPOINT, json('{"error":{"message":"quota"}}', 429)],
        ...modelRoutes,
      ]),
    });
    const tgg = outcomeFor(report.outcomes, "the-good-guys");
    expect(tgg).toMatchObject({ status: "failed", kind: "blocked" });
    expect(okOutcomes(report.outcomes)).toHaveLength(4);
    expect(JSON.stringify(report)).not.toContain(GEMINI_KEY);
  });

  it("throws NotFoundError for a slug that is not tracked", async () => {
    await expect(
      fetchQuotes({ slug: "lg-c5-65-au", fetch: fakeFetchBySubstring([]) }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it.each(["", "Samsung S85H", "samsung_s85h", "-leading", "trailing-"])(
    "throws ValidationError for the slug %j",
    async (slug) => {
      await expect(fetchQuotes({ slug, fetch: fakeFetchBySubstring([]) })).rejects.toBeInstanceOf(
        ValidationError,
      );
    },
  );

  it("throws ValidationError when fetch is not a function", async () => {
    const error = await fetchQuotes({ slug: SLUG, fetch: "nope" as unknown as FetchLike }).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe("validation");
    expect((error as ValidationError).issues).toBeDefined();
  });
});

// ---------- searchQuotes ----------

const API_KEY = "sk-test-0123456789abcdef";
/** Hop 1 answers with the recorded shopping results, hop 2 with the recorded stores of the S85H 65-inch entity. */
const searchRoutes: [string, Responder][] = [
  ["engine=google_immersive_product", json(immersive)],
  ["engine=google_shopping", json(googleShopping)],
];

function okQuotes(report: SearchReport) {
  if (report.outcome.status !== "ok") throw new Error(`Expected ok, got ${report.outcome.kind}`);
  return report.outcome;
}

describe("searchQuotes", () => {
  it("never lets a below-threshold fallback quote be the cheapest", async () => {
    // No result carries a stores token, so the source falls back to hop-1 items at 0.5.
    const hop1 = JSON.parse(googleShopping) as { shopping_results: Record<string, unknown>[] };
    for (const item of hop1.shopping_results) delete item.immersive_product_page_token;
    const report = await searchQuotes({
      slug: SLUG,
      apiKey: API_KEY,
      fetch: fakeFetchBySubstring([["engine=google_shopping", json(JSON.stringify(hop1))]]),
    });
    expect(report.outcome.status).toBe("ok");
    if (report.outcome.status === "ok") {
      expect(report.outcome.quotes.length).toBeGreaterThan(0);
      expect(report.outcome.quotes.every((q) => q.needsReview)).toBe(true);
      expect(report.outcome.quotes.some((q) => q.isCheapest)).toBe(false);
      expect(report.outcome.cheapest).toBeNull();
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("lists every store of the verified entity cheapest first and resolves the tracked ones by slug or alias", async () => {
    const calls: Call[] = [];
    const report = await searchQuotes({
      slug: SLUG,
      apiKey: API_KEY,
      fetch: fakeFetchBySubstring(searchRoutes, calls),
      now: () => FIXED_NOW,
    });

    expect(report.variant).toEqual({
      slug: SLUG,
      displayName: variant.displayName,
      mpn: "QA65S85HAEXXY",
      gtin: "08806097962670",
      rrpCents: 329900,
    });
    expect(report.fetchedAt).toBe(FIXED_NOW);
    expect(report.method).toBe("serpapi_google_shopping");
    expect(report.query).toBe("Samsung QA65S85HAEXXY");

    // Two hops: the series picked The Good Guys' entity, the size verified its stores.
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain("page_token=TOKEN-4");

    const { quotes, cheapest } = okQuotes(report);
    expect(quotes).toHaveLength(13);
    expect(quotes.map((entry) => entry.quote.retailerSlug)).toEqual([
      "appliance-central",
      "powerland",
      "videopro",
      "countdowndeals-com-au",
      "harvey-norman-australia",
      "domayne",
      "the-good-guys",
      "bing-lee-electrics",
      "betta",
      "billy-guyatts",
      "qantas-marketplace",
      "ebay",
      "ebay",
    ]);
    expect(quotes.map((entry) => entry.trackedRetailerSlug)).toEqual([
      null,
      "powerland",
      null,
      null,
      "harvey-norman",
      null,
      "the-good-guys",
      "bing-lee",
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(quotes.map((entry) => entry.quote.priceCents)).toEqual([
      238800, 238800, 272700, 276500, 278800, 278800, 279500, 279500, 279500, 279500, 279900,
      289929, 308306,
    ]);
    expect(cheapest).toEqual({ retailerSlug: "appliance-central", priceCents: 238800 });
    for (const entry of quotes) {
      expect(entry.quote.fetchedAt).toBe(FIXED_NOW);
      expect(entry.quote.provenance.kind).toBe("search");
    }
  });

  it("resolves the aggregator's store names to the tracked retailers through their aliases", async () => {
    const report = await searchQuotes({
      slug: SLUG,
      apiKey: API_KEY,
      fetch: fakeFetchBySubstring(searchRoutes),
    });
    const { quotes } = okQuotes(report);
    const byName = (name: string) => {
      const entry = quotes.find((candidate) => candidate.quote.retailerName === name);
      if (entry === undefined) throw new Error(`No store named ${name}`);
      return entry;
    };
    expect(byName("Harvey Norman Australia").trackedRetailerSlug).toBe("harvey-norman");
    expect(byName("Bing Lee Electrics").trackedRetailerSlug).toBe("bing-lee");
    expect(byName("The Good Guys").trackedRetailerSlug).toBe("the-good-guys");
    expect(byName("Powerland").trackedRetailerSlug).toBe("powerland");
    // Neither JB Hi-Fi nor Samsung was in the entity's store list on the day it was recorded.
    const tracked = quotes.map((entry) => entry.trackedRetailerSlug);
    expect(tracked).not.toContain("jb-hi-fi");
    expect(tracked).not.toContain("samsung-au");
    expect(quotes.map((entry) => entry.quote.retailerName)).not.toContain("JB Hi-Fi");
  });

  it("marks the untracked cheapest store, computes both deltas and carries the stated delivery", async () => {
    const report = await searchQuotes({
      slug: SLUG,
      apiKey: API_KEY,
      fetch: fakeFetchBySubstring(searchRoutes),
    });
    const { quotes } = okQuotes(report);

    expect(quotes[0].quote.retailerName).toBe("Appliance Central");
    expect(quotes[0].trackedRetailerSlug).toBeNull();
    expect(quotes.map((entry) => entry.isCheapest)).toEqual([
      true,
      ...Array.from({ length: 12 }, () => false),
    ]);
    expect(quotes.map((entry) => entry.deltaFromCheapestCents)).toEqual([
      0, 0, 33900, 37700, 40000, 40000, 40700, 40700, 40700, 40700, 41100, 51129, 69506,
    ]);
    expect(quotes.map((entry) => entry.deltaFromRrpCents)).toEqual([
      -91100, -91100, -57200, -53400, -51100, -51100, -50400, -50400, -50400, -50400, -50000,
      -39971, -21594,
    ]);
    expect(quotes.map((entry) => entry.quote.shippingCents)).toEqual([
      0,
      0,
      25407,
      4375,
      5900,
      5900,
      5900,
      4000,
      1000,
      null,
      0,
      19000,
      19000,
    ]);
    expect(quotes.every((entry) => entry.quote.condition === "new")).toBe(true);
  });

  it("matches on the model code in the store title and never on a GTIN", async () => {
    const report = await searchQuotes({
      slug: SLUG,
      apiKey: API_KEY,
      fetch: fakeFetchBySubstring(searchRoutes),
    });
    const { quotes } = okQuotes(report);
    expect(quotes.map((entry) => entry.identifierMatch)).toEqual([
      "mpn",
      "mpn",
      "none",
      "mpn",
      "none",
      "none",
      "mpn",
      "mpn",
      "mpn",
      "none",
      "none",
      "none",
      "none",
    ]);
    expect(quotes.every((entry) => entry.quote.identifiers.gtin === null)).toBe(true);
  });

  it("sends the key from the argument on both hops and never puts it in the report", async () => {
    const calls: Call[] = [];
    const report = await searchQuotes({
      slug: SLUG,
      apiKey: API_KEY,
      fetch: fakeFetchBySubstring(searchRoutes, calls),
    });
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.url).toContain(`api_key=${API_KEY}`);
    expect(JSON.stringify(report)).not.toContain(API_KEY);
  });

  it("reads the key from SERPAPI_API_KEY when the argument is absent", async () => {
    vi.stubEnv("SERPAPI_API_KEY", "env-key-0123456789");
    const calls: Call[] = [];
    const report = await searchQuotes({
      slug: SLUG,
      fetch: fakeFetchBySubstring(searchRoutes, calls),
    });
    expect(calls[0].url).toContain("api_key=env-key-0123456789");
    expect(report.outcome.status).toBe("ok");
    expect(JSON.stringify(report)).not.toContain("env-key-0123456789");
  });

  it("throws ValidationError when no key is given and SERPAPI_API_KEY is unset", async () => {
    vi.stubEnv("SERPAPI_API_KEY", "");
    const calls: Call[] = [];
    const error = await searchQuotes({
      slug: SLUG,
      fetch: fakeFetchBySubstring(searchRoutes, calls),
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).message).toBe("SERPAPI_API_KEY is not set");
    expect(calls).toHaveLength(0);
  });

  it("reports a 401 from the aggregator as an http failure without the key", async () => {
    const report = await searchQuotes({
      slug: SLUG,
      apiKey: API_KEY,
      fetch: fakeFetchBySubstring([[SERPAPI_ENDPOINT, html("Unauthorized", 401)]]),
    });
    expect(report.outcome).toMatchObject({ status: "failed", kind: "http" });
    expect(JSON.stringify(report)).not.toContain(API_KEY);
    expect(JSON.stringify(report)).toContain("api_key=REDACTED");
  });

  it("reports a fetch that throws as a network failure", async () => {
    const report = await searchQuotes({
      slug: SLUG,
      apiKey: API_KEY,
      fetch: () => {
        throw new Error("ENOTFOUND serpapi.com");
      },
    });
    expect(report.outcome).toMatchObject({ status: "failed", kind: "network" });
    expect(JSON.stringify(report)).not.toContain(API_KEY);
  });

  it("reports a rejection that is not a SourceError as a network failure", async () => {
    const report = await searchQuotes({
      slug: SLUG,
      apiKey: API_KEY,
      fetch: () => Promise.resolve(null as unknown as Response),
    });
    expect(report.outcome).toMatchObject({ status: "failed", kind: "network" });
    if (report.outcome.status === "failed") {
      expect(report.outcome.message.length).toBeGreaterThan(0);
    }
  });

  it("throws NotFoundError for a slug that is not tracked", async () => {
    await expect(
      searchQuotes({ slug: "lg-c5-65-au", apiKey: API_KEY, fetch: fakeFetchBySubstring([]) }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it.each(["", "Samsung S85H", "samsung_s85h"])(
    "throws ValidationError for the slug %j",
    async (slug) => {
      await expect(
        searchQuotes({ slug, apiKey: API_KEY, fetch: fakeFetchBySubstring([]) }),
      ).rejects.toBeInstanceOf(ValidationError);
    },
  );
});

// ---------- fetchHistory ----------

const JB_TIMESTAMPS = ["20260514025141", "20260608031844", "20260807110400", "20260927050146"];
const ON_SALE_FROM = new Date("2026-04-01T00:00:00.000Z");

/** The CDX request for one tracked page, as the wayback source builds it (no scheme). */
function cdxNeedle(url: string): string {
  return `${CDX_ENDPOINT}?url=${encodeURIComponent(url.replace(/^https?:\/\//, ""))}`;
}

function availabilityNeedle(url: string): string {
  return `${AVAILABILITY_ENDPOINT}?url=${encodeURIComponent(url)}`;
}

/** JB Hi-Fi has four captures, every other page none, and every snapshot is the Good Guys page. */
const historyRoutes: [string, Responder][] = [
  [cdxNeedle(JB_URL), json(cdxJbHiFi)],
  [CDX_ENDPOINT, html("")],
  ["id_/", html(theGoodGuys)],
];

function okPages(pages: { status: string }[]): HistoryPageOk[] {
  return pages.filter((page): page is HistoryPageOk => page.status === "ok");
}

describe("fetchHistory", () => {
  it("reads four archived prices for JB Hi-Fi oldest first and none for pages never captured", async () => {
    const report = await fetchHistory({
      slug: SLUG,
      fetch: fakeFetchBySubstring(historyRoutes),
      now: () => FIXED_NOW,
    });

    expect(report.variant.slug).toBe(SLUG);
    expect(report.fetchedAt).toBe(FIXED_NOW);
    expect(report.from).toEqual(ON_SALE_FROM);
    expect(report.to).toBe(FIXED_NOW);

    expect(report.pages.map((page) => [page.retailerSlug, page.status])).toEqual([
      ["jb-hi-fi", "ok"],
      ["the-good-guys", "ok"],
      ["samsung-au", "ok"],
      ["powerland", "ok"],
      ["toptek", "ok"],
      ["harvey-norman", "ok"],
      ["bing-lee", "ok"],
    ]);
    const [jb, ...rest] = okPages(report.pages);
    expect(jb).toMatchObject({ retailerName: "JB Hi-Fi", url: JB_URL });
    expect(jb.points.map((point) => point.observedAt.toISOString())).toEqual([
      "2026-05-14T02:51:41.000Z",
      "2026-06-08T03:18:44.000Z",
      "2026-08-07T11:04:00.000Z",
      "2026-09-27T05:01:46.000Z",
    ]);
    expect(jb.points.map((point) => point.snapshotUrl)).toEqual(
      JB_TIMESTAMPS.map((ts) => waybackSnapshotUrl(ts, JB_URL)),
    );
    for (const point of jb.points) {
      expect(point).toMatchObject({
        priceCents: 279500,
        strikethroughCents: 329500,
        condition: "new",
      });
    }
    for (const page of rest) expect(page.points).toEqual([]);

    expect(report.lowest).toEqual({
      retailerSlug: "jb-hi-fi",
      priceCents: 279500,
      observedAt: new Date("2026-05-14T02:51:41.000Z"),
    });
  });

  it("keeps only the newest maxSnapshotsPerPage captures, still oldest first, within the given range", async () => {
    const from = new Date("2026-05-01T00:00:00.000Z");
    const to = new Date("2026-09-28T00:00:00.000Z");
    const report = await fetchHistory({
      slug: SLUG,
      from,
      to,
      maxSnapshotsPerPage: 2,
      fetch: fakeFetchBySubstring(historyRoutes),
    });
    expect(report.from).toBe(from);
    expect(report.to).toBe(to);
    const [jb] = okPages(report.pages);
    expect(jb.points.map((point) => point.observedAt.toISOString())).toEqual([
      "2026-08-07T11:04:00.000Z",
      "2026-09-27T05:01:46.000Z",
    ]);
  });

  it("picks the lowest price across every page", async () => {
    const cheaperLater = theGoodGuys.replace('"price": "2795.00"', '"price": "2695.00"');
    const report = await fetchHistory({
      slug: SLUG,
      fetch: fakeFetchBySubstring([
        [cdxNeedle(SAMSUNG_URL), json(JSON.stringify([["timestamp"], ["20260905000000"]]))],
        [`id_/${SAMSUNG_URL}`, html(cheaperLater)],
        ...historyRoutes,
      ]),
      now: () => FIXED_NOW,
    });
    expect(report.lowest).toEqual({
      retailerSlug: "samsung-au",
      priceCents: 269500,
      observedAt: new Date("2026-09-05T00:00:00.000Z"),
    });
  });

  it("reports a page whose index and availability lookups both fail as a network failure and keeps the others", async () => {
    const unreachable: Responder = () => {
      throw new Error("ENOTFOUND web.archive.org");
    };
    const report = await fetchHistory({
      slug: SLUG,
      fetch: fakeFetchBySubstring([
        [cdxNeedle(JB_URL), unreachable],
        [availabilityNeedle(JB_URL), unreachable],
        ...historyRoutes,
      ]),
      now: () => FIXED_NOW,
    });
    expect(report.pages[0]).toMatchObject({
      retailerSlug: "jb-hi-fi",
      retailerName: "JB Hi-Fi",
      url: JB_URL,
      status: "failed",
      kind: "network",
    });
    if (report.pages[0].status === "failed") {
      expect(report.pages[0].message).toContain("Neither the CDX API");
    }
    expect(report.pages.slice(1).map((page) => page.status)).toEqual(Array(6).fill("ok"));
    expect(report.lowest).toBeNull();
  });

  it("reports captures that were found but none fetchable as a failed page, not an empty history", async () => {
    const unreachable: Responder = () => {
      throw new Error("connect ETIMEDOUT 207.241.237.3:443");
    };
    const report = await fetchHistory({
      slug: SLUG,
      fetch: fakeFetchBySubstring([
        [cdxNeedle(JB_URL), json(cdxJbHiFi)],
        [CDX_ENDPOINT, html("")],
        ["id_/", unreachable],
      ]),
      now: () => FIXED_NOW,
    });
    expect(report.pages[0]).toMatchObject({
      retailerSlug: "jb-hi-fi",
      status: "failed",
      kind: "network",
    });
    if (report.pages[0].status === "failed") {
      expect(report.pages[0].message).toContain("4 captures found, none could be fetched");
    }
    expect(report.pages.slice(1).map((page) => page.status)).toEqual(Array(6).fill("ok"));
    expect(report.lowest).toBeNull();
  });

  it("keeps a page ok and lists the skipped captures oldest first when some snapshots fetch and one has no product", async () => {
    const report = await fetchHistory({
      slug: SLUG,
      fetch: fakeFetchBySubstring([
        [cdxNeedle(JB_URL), json(cdxJbHiFi)],
        [CDX_ENDPOINT, html("")],
        [`${JB_TIMESTAMPS[3]}id_/`, html("<html><body>gone</body></html>")],
        // The oldest capture is fetched last, so a rate-limit answer there
        // skips nothing else; wayback stops a page's queue after a 403.
        [`${JB_TIMESTAMPS[0]}id_/`, html(bingLee, 403)],
        ["id_/", html(theGoodGuys)],
      ]),
      now: () => FIXED_NOW,
    });
    const [jb] = okPages(report.pages);
    expect(jb.snapshotsFound).toBe(4);
    expect(jb.points).toHaveLength(2);
    expect(jb.skipped.map((s) => [s.kind, s.observedAt.toISOString()])).toEqual([
      ["blocked", "2026-05-14T02:51:41.000Z"],
      ["unparseable", "2026-09-27T05:01:46.000Z"],
    ]);
    expect(jb.skipped[0].snapshotUrl).toBe(waybackSnapshotUrl(JB_TIMESTAMPS[0], JB_URL));
  });

  it("reports a rejection that is not a SourceError as a network failure", async () => {
    const report = await fetchHistory({
      slug: SLUG,
      fetch: fakeFetchBySubstring([
        [cdxNeedle(JB_URL), () => Promise.resolve(null as unknown as Response)],
        ...historyRoutes,
      ]),
    });
    expect(report.pages[0]).toMatchObject({ status: "failed", kind: "network" });
    if (report.pages[0].status === "failed") {
      expect(report.pages[0].message.length).toBeGreaterThan(0);
    }
  });

  it("throws NotFoundError for a slug that is not tracked", async () => {
    await expect(
      fetchHistory({ slug: "lg-c5-65-au", fetch: fakeFetchBySubstring([]) }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it.each(["", "Samsung S85H", "samsung_s85h"])(
    "throws ValidationError for the slug %j",
    async (slug) => {
      await expect(fetchHistory({ slug, fetch: fakeFetchBySubstring([]) })).rejects.toBeInstanceOf(
        ValidationError,
      );
    },
  );

  it.each([0, -1, 1.5])(
    "throws ValidationError when maxSnapshotsPerPage is %j",
    async (maxSnapshotsPerPage) => {
      await expect(
        fetchHistory({ slug: SLUG, maxSnapshotsPerPage, fetch: fakeFetchBySubstring([]) }),
      ).rejects.toBeInstanceOf(ValidationError);
    },
  );

  it("throws ValidationError when from is not a Date", async () => {
    await expect(
      fetchHistory({
        slug: SLUG,
        from: "2026-05-01" as unknown as Date,
        fetch: fakeFetchBySubstring([]),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

// ---------- extractQuote ----------

/** A store DealZ does not track, with a tracking parameter the report must drop. */
const EXTRACT_URL = "https://www.example-electronics.com.au/tv/samsung-s85h-65?gclid=abc&ref=x";
const EXTRACT_CANONICAL = "https://www.example-electronics.com.au/tv/samsung-s85h-65";
const extractRoutes: [string, Responder][] = [
  [GEMINI_ENDPOINT, json(geminiJbHiFi)],
  ["example-electronics.com.au", html(noStructuredData)],
];

function okExtract(report: ExtractReport) {
  if (report.outcome.status !== "ok") throw new Error(`Expected ok, got ${report.outcome.kind}`);
  return report.outcome;
}

describe("extractQuote", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads a page of any store with the model and matches the printed model code to a tracked variant", async () => {
    const calls: Call[] = [];
    const report = await extractQuote({
      url: EXTRACT_URL,
      apiKey: GEMINI_KEY,
      fetch: fakeFetchBySubstring(extractRoutes, calls),
      now: () => FIXED_NOW,
    });

    expect(report.url).toBe(EXTRACT_CANONICAL);
    expect(report.fetchedAt).toBe(FIXED_NOW);
    expect(report.method).toBe("llm_extract");

    const outcome = okExtract(report);
    expect(outcome.quote.retailerSlug).toBe("example-electronics-com-au");
    expect(outcome.quote.retailerName).toBe("www.example-electronics.com.au");
    expect(outcome.quote.url).toBe(EXTRACT_CANONICAL);
    expect(outcome.quote.method).toBe("llm_extract");
    expect(outcome.quote.priceCents).toBe(279500);
    expect(outcome.quote.strikethroughCents).toBe(329500);
    expect(outcome.quote.evidence).toBe("Sale price: $2795");
    expect(outcome.quote.identifiers.mpn).toBe("QA65S85HAEXXY");
    expect(outcome.matchedVariantSlug).toBe(SLUG);
    expect(outcome.identifierMatch).toBe("mpn");
    // The recorded answer states a doubt, so it lands below the threshold.
    expect(outcome.quote.confidence).toBe(0.5);
    expect(outcome.needsReview).toBe(true);
    expect(outcome.reasons).toEqual([
      "model code present",
      "doubts: The page lists a regular price of $3295 and a sale price of $2795. The sale price is chosen as the current price.",
    ]);

    expect(calls.map((call) => call.url)).toEqual([
      EXTRACT_CANONICAL,
      `${GEMINI_ENDPOINT}/gemini-3.5-flash-lite:generateContent`,
    ]);
    expect(apiKeyHeaderOf(calls[1])).toBe(GEMINI_KEY);
    expect(JSON.stringify(report)).not.toContain(GEMINI_KEY);
  });

  it("clears the review flag at the threshold when the model states no doubts", async () => {
    const report = await extractQuote({
      url: EXTRACT_URL,
      apiKey: GEMINI_KEY,
      fetch: fakeFetchBySubstring([
        [GEMINI_ENDPOINT, json(jbAnswerWithoutDoubts)],
        ...extractRoutes,
      ]),
    });
    const outcome = okExtract(report);
    expect(outcome.quote.confidence).toBe(REVIEW_THRESHOLD);
    expect(outcome.needsReview).toBe(false);
    expect(outcome.reasons).toEqual(["model code present"]);
    expect(outcome.matchedVariantSlug).toBe(SLUG);
    expect(outcome.identifierMatch).toBe("mpn");
  });

  it("flags a doubtful answer whose evidence is not on the page for review and matches no variant", async () => {
    const report = await extractQuote({
      url: EXTRACT_URL,
      apiKey: GEMINI_KEY,
      fetch: fakeFetchBySubstring([[GEMINI_ENDPOINT, json(geminiSamsungDoubt)], ...extractRoutes]),
    });
    const outcome = okExtract(report);
    expect(outcome.quote.priceCents).toBe(257996);
    expect(outcome.quote.confidence).toBeLessThan(REVIEW_THRESHOLD);
    expect(outcome.needsReview).toBe(true);
    expect(outcome.reasons.length).toBeGreaterThan(0);
    expect(outcome.reasons).toContain("evidence not in text");
    // "S85H" is a series, not the variant's model code.
    expect(outcome.quote.identifiers.mpn).toBe("S85H");
    expect(outcome.matchedVariantSlug).toBeNull();
    expect(outcome.identifierMatch).toBe("none");
  });

  it("matches a tracked variant by GTIN when the page prints one", async () => {
    const withGtin = geminiBody({
      is_product_page: true,
      product_title: "Samsung 65-inch S85H OLED 4K Smart TV",
      current_price: 2795,
      currency: "AUD",
      was_price: null,
      price_evidence: "Sale price: $2795",
      model_code: null,
      gtin: "8806097962670",
      condition_words: [],
      is_bundle: false,
      availability: "in_stock",
      doubts: "",
    });
    const report = await extractQuote({
      url: EXTRACT_URL,
      apiKey: GEMINI_KEY,
      fetch: fakeFetchBySubstring([[GEMINI_ENDPOINT, json(withGtin)], ...extractRoutes]),
    });
    const outcome = okExtract(report);
    expect(outcome.quote.identifiers.gtin).toBe("08806097962670");
    expect(outcome.matchedVariantSlug).toBe(SLUG);
    expect(outcome.identifierMatch).toBe("gtin");
  });

  it("names the retailer after the host, without www, and falls back when the host has nothing to slugify", async () => {
    const named = await extractQuote({
      url: "https://WWW.JBHiFi.com.au/products/samsung-65-s85h",
      apiKey: GEMINI_KEY,
      fetch: fakeFetchBySubstring([
        [GEMINI_ENDPOINT, json(geminiJbHiFi)],
        ["", html(noStructuredData)],
      ]),
    });
    expect(okExtract(named).quote.retailerSlug).toBe("jbhifi-com-au");
    expect(okExtract(named).quote.retailerName).toBe("www.jbhifi.com.au");

    const nameless = await extractQuote({
      url: "http://-/tv",
      apiKey: GEMINI_KEY,
      fetch: fakeFetchBySubstring([
        [GEMINI_ENDPOINT, json(geminiJbHiFi)],
        ["", html(noStructuredData)],
      ]),
    });
    expect(okExtract(nameless).quote.retailerSlug).toBe("unknown-retailer");
    expect(okExtract(nameless).quote.retailerName).toBe("-");
  });

  it("reads the key from GEMINI_API_KEY when the argument is absent and keeps it out of the report", async () => {
    vi.stubEnv("GEMINI_API_KEY", "env-gemini-key-0123456789");
    const calls: Call[] = [];
    const report = await extractQuote({
      url: EXTRACT_URL,
      fetch: fakeFetchBySubstring(extractRoutes, calls),
    });
    expect(report.outcome.status).toBe("ok");
    expect(apiKeyHeaderOf(calls[1])).toBe("env-gemini-key-0123456789");
    expect(JSON.stringify(report)).not.toContain("env-gemini-key-0123456789");
  });

  it("throws ValidationError when no key is given and GEMINI_API_KEY is unset", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const calls: Call[] = [];
    const error = await extractQuote({
      url: EXTRACT_URL,
      fetch: fakeFetchBySubstring(extractRoutes, calls),
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).message).toBe("GEMINI_API_KEY is not set");
    expect(calls).toHaveLength(0);
  });

  it.each(["", "not a url", "ftp://example.com/tv", "/tv/samsung-s85h-65", "mailto:x@y.z"])(
    "throws ValidationError for the URL %j",
    async (url) => {
      const error = await extractQuote({
        url,
        apiKey: GEMINI_KEY,
        fetch: fakeFetchBySubstring([]),
      }).catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).issues).toBeDefined();
    },
  );

  it("reports a model that answers 429 as a blocked failure without the key", async () => {
    const report = await extractQuote({
      url: EXTRACT_URL,
      apiKey: GEMINI_KEY,
      fetch: fakeFetchBySubstring([
        [GEMINI_ENDPOINT, json('{"error":{"message":"quota"}}', 429)],
        ...extractRoutes,
      ]),
      now: () => FIXED_NOW,
    });
    expect(report.url).toBe(EXTRACT_CANONICAL);
    expect(report.fetchedAt).toBe(FIXED_NOW);
    expect(report.outcome).toMatchObject({ status: "failed", kind: "blocked" });
    if (report.outcome.status === "failed") expect(report.outcome.message).toContain("429");
    expect(JSON.stringify(report)).not.toContain(GEMINI_KEY);
  });

  it("reports a page that answers 403 as a blocked failure and never calls the model", async () => {
    const calls: Call[] = [];
    const report = await extractQuote({
      url: EXTRACT_URL,
      apiKey: GEMINI_KEY,
      fetch: fakeFetchBySubstring(
        [
          [GEMINI_ENDPOINT, json(geminiJbHiFi)],
          ["example-electronics.com.au", html(bingLee, 403)],
        ],
        calls,
      ),
    });
    expect(report.outcome).toMatchObject({ status: "failed", kind: "blocked" });
    if (report.outcome.status === "failed") expect(report.outcome.message).toContain("403");
    expect(geminiCalls(calls)).toHaveLength(0);
  });

  it("reports a rejection that is not a SourceError as a network failure", async () => {
    const report = await extractQuote({
      url: EXTRACT_URL,
      apiKey: GEMINI_KEY,
      fetch: () => Promise.resolve(null as unknown as Response),
    });
    expect(report.outcome).toMatchObject({ status: "failed", kind: "network" });
    if (report.outcome.status === "failed") {
      expect(report.outcome.message.length).toBeGreaterThan(0);
    }
  });
});

describe("fetchQuotes gap fill", () => {
  const serpCalls = (calls: Call[]): Call[] =>
    calls.filter((call) => call.url.startsWith(SERPAPI_ENDPOINT));

  beforeEach(() => {
    vi.stubEnv("SERPAPI_API_KEY", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fills the retailers whose pages are not fetched from one Google Shopping search", async () => {
    const calls: Call[] = [];
    const report = await fetchQuotes({
      slug: SLUG,
      serpApiKey: API_KEY,
      fetch: fakeFetchBySubstring([...searchRoutes, ...happyRoutes], calls),
      now: () => FIXED_NOW,
    });

    expect(report.gapFill).toEqual({
      status: "ok",
      gaps: 2,
      filled: 2,
      query: "Samsung QA65S85HAEXXY",
    });
    // One search, two hops.
    expect(serpCalls(calls)).toHaveLength(2);
    expect(report.outcomes.every((outcome) => outcome.status === "ok")).toBe(true);

    const ok = okOutcomes(report.outcomes);
    const harveyNorman = outcomeFor(ok, "harvey-norman");
    expect(harveyNorman.filledBySearch).toBe(true);
    expect(harveyNorman.gapReason).toContain("Imperva");
    expect(harveyNorman.retailerName).toBe("Harvey Norman");
    expect(harveyNorman.url).toBe(pageUrl("harvey-norman"));
    expect(harveyNorman.quote.method).toBe("serpapi_google_shopping");
    expect(harveyNorman.quote.provenance.kind).toBe("search");
    expect(harveyNorman.quote.priceCents).toBe(278800);
    expect(harveyNorman.needsReview).toBe(false);
    expect(outcomeFor(ok, "bing-lee").filledBySearch).toBe(true);

    // A page that answered keeps its own quote, even though the search lists it too.
    const jb = outcomeFor(ok, "jb-hi-fi");
    expect(jb.filledBySearch).toBe(false);
    expect(jb.gapReason).toBeNull();
    expect(jb.quote.method).toBe("shopify_json");

    expect(JSON.stringify(report)).not.toContain(API_KEY);
  });

  it("reads the key from SERPAPI_API_KEY when the argument is absent", async () => {
    vi.stubEnv("SERPAPI_API_KEY", "env-key-0123456789");
    const report = await fetchQuotes({
      slug: SLUG,
      fetch: fakeFetchBySubstring([...searchRoutes, ...happyRoutes]),
    });
    expect(report.gapFill.status).toBe("ok");
    expect(JSON.stringify(report)).not.toContain("env-key-0123456789");
  });

  it("makes no search and leaves the gaps when no key is set", async () => {
    const calls: Call[] = [];
    const report = await fetchQuotes({
      slug: SLUG,
      fetch: fakeFetchBySubstring(happyRoutes, calls),
    });
    expect(report.gapFill).toEqual({ status: "no_key", gaps: 2 });
    expect(serpCalls(calls)).toHaveLength(0);
    expect(report.outcomes.filter((outcome) => outcome.status === "skipped")).toHaveLength(2);
  });

  it("makes no search when every page answers", async () => {
    const blocked = variant.pages.filter((page) => page.source === null);
    for (const page of blocked) page.source = "json_ld";
    try {
      const calls: Call[] = [];
      const report = await fetchQuotes({
        slug: SLUG,
        serpApiKey: API_KEY,
        fetch: fakeFetchBySubstring(
          [
            [pageUrl("harvey-norman"), html(powerland)],
            [pageUrl("bing-lee"), html(powerland)],
            ...happyRoutes,
          ],
          calls,
        ),
      });
      expect(report.gapFill).toEqual({ status: "not_needed" });
      expect(serpCalls(calls)).toHaveLength(0);
      expect(okOutcomes(report.outcomes).every((outcome) => !outcome.filledBySearch)).toBe(true);
    } finally {
      for (const page of blocked) page.source = null;
    }
  });

  it("fills a page that failed and says why the page was not read", async () => {
    const report = await fetchQuotes({
      slug: SLUG,
      serpApiKey: API_KEY,
      fetch: fakeFetchBySubstring([
        [TGG_URL, html("Forbidden", 403)],
        ...searchRoutes,
        ...happyRoutes,
      ]),
    });
    const theGoodGuysOutcome = outcomeFor(okOutcomes(report.outcomes), "the-good-guys");
    expect(theGoodGuysOutcome.filledBySearch).toBe(true);
    expect(theGoodGuysOutcome.gapReason).toContain("blocked");
    expect(report.gapFill).toMatchObject({ status: "ok", gaps: 3, filled: 3 });
  });

  it("leaves a retailer the search does not list as it was", async () => {
    const report = await fetchQuotes({
      slug: SLUG,
      serpApiKey: API_KEY,
      fetch: fakeFetchBySubstring([
        [TOPTEK_URL, html("Server error", 500)],
        ...searchRoutes,
        ...happyRoutes,
      ]),
    });
    expect(report.gapFill).toMatchObject({ status: "ok", gaps: 3, filled: 2 });
    const failed = report.outcomes.filter((outcome) => outcome.status === "failed");
    expect(failed.map((outcome) => outcome.retailerSlug)).toEqual(["toptek"]);
  });

  it("keeps the gaps and reports the failure when the search fails", async () => {
    const report = await fetchQuotes({
      slug: SLUG,
      serpApiKey: API_KEY,
      fetch: fakeFetchBySubstring([[SERPAPI_ENDPOINT, html("Unauthorized", 401)], ...happyRoutes]),
    });
    expect(report.gapFill).toMatchObject({ status: "failed", gaps: 2, kind: "http" });
    expect(report.outcomes.filter((outcome) => outcome.status === "skipped")).toHaveLength(2);
    expect(JSON.stringify(report)).not.toContain(API_KEY);
  });

  it("never lets a below-threshold search fill be the cheapest", async () => {
    // No result carries a stores token, so the source falls back to hop-1 items at 0.5,
    // and every page fails, so only search fills remain.
    const hop1 = JSON.parse(googleShopping) as { shopping_results: Record<string, unknown>[] };
    for (const item of hop1.shopping_results) delete item.immersive_product_page_token;
    const report = await fetchQuotes({
      slug: SLUG,
      serpApiKey: API_KEY,
      fetch: fakeFetchBySubstring([
        ["engine=google_shopping", json(JSON.stringify(hop1))],
        ["", html("Server error", 500)],
      ]),
    });
    const filled = okOutcomes(report.outcomes);
    expect(filled.length).toBeGreaterThan(0);
    expect(filled.every((outcome) => outcome.filledBySearch && outcome.needsReview)).toBe(true);
    expect(filled.some((outcome) => outcome.isCheapest)).toBe(false);
    expect(report.cheapest).toBeNull();
  });

  it("keeps a page price cheapest when a below-threshold fill is lower", async () => {
    const hop1 = JSON.parse(googleShopping) as { shopping_results: Record<string, unknown>[] };
    for (const item of hop1.shopping_results) delete item.immersive_product_page_token;
    const report = await fetchQuotes({
      slug: SLUG,
      serpApiKey: API_KEY,
      fetch: fakeFetchBySubstring([
        ["engine=google_shopping", json(JSON.stringify(hop1))],
        // Dearer than anything the search lists.
        [JB_JSON_URL, json(jbHiFi.replaceAll('"2795.00"', '"9999.00"'))],
        ["", html("Server error", 500)],
      ]),
    });
    const ok = okOutcomes(report.outcomes);
    const fills = ok.filter((outcome) => outcome.filledBySearch);
    expect(fills.length).toBeGreaterThan(0);
    expect(fills.every((outcome) => outcome.needsReview)).toBe(true);
    expect(report.cheapest?.retailerSlug).toBe("jb-hi-fi");
    expect(outcomeFor(ok, "jb-hi-fi").isCheapest).toBe(true);
    expect(fills.some((outcome) => outcome.quote.priceCents < report.cheapest!.priceCents)).toBe(
      true,
    );
  });

  describe("a tracked seller listed twice", () => {
    type Store = Record<string, unknown> & { name?: string };
    /** The recorded stores with Harvey Norman listed a second time, changed by `change`. */
    function withSecondHarveyNorman(change: (store: Store) => void): string {
      const body = JSON.parse(immersive) as { product_results: { stores: Store[] } };
      const { stores } = body.product_results;
      const original = stores.find((store) => store.name === "Harvey Norman Australia");
      if (original === undefined) throw new Error("Fixture has no Harvey Norman store");
      const second = structuredClone(original);
      change(second);
      stores.push(second);
      return JSON.stringify(body);
    }
    const routesWith = (stores: string): [string, Responder][] => [
      ["engine=google_immersive_product", json(stores)],
      ...searchRoutes,
      ...happyRoutes,
    ];

    it("takes the lower of two new listings", async () => {
      const stores = withSecondHarveyNorman((store) => {
        store.price = "$2,500.00";
        store.extracted_price = 2500;
      });
      const report = await fetchQuotes({
        slug: SLUG,
        serpApiKey: API_KEY,
        fetch: fakeFetchBySubstring(routesWith(stores)),
      });
      const harveyNorman = outcomeFor(okOutcomes(report.outcomes), "harvey-norman");
      expect(harveyNorman.quote.priceCents).toBe(250000);
      expect(harveyNorman.needsReview).toBe(false);
    });

    it("takes the new listing over a cheaper refurbished one", async () => {
      const stores = withSecondHarveyNorman((store) => {
        store.price = "$1,900.00";
        store.extracted_price = 1900;
        store.title = "Samsung 65-inch S85H AI 4K OLED Smart TV (Refurbished)";
        store.details_and_offers = ["Refurbished"];
      });
      const report = await fetchQuotes({
        slug: SLUG,
        serpApiKey: API_KEY,
        fetch: fakeFetchBySubstring(routesWith(stores)),
      });
      const harveyNorman = outcomeFor(okOutcomes(report.outcomes), "harvey-norman");
      expect(harveyNorman.quote.priceCents).toBe(278800);
      expect(harveyNorman.needsReview).toBe(false);
    });
  });
});
