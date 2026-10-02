import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_EXTRACT_MODEL, GEMINI_ENDPOINT, GEMINI_SLUG } from "./gemini";
import {
  DEFAULT_REGION,
  EXTRACT_RESPONSE_SCHEMA,
  confidenceFor,
  fetchLlmExtractQuote,
  readExtractCondition,
  systemPromptFor,
  type Extracted,
  type LlmExtractInput,
  type PricedExtraction,
} from "./llm-extract";
import { REVIEW_THRESHOLD, SourceError, type FetchLike, type SourceCall } from "./types";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

const theGoodGuys = fixture("thegoodguys-s85h-65.html");
const harveyNorman = fixture("harveynorman-challenge.html");
const jbHiFiAnswer = fixture("gemini-extract-jbhifi.json");
const samsungDoubtAnswer = fixture("gemini-extract-samsung-doubt.json");

const PAGE_URL =
  "https://www.thegoodguys.com.au/samsung-65-inches-oled-s85h-4k-smart-ai-tv-2026-qa65s85haexxy";
const API_KEY = "AIzaSy-test-key-0123456789";
const FIXED_NOW = new Date("2026-09-28T05:06:07.000Z");
const REGION_SENTENCE =
  "The page belongs to a retailer in Australia; report the price in that country's currency and ignore prices shown in other currencies.";

/** A page whose visible text carries the evidence the hand-built answers cite. */
const handBuiltPage = `<html><head><title>Samsung 65" OLED S85H | Example</title></head>
<body><h1>Samsung 65&quot; OLED S85H 4K Smart TV</h1>
<p class="price">Now <span>$2,795.00</span> was <s>$3,295.00</s></p>
<p>Also seen: or $2,579.96 with trade-in</p></body></html>`;

const answered: Extracted = {
  is_product_page: true,
  product_title: 'Samsung 65" OLED S85H 4K Smart TV',
  current_price: 2795,
  currency: "AUD",
  was_price: 3295,
  price_evidence: "$2,795.00",
  model_code: "QA65S85HAEXXY",
  gtin: "8806097962670",
  condition_words: [],
  is_bundle: false,
  availability: "in_stock",
  doubts: "",
};

type Call = { url: string; init?: RequestInit };

function geminiBody(extracted: unknown): string {
  return JSON.stringify({
    candidates: [{ content: { parts: [{ text: JSON.stringify(extracted) }] }, role: "model" }],
    usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 120 },
    modelVersion: DEFAULT_EXTRACT_MODEL,
  });
}

/** Serves the page for the retailer URL and the model's answer for Gemini's. */
function fakeFetch(
  page: Response | (() => Response),
  answer: Response | (() => Response),
  calls: Call[] = [],
) {
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const respond = url.startsWith(GEMINI_ENDPOINT) ? answer : page;
    return typeof respond === "function" ? respond() : respond;
  };
  return { fetch, calls };
}

function html(body: string, status = 200): () => Response {
  return () => new Response(body, { status, headers: { "content-type": "text/html" } });
}

function json(body: string, status = 200): () => Response {
  return () => new Response(body, { status, headers: { "content-type": "application/json" } });
}

function inputWith(fetch: FetchLike, patch: Partial<LlmExtractInput> = {}): LlmExtractInput {
  return {
    retailerSlug: "the-good-guys",
    retailerName: "The Good Guys",
    url: PAGE_URL,
    fetch,
    now: () => FIXED_NOW,
    apiKey: API_KEY,
    ...patch,
  };
}

async function quoteFor(extracted: unknown, page = handBuiltPage) {
  const { fetch } = fakeFetch(html(page), json(geminiBody(extracted)));
  return fetchLlmExtractQuote(inputWith(fetch));
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

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("systemPromptFor", () => {
  it("opens with the region sentence and keeps the experiment's instructions", () => {
    const prompt = systemPromptFor(DEFAULT_REGION);
    expect(prompt.startsWith(REGION_SENTENCE)).toBe(true);
    expect(prompt).toContain("Never guess a number.");
    expect(prompt).toContain("explain in doubts");
    expect(systemPromptFor("New Zealand")).toContain("a retailer in New Zealand;");
  });
});

describe("readExtractCondition", () => {
  it.each([
    [["Refurbished"], "refurbished"],
    [["Certified refurb"], "refurbished"],
    [["Used"], "used"],
    [["Pre-Owned"], "used"],
    [["ex-demo"], "used"],
    [["Display model"], "used"],
    [["Brand new"], "new"],
    [[], "new"],
  ])("maps %j to %s", (words, expected) => {
    expect(readExtractCondition(words)).toBe(expected);
  });

  it("does not read 'used' out of a longer word", () => {
    expect(readExtractCondition(["unused stock"])).toBe("new");
  });
});

describe("confidenceFor", () => {
  const text = 'Samsung 65" OLED S85H 4K Smart TV Now $2,795.00 was $3,295.00';
  const priced: PricedExtraction = { ...answered, current_price: 2795 };

  it("gives 0.7 to a price with evidence in the text, a model code and no doubts", () => {
    expect(confidenceFor(priced, text)).toEqual({
      confidence: 0.7,
      reasons: ["model code present"],
    });
  });

  it("gives 0.6 without a model code", () => {
    expect(confidenceFor({ ...priced, model_code: null }, text).confidence).toBe(0.6);
    expect(confidenceFor({ ...priced, model_code: "  " }, text).confidence).toBe(0.6);
  });

  it("takes 0.2 off for doubts and records them", () => {
    const verdict = confidenceFor({ ...priced, doubts: "Two prices shown" }, text);
    expect(verdict.confidence).toBe(0.5);
    expect(verdict.reasons).toContain("doubts: Two prices shown");
  });

  it("caps at 0.3 when the evidence is not in the text, or is empty", () => {
    const missing = confidenceFor({ ...priced, price_evidence: "Sale price: $2795" }, text);
    expect(missing.confidence).toBe(0.3);
    expect(missing.reasons).toContain("evidence not in text");
    expect(confidenceFor({ ...priced, price_evidence: "" }, text).confidence).toBe(0.3);
  });

  it("matches evidence across line breaks and repeated spaces", () => {
    const broken = 'Samsung 65" OLED S85H\n\n  Now  $2,795.00\n was $3,295.00';
    expect(confidenceFor({ ...priced, price_evidence: "Now $2,795.00" }, broken).confidence).toBe(
      0.7,
    );
  });

  it("caps at 0.3 for a bundle", () => {
    const verdict = confidenceFor({ ...priced, is_bundle: true }, text);
    expect(verdict.confidence).toBe(0.3);
    expect(verdict.reasons).toContain("bundle");
  });

  it.each(["GBP", "USD", null])("caps at 0.3 when the currency is %s", (currency) => {
    const verdict = confidenceFor({ ...priced, currency }, text);
    expect(verdict.confidence).toBe(0.3);
    expect(verdict.reasons).toContain(`currency not AUD: ${currency ?? "none"}`);
  });

  it.each(["$", "AUD", "A$", "aud", " AUD "])("accepts %j as Australian dollars", (currency) => {
    expect(confidenceFor({ ...priced, currency }, text).confidence).toBe(0.7);
  });

  it("stays at 0.3 when several caps apply with doubts", () => {
    const verdict = confidenceFor(
      { ...priced, is_bundle: true, currency: "GBP", doubts: "x", price_evidence: "nope" },
      text,
    );
    expect(verdict.confidence).toBe(0.3);
    expect(verdict.reasons).toEqual([
      "model code present",
      "doubts: x",
      "evidence not in text",
      "bundle",
      "currency not AUD: GBP",
    ]);
  });
});

describe("fetchLlmExtractQuote", () => {
  it("replays the recorded JB Hi-Fi answer and flags evidence that is not in The Good Guys text", async () => {
    const { fetch, calls } = fakeFetch(html(theGoodGuys), json(jbHiFiAnswer));
    const quote = await fetchLlmExtractQuote(inputWith(fetch, { url: `${PAGE_URL}?gclid=abc` }));

    expect(quote.retailerSlug).toBe("the-good-guys");
    expect(quote.retailerName).toBe("The Good Guys");
    expect(quote.url).toBe(PAGE_URL);
    expect(quote.method).toBe("llm_extract");
    expect(quote.fetchedAt).toBe(FIXED_NOW);
    expect(quote.observedAt).toBe(FIXED_NOW);
    expect(quote.title).toBe("Samsung 65-inch S85H OLED 4K Smart TV");
    expect(quote.priceCents).toBe(279500);
    expect(quote.strikethroughCents).toBe(329500);
    expect(quote.currency).toBe("AUD");
    expect(quote.shippingCents).toBeNull();
    expect(quote.availability).toBe("unknown");
    expect(quote.condition).toBe("new");
    expect(quote.identifiers).toEqual({ gtin: null, mpn: "QA65S85HAEXXY", retailerSku: null });
    expect(quote.provenance).toEqual({ kind: "live", via: null });
    expect(quote.evidence).toBe("Sale price: $2795");
    expect(quote.confidence).toBe(0.3);
    expect(quote.confidence).toBeLessThan(REVIEW_THRESHOLD);

    const raw = quote.raw as {
      model: string;
      usage: { inputTokens: number; outputTokens: number; thinkingTokens: number };
      extracted: Extracted;
      reasons: string[];
    };
    expect(raw.model).toBe("gemini-3.5-flash-lite");
    expect(raw.usage).toEqual({ inputTokens: 766, outputTokens: 180, thinkingTokens: 0 });
    expect(raw.extracted.current_price).toBe(2795);
    expect(raw.reasons).toContain("evidence not in text");
    expect(JSON.stringify(quote.raw)).not.toContain(API_KEY);

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(PAGE_URL);
    expect(new Headers(calls[0].init?.headers).get("accept")).toBe("text/html");
  });

  it("sends the trimmed page text and the region prompt with the key in a header, not the URL", async () => {
    const { fetch, calls } = fakeFetch(html(handBuiltPage), json(geminiBody(answered)));
    await fetchLlmExtractQuote(inputWith(fetch));

    const [, gemini] = calls;
    expect(gemini.url).toBe(`${GEMINI_ENDPOINT}/${DEFAULT_EXTRACT_MODEL}:generateContent`);
    expect(gemini.url).not.toContain(API_KEY);
    expect(new Headers(gemini.init?.headers).get("x-goog-api-key")).toBe(API_KEY);

    const body = JSON.parse(String(gemini.init?.body)) as {
      systemInstruction: { parts: { text: string }[] };
      contents: { parts: { text: string }[] }[];
      generationConfig: { responseSchema: unknown; temperature: number };
    };
    expect(body.systemInstruction.parts[0].text).toContain(REGION_SENTENCE);
    expect(body.contents[0].parts[0].text).toBe(
      'Samsung 65" OLED S85H | Example Samsung 65" OLED S85H 4K Smart TV Now $2,795.00 was $3,295.00 Also seen: or $2,579.96 with trade-in',
    );
    expect(body.generationConfig.responseSchema).toEqual(EXTRACT_RESPONSE_SCHEMA);
    expect(body.generationConfig.temperature).toBe(0);
  });

  it("gives 0.7 to an answer whose evidence is in the page text with no doubts", async () => {
    const quote = await quoteFor(answered);
    expect(quote.confidence).toBe(0.7);
    expect(quote.confidence).toBeGreaterThanOrEqual(REVIEW_THRESHOLD);
    expect(quote.priceCents).toBe(279500);
    expect(quote.strikethroughCents).toBe(329500);
    expect(quote.title).toBe('Samsung 65" OLED S85H 4K Smart TV');
    expect(quote.availability).toBe("in_stock");
    expect(quote.identifiers).toEqual({
      gtin: "08806097962670",
      mpn: "QA65S85HAEXXY",
      retailerSku: null,
    });
    expect(quote.evidence).toBe("$2,795.00");
  });

  it("gives 0.5 when the model has doubts", async () => {
    const quote = await quoteFor({ ...answered, doubts: "A finance price is also shown." });
    expect(quote.confidence).toBe(0.5);
  });

  it("gives 0.3 to a bundle", async () => {
    const quote = await quoteFor({ ...answered, is_bundle: true });
    expect(quote.confidence).toBe(0.3);
  });

  it("gives 0.3 to a price in GBP and keeps the currency as reported", async () => {
    const quote = await quoteFor({ ...answered, currency: "gbp" });
    expect(quote.confidence).toBe(0.3);
    expect(quote.currency).toBe("GBP");
  });

  it("lowers the recorded Samsung answer below the review threshold for its doubts", async () => {
    const withEvidence = await (async () => {
      const { fetch } = fakeFetch(html(handBuiltPage), json(samsungDoubtAnswer));
      return fetchLlmExtractQuote(inputWith(fetch));
    })();
    expect(withEvidence.priceCents).toBe(257996);
    expect(withEvidence.evidence).toBe("or $2,579.96");
    expect(withEvidence.identifiers.mpn).toBe("S85H");
    expect(withEvidence.availability).toBe("out_of_stock");
    expect(withEvidence.confidence).toBe(0.5);
    expect(withEvidence.confidence).toBeLessThan(REVIEW_THRESHOLD);
    const raw = withEvidence.raw as { reasons: string[]; usage: { thinkingTokens: number } };
    expect(raw.reasons.some((reason) => reason.startsWith("doubts: "))).toBe(true);
    expect(raw.usage.thinkingTokens).toBe(1017);
  });

  it("maps condition words, drops a bad GTIN and a was price no higher than the price", async () => {
    const quote = await quoteFor({
      ...answered,
      condition_words: ["Refurbished", "Grade A"],
      gtin: "8806097962671",
      was_price: 2795,
      model_code: "qa65s85haexxy",
      product_title: "  ",
    });
    expect(quote.condition).toBe("refurbished");
    expect(quote.identifiers.gtin).toBeNull();
    expect(quote.identifiers.mpn).toBe("QA65S85HAEXXY");
    expect(quote.strikethroughCents).toBeNull();
    expect(quote.title).toBeNull();
  });

  it("uses the model and region given", async () => {
    const { fetch, calls } = fakeFetch(html(handBuiltPage), json(geminiBody(answered)));
    await fetchLlmExtractQuote(inputWith(fetch, { model: "gemini-test", region: "New Zealand" }));
    const [, gemini] = calls;
    expect(gemini.url).toContain("/gemini-test:generateContent");
    const body = JSON.parse(String(gemini.init?.body)) as {
      systemInstruction: { parts: { text: string }[] };
    };
    expect(body.systemInstruction.parts[0].text).toContain("a retailer in New Zealand;");
  });

  it("reads the key from GEMINI_API_KEY when the input carries none", async () => {
    vi.stubEnv("GEMINI_API_KEY", API_KEY);
    const { fetch, calls } = fakeFetch(html(handBuiltPage), json(geminiBody(answered)));
    await fetchLlmExtractQuote(inputWith(fetch, { apiKey: undefined }));
    expect(new Headers(calls[1].init?.headers).get("x-goog-api-key")).toBe(API_KEY);
  });

  it("throws http before any request when no key is set", async () => {
    vi.stubEnv("GEMINI_API_KEY", undefined);
    const { fetch, calls } = fakeFetch(html(handBuiltPage), json(geminiBody(answered)));
    const error = await sourceErrorFrom(
      fetchLlmExtractQuote(inputWith(fetch, { apiKey: undefined })),
    );
    expect(error.kind).toBe("http");
    expect(error.message).toBe("GEMINI_API_KEY is not set");
    expect(error.retailerSlug).toBe("the-good-guys");
    expect(calls).toHaveLength(0);
  });

  it("throws unparseable when the model found no price", async () => {
    const error = await sourceErrorFrom(quoteFor({ ...answered, current_price: null }));
    expect(error.kind).toBe("unparseable");
    expect(error.message).toContain("the model found no price");
    expect(error.retailerSlug).toBe("the-good-guys");
  });

  it("throws unparseable when the model says the page is not a product page", async () => {
    const error = await sourceErrorFrom(quoteFor({ ...answered, is_product_page: false }));
    expect(error.kind).toBe("unparseable");
    expect(error.message).toContain("the model found no price");
  });

  it("throws unparseable when the price cannot be cents", async () => {
    const error = await sourceErrorFrom(quoteFor({ ...answered, current_price: -1 }));
    expect(error.kind).toBe("unparseable");
    expect(error.message).toContain("no readable price");
  });

  it("throws unparseable when the answer has an unexpected shape", async () => {
    const error = await sourceErrorFrom(quoteFor({ hello: "world" }));
    expect(error.kind).toBe("unparseable");
    expect(error.message).toContain("unexpected shape");
  });

  it("throws blocked under the gemini slug, without the key, when the model answers 429", async () => {
    const { fetch } = fakeFetch(html(handBuiltPage), json('{"error":{"message":"quota"}}', 429));
    const error = await sourceErrorFrom(fetchLlmExtractQuote(inputWith(fetch)));
    expect(error.kind).toBe("blocked");
    expect(error.status).toBe(429);
    expect(error.retailerSlug).toBe(GEMINI_SLUG);
    expect(error.message).not.toContain(API_KEY);
  });

  it("throws blocked under the retailer slug when the page is a bot challenge", async () => {
    const { fetch, calls } = fakeFetch(html(harveyNorman), json(geminiBody(answered)));
    const error = await sourceErrorFrom(fetchLlmExtractQuote(inputWith(fetch)));
    expect(error.kind).toBe("blocked");
    expect(error.retailerSlug).toBe("the-good-guys");
    expect(calls).toHaveLength(1);
  });

  it("throws http under the retailer slug when the page answers 500", async () => {
    const { fetch } = fakeFetch(html("error", 500), json(geminiBody(answered)));
    const error = await sourceErrorFrom(fetchLlmExtractQuote(inputWith(fetch)));
    expect(error.kind).toBe("http");
    expect(error.status).toBe(500);
    expect(error.retailerSlug).toBe("the-good-guys");
  });
});

describe("fetchLlmExtractQuote metering", () => {
  function metered(fetch: FetchLike) {
    const calls: SourceCall[] = [];
    return { input: inputWith(fetch, { meter: (call) => void calls.push(call) }), calls };
  }

  it("reports the page fetch and the model call, both for the page's retailer", async () => {
    const { fetch } = fakeFetch(html(handBuiltPage), json(geminiBody(answered)));
    const { input, calls } = metered(fetch);
    await fetchLlmExtractQuote(input);

    expect(calls).toEqual([
      expect.objectContaining({
        provider: "retailer",
        operation: "page",
        outcome: "ok",
        retailerSlug: "the-good-guys",
        model: null,
        startedAt: FIXED_NOW,
      }),
      expect.objectContaining({
        provider: "gemini",
        operation: "generate_content",
        outcome: "ok",
        retailerSlug: "the-good-guys",
        model: DEFAULT_EXTRACT_MODEL,
        inputTokens: 500,
        outputTokens: 120,
        startedAt: FIXED_NOW,
      }),
    ]);
  });

  it("reports only the page fetch when the page is blocked and the model is never asked", async () => {
    const { fetch } = fakeFetch(html(harveyNorman), json(geminiBody(answered)));
    const { input, calls } = metered(fetch);
    await sourceErrorFrom(fetchLlmExtractQuote(input));
    expect(calls).toEqual([
      expect.objectContaining({ provider: "retailer", outcome: "failed", errorKind: "blocked" }),
    ]);
  });

  it("reports the model call as failed when the model answers 429", async () => {
    const { fetch } = fakeFetch(html(handBuiltPage), json('{"error":{"message":"quota"}}', 429));
    const { input, calls } = metered(fetch);
    await sourceErrorFrom(fetchLlmExtractQuote(input));
    expect(calls.map((call) => [call.provider, call.outcome, call.httpStatus])).toEqual([
      ["retailer", "ok", 200],
      ["gemini", "failed", 429],
    ]);
  });

  it("reports the model call as ok when it answered, even if the answer holds no price", async () => {
    const { fetch } = fakeFetch(
      html(handBuiltPage),
      json(geminiBody({ ...answered, current_price: null })),
    );
    const { input, calls } = metered(fetch);
    await sourceErrorFrom(fetchLlmExtractQuote(input));
    expect(calls.map((call) => [call.provider, call.outcome])).toEqual([
      ["retailer", "ok"],
      ["gemini", "ok"],
    ]);
  });
});
