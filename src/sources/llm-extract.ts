// llm_extract: reads a retailer page that carries no structured data by
// showing its visible text to a language model (ADR-0013). The model returns
// evidence, never a verdict: the price it saw, the fragment it read it from,
// and its doubts. Fixed rules in confidenceFor turn that evidence into a
// confidence, and anything below REVIEW_THRESHOLD is a candidate for review,
// never a price on its own. Only src/sources/gemini.ts knows the provider.

import { normaliseGtin } from "../lib/gtin";
import { parseCents } from "../lib/money";
import { trimAroundPrices, visibleText } from "../lib/page-text";
import { z } from "zod";
import { DEFAULT_EXTRACT_MODEL, generateJson } from "./gemini";
import { fetchText, pageUrlOf } from "./http";
import { SourceError, type QuoteCondition, type Source, type SourceInput } from "./types";

/**
 * What the llm_extract source needs beyond a page. Source takes SourceInput,
 * so these ride along as optional fields and fall back to the environment.
 */
export interface LlmExtractInput extends SourceInput {
  /** Defaults to GEMINI_API_KEY. */
  apiKey?: string;
  /** Defaults to DEFAULT_EXTRACT_MODEL. */
  model?: string;
  /** Country named in the prompt. Defaults to Australia. */
  region?: string;
}

export const DEFAULT_REGION = "Australia";

/** Where trimming looks for prices. "AUD" catches pages that print "AUD 4,158.00". */
export const CURRENCY_SYMBOLS: readonly string[] = ["$", "AUD"];

/** Spellings of Australian dollars the model has been seen to report. */
const AUD_SPELLINGS: ReadonlySet<string> = new Set(["$", "AUD", "A$"]);

/** The shape the model must answer in, as Gemini's structured output expects it. */
export const EXTRACT_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    is_product_page: { type: "BOOLEAN" },
    product_title: { type: "STRING" },
    current_price: { type: "NUMBER", nullable: true },
    currency: { type: "STRING", nullable: true },
    was_price: { type: "NUMBER", nullable: true },
    price_evidence: {
      type: "STRING",
      description: "The exact text fragment the current price was read from",
    },
    model_code: { type: "STRING", nullable: true },
    gtin: { type: "STRING", nullable: true },
    condition_words: { type: "ARRAY", items: { type: "STRING" } },
    is_bundle: { type: "BOOLEAN" },
    availability: { type: "STRING", enum: ["in_stock", "out_of_stock", "unknown"] },
    doubts: { type: "STRING", description: "Anything that made the price ambiguous, or empty" },
  },
  required: [
    "is_product_page",
    "product_title",
    "current_price",
    "currency",
    "price_evidence",
    "condition_words",
    "is_bundle",
    "availability",
    "doubts",
  ],
} as const;

/** The prompt from the 2026-09-28 experiment, with the region sentence first. */
export function systemPromptFor(region: string): string {
  return (
    `The page belongs to a retailer in ${region}; report the price in that country's currency ` +
    "and ignore prices shown in other currencies. " +
    "You read the visible text of a retail web page and report what it says about the single " +
    "product the page sells. Report only what the text states. Never guess a number. The " +
    "current price is the price a customer pays today, not a finance instalment, not a bundle, " +
    "not an accessory and not a strikethrough or RRP. If several prices could be the current " +
    "price, pick the one stated closest to the product title and explain in doubts. If the text " +
    "is not a product page, say so and leave prices null."
  );
}

const nullableString = z.string().nullable().catch(null);
const nullableNumber = z.number().nullable().catch(null);

/** The model's answer, validated. Optional fields the model omits become null. */
export const extractedSchema = z.object({
  is_product_page: z.boolean(),
  product_title: z.string().catch(""),
  current_price: nullableNumber,
  currency: nullableString,
  was_price: nullableNumber,
  price_evidence: z.string().catch(""),
  model_code: nullableString,
  gtin: nullableString,
  condition_words: z.array(z.string()).catch([]),
  is_bundle: z.boolean().catch(false),
  availability: z.enum(["in_stock", "out_of_stock", "unknown"]).catch("unknown"),
  doubts: z.string().catch(""),
});

export type Extracted = z.infer<typeof extractedSchema>;

/** An extraction that names a price; confidenceFor applies to these only. */
export type PricedExtraction = Extracted & { current_price: number };

export interface ConfidenceVerdict {
  confidence: number;
  /** Every rule that moved the score, in the order applied. Kept in `raw`. */
  reasons: string[];
}

/** Whitespace-normalised so a fragment matches however the page broke its lines. */
function normaliseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isAud(currency: string | null): boolean {
  return currency !== null && AUD_SPELLINGS.has(currency.trim().toUpperCase());
}

/**
 * Turns the model's evidence into a confidence by fixed rules (ADR-0013).
 * Scores are whole hundredths so the arithmetic is exact.
 *
 * | Rule | Effect |
 * |---|---|
 * | Start | 0.6 |
 * | model_code present | +0.1 |
 * | doubts non-empty | -0.2 |
 * | price_evidence empty or not found verbatim in the trimmed text | capped at 0.3 |
 * | is_bundle | capped at 0.3 |
 * | currency not "$", "AUD" or "A$" | capped at 0.3 |
 *
 * The evidence rule is the hallucination guard: a price the model cannot
 * point to in the text it was given is never trusted. The caller throws
 * before this runs when the model found no price at all.
 */
export function confidenceFor(extracted: PricedExtraction, trimmedText: string): ConfidenceVerdict {
  const reasons: string[] = [];
  let points = 60;

  if (extracted.model_code !== null && extracted.model_code.trim().length > 0) {
    points += 10;
    reasons.push("model code present");
  }
  if (extracted.doubts.trim().length > 0) {
    points -= 20;
    reasons.push(`doubts: ${extracted.doubts.trim()}`);
  }

  const evidence = normaliseWhitespace(extracted.price_evidence);
  if (evidence.length === 0 || !normaliseWhitespace(trimmedText).includes(evidence)) {
    points = Math.min(points, 30);
    reasons.push("evidence not in text");
  }
  if (extracted.is_bundle) {
    points = Math.min(points, 30);
    reasons.push("bundle");
  }
  if (!isAud(extracted.currency)) {
    points = Math.min(points, 30);
    reasons.push(`currency not AUD: ${extracted.currency ?? "none"}`);
  }

  // The rules above bound the score to 0.3 through 0.7, so a model-read price
  // never reaches structured data's 1 and never falls to zero.
  return { confidence: points / 100, reasons };
}

/**
 * The model reports the words the page used about condition; the mapping to
 * DealZ's coarse condition is fixed here, not left to the model.
 */
export function readExtractCondition(words: string[]): QuoteCondition {
  const text = words.join(" ").toLowerCase();
  if (/refurb/.test(text)) return "refurbished";
  if (/\bused\b|pre-owned|preowned|ex-demo|display/.test(text)) return "used";
  return "new";
}

function apiKeyOf(input: LlmExtractInput): string {
  const key = input.apiKey ?? process.env.GEMINI_API_KEY ?? "";
  if (key.length === 0) {
    throw new SourceError("http", input.retailerSlug, "GEMINI_API_KEY is not set");
  }
  return key;
}

export const fetchLlmExtractQuote: Source = async (input) => {
  const options = input as LlmExtractInput;
  const pageUrl = pageUrlOf(input);
  const now = input.now ?? (() => new Date());
  const apiKey = apiKeyOf(options);
  const model = options.model ?? DEFAULT_EXTRACT_MODEL;
  const region = options.region ?? DEFAULT_REGION;

  const html = await fetchText(input, pageUrl, { headers: { accept: "text/html" } });
  const trimmedText = trimAroundPrices(visibleText(html), {
    currencySymbols: [...CURRENCY_SYMBOLS],
  });

  const answer = await generateJson({
    model,
    systemInstruction: systemPromptFor(region),
    text: trimmedText,
    responseSchema: EXTRACT_RESPONSE_SCHEMA,
    apiKey,
    fetch: input.fetch,
  });

  const parsed = extractedSchema.safeParse(answer.json);
  if (!parsed.success) {
    throw new SourceError(
      "unparseable",
      input.retailerSlug,
      `${pageUrl}: the model's answer has an unexpected shape`,
      { cause: parsed.error },
    );
  }
  const extracted = parsed.data;
  if (!extracted.is_product_page || extracted.current_price === null) {
    throw new SourceError(
      "unparseable",
      input.retailerSlug,
      `${pageUrl}: the model found no price`,
    );
  }
  const priced: PricedExtraction = { ...extracted, current_price: extracted.current_price };

  const priceCents = parseCents(priced.current_price);
  if (priceCents === null) {
    throw new SourceError("unparseable", input.retailerSlug, `${pageUrl} has no readable price`);
  }
  const wasCents = parseCents(priced.was_price);
  const strikethroughCents = wasCents !== null && wasCents > priceCents ? wasCents : null;

  const { confidence, reasons } = confidenceFor(priced, trimmedText);
  const modelCode = priced.model_code?.trim().toUpperCase() ?? "";

  const fetchedAt = now();
  return {
    retailerSlug: input.retailerSlug,
    retailerName: input.retailerName ?? null,
    url: pageUrl,
    method: "llm_extract",
    fetchedAt,
    observedAt: fetchedAt,
    title: priced.product_title.trim().length === 0 ? null : priced.product_title.trim(),
    priceCents,
    // A price in Australian dollars however the model spelt it. Anything else
    // is kept as reported and capped by confidenceFor.
    currency: isAud(priced.currency) ? "AUD" : (priced.currency?.trim().toUpperCase() ?? "AUD"),
    strikethroughCents,
    shippingCents: null,
    availability: priced.availability,
    condition: readExtractCondition(priced.condition_words),
    identifiers: {
      gtin: priced.gtin === null ? null : normaliseGtin(priced.gtin),
      mpn: modelCode.length === 0 ? null : modelCode,
      retailerSku: null,
    },
    provenance: { kind: "live", via: null },
    confidence,
    evidence: priced.price_evidence,
    raw: { model: answer.model, usage: answer.usage, extracted, reasons },
  };
};
