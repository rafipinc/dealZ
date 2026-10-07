// What one outbound call is estimated to cost, in millionths of a US dollar.
// An estimate for the local usage dashboard, never a bill: the provider's
// invoice is the truth. Pure arithmetic over a hand-maintained price table.

/** Micro-dollars in a dollar, and tokens in the unit providers price by. */
const MILLION = 1_000_000;

export interface TokenPrice {
  /** Micro-dollars per million input tokens. */
  inputMicrosPerMillion: number;
  /** Micro-dollars per million output tokens, thinking tokens included. */
  outputMicrosPerMillion: number;
}

/** A price and the day it starts to apply. */
export interface DatedTokenPrice extends TokenPrice {
  /**
   * ISO date, "2027-01-01": the price applies to calls started at or after
   * 00:00 UTC that day, until a later entry takes over. Null for the first
   * entry of a model: it applies to every call before the next entry.
   */
  effectiveFrom: string | null;
}

/**
 * Gemini list prices in US dollars per million tokens. Source:
 * ai.google.dev/gemini-api/docs/pricing, checked 2026-10-01.
 *
 * | Model | Input | Output | Applies |
 * |---|---|---|---|
 * | gemini-3.5-flash-lite | 0.30 | 2.50 | now, no end date stated |
 * | gemini-3.8-flash | 0.75 | 3.75 | through 2026-12-31 |
 * | gemini-3.8-flash | 1.50 | 7.50 | from 2027-01-01 |
 *
 * Each model's entries are oldest first and the first has `effectiveFrom`
 * null. A call is priced by the entry in force when it started, so a ledger
 * row keeps the cost of its day when the price later changes. The provider
 * states dates, not a time of day; the change is taken at 00:00 UTC. When the
 * provider changes a price, add an entry; never edit one that has applied.
 */
export const GEMINI_TOKEN_PRICES: Readonly<Record<string, readonly DatedTokenPrice[]>> = {
  "gemini-3.5-flash-lite": [
    { effectiveFrom: null, inputMicrosPerMillion: 300_000, outputMicrosPerMillion: 2_500_000 },
  ],
  "gemini-3.8-flash": [
    { effectiveFrom: null, inputMicrosPerMillion: 750_000, outputMicrosPerMillion: 3_750_000 },
    {
      effectiveFrom: "2027-01-01",
      inputMicrosPerMillion: 1_500_000,
      outputMicrosPerMillion: 7_500_000,
    },
  ],
};

/**
 * SerpApi is charged per search, not per token. Zero while the account is on
 * the free tier. The paid tier is USD 75 for 5,000 searches, which is 15,000
 * micro-dollars a call: set this to 15_000 when the plan changes. Charged for
 * a successful search only; see estimateCostMicros.
 */
export const SERPAPI_MICROS_PER_CALL = 0;

/** Providers that never charge: the archive and the retailers' own pages. */
const FREE_PROVIDERS: ReadonlySet<string> = new Set(["wayback", "retailer"]);

/**
 * True when the table prices every call to this provider at zero, so a zero
 * total is "free", not a measurement. False for a provider billed by use and
 * for one the table does not know.
 */
export function isFreeProvider(provider: string): boolean {
  if (FREE_PROVIDERS.has(provider)) return true;
  return provider === "serpapi" && SERPAPI_MICROS_PER_CALL === 0;
}

/**
 * The SerpApi operations that use up a search. The Account API is free and
 * does not count against the quota. The discovery budget counts the same set.
 */
export const SERPAPI_SEARCH_OPERATIONS: ReadonlySet<string> = new Set([
  "google_shopping",
  "google_immersive_product",
]);

export interface CostInput {
  provider: string;
  /** What was asked of the provider: "google_shopping", "account", "generate_content", ... */
  operation: string;
  outcome: "ok" | "failed";
  /** When the call was made. Picks the price in force that day. */
  startedAt: Date;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface CostEstimate {
  /** A non-negative integer. Zero when free and zero when unpriced; `priced` tells them apart. */
  costMicros: number;
  /** False when the table has no price for this provider or model, so the zero is not a fact. */
  priced: boolean;
}

/** The rates an estimate is made at. Passed in by tests; everything else uses the defaults. */
export interface PriceTable {
  serpApiMicrosPerCall: number;
  geminiTokenPrices: Readonly<Record<string, readonly DatedTokenPrice[]>>;
}

export const DEFAULT_PRICES: PriceTable = {
  serpApiMicrosPerCall: SERPAPI_MICROS_PER_CALL,
  geminiTokenPrices: GEMINI_TOKEN_PRICES,
};

const UNPRICED: CostEstimate = { costMicros: 0, priced: false };
const NO_CHARGE: CostEstimate = { costMicros: 0, priced: true };

/** A token count as the arithmetic needs it: absent, negative or fractional counts become whole and non-negative. */
function tokens(count: number | null): number {
  return count === null || !Number.isFinite(count) ? 0 : Math.max(0, Math.round(count));
}

/** The entries for a model, or null when the table does not know it. Own properties only. */
function entriesFor(model: string | null, prices: PriceTable): readonly DatedTokenPrice[] | null {
  // Own-property lookup: a model named "constructor" is not in the table.
  if (model === null || !Object.hasOwn(prices.geminiTokenPrices, model)) return null;
  const entries = prices.geminiTokenPrices[model];
  return entries.length === 0 ? null : entries;
}

/**
 * The price in force at `startedAt`: the latest entry that had started by
 * then. Null when every entry starts later, which the default table rules out
 * by opening each model with an undated entry.
 */
export function priceInForce(
  entries: readonly DatedTokenPrice[],
  startedAt: Date,
): TokenPrice | null {
  let inForce: DatedTokenPrice | null = null;
  let inForceFrom = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    const from =
      entry.effectiveFrom === null
        ? Number.NEGATIVE_INFINITY
        : Date.parse(`${entry.effectiveFrom}T00:00:00Z`);
    // Not relying on the order of the table: the latest start that qualifies wins.
    if (from <= startedAt.getTime() && (inForce === null || from >= inForceFrom)) {
      inForce = entry;
      inForceFrom = from;
    }
  }
  return inForce;
}

/**
 * Whether the table can put a price on a call to this provider with this
 * model. Decided when a ledger row is read, from the table as it is now: a
 * Gemini row whose model the table does not know is "unpriced", and its
 * stored cost of zero is not a fact. Every other known provider is priced,
 * free ones at zero. An unknown provider is not.
 */
export function isPriced(
  provider: string,
  model: string | null,
  prices: PriceTable = DEFAULT_PRICES,
): boolean {
  if (FREE_PROVIDERS.has(provider) || provider === "serpapi") return true;
  return provider === "gemini" && entriesFor(model, prices) !== null;
}

/**
 * Estimates one call's cost. Rounded to the nearest micro-dollar.
 *
 * SerpApi charges per successful search: a failed call and the Account API
 * cost nothing. Gemini charges for the tokens it reports, whatever became of
 * the answer, so a failed call that carries token counts is still priced, at
 * the price in force when the call started.
 */
export function estimateCostMicros(
  input: CostInput,
  prices: PriceTable = DEFAULT_PRICES,
): CostEstimate {
  if (FREE_PROVIDERS.has(input.provider)) return NO_CHARGE;
  if (input.provider === "serpapi") {
    const charged = input.outcome === "ok" && SERPAPI_SEARCH_OPERATIONS.has(input.operation);
    return charged
      ? { costMicros: Math.max(0, Math.round(prices.serpApiMicrosPerCall)), priced: true }
      : NO_CHARGE;
  }
  if (input.provider !== "gemini") return UNPRICED;

  const entries = entriesFor(input.model, prices);
  const price = entries === null ? null : priceInForce(entries, input.startedAt);
  if (price === null) return UNPRICED;
  const micros =
    (tokens(input.inputTokens) * price.inputMicrosPerMillion +
      tokens(input.outputTokens) * price.outputMicrosPerMillion) /
    MILLION;
  return { costMicros: Math.round(micros), priced: true };
}
