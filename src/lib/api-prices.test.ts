import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRICES,
  GEMINI_TOKEN_PRICES,
  SERPAPI_MICROS_PER_CALL,
  estimateCostMicros,
  isFreeProvider,
  isPriced,
  priceInForce,
  type CostInput,
} from "./api-prices";

const call = (patch: Partial<CostInput>): CostInput => ({
  provider: "gemini",
  operation: "generate_content",
  outcome: "ok",
  startedAt: new Date("2026-10-01T00:00:00.000Z"),
  model: "gemini-3.5-flash-lite",
  inputTokens: null,
  outputTokens: null,
  ...patch,
});

describe("estimateCostMicros", () => {
  it.each([
    // 1,000,000 input tokens on Flash-Lite is USD 0.30.
    [{ inputTokens: 1_000_000, outputTokens: 0 }, 300_000],
    // 1,000,000 output tokens on Flash-Lite is USD 2.50.
    [{ inputTokens: 0, outputTokens: 1_000_000 }, 2_500_000],
    // The recorded JB Hi-Fi read: 766 in, 180 out is 229.8 + 450 = 679.8, rounded.
    [{ inputTokens: 766, outputTokens: 180 }, 680],
    [{ model: "gemini-3.8-flash", inputTokens: 1_000_000, outputTokens: 0 }, 750_000],
    [{ model: "gemini-3.8-flash", inputTokens: 0, outputTokens: 1_000_000 }, 3_750_000],
    // 1,436 in and 1,190 out (answer plus thinking): 1,077 + 4,462.5 = 5,539.5.
    [{ model: "gemini-3.8-flash", inputTokens: 1_436, outputTokens: 1_190 }, 5_540],
  ])("prices a Gemini call %j at %d micro-dollars", (patch, expected) => {
    expect(estimateCostMicros(call(patch))).toEqual({ costMicros: expected, priced: true });
  });

  it("prices a Gemini call that reported no tokens at zero, as priced", () => {
    expect(estimateCostMicros(call({}))).toEqual({ costMicros: 0, priced: true });
  });

  it("treats a negative or non-finite token count as zero", () => {
    expect(estimateCostMicros(call({ inputTokens: -5, outputTokens: Number.NaN }))).toEqual({
      costMicros: 0,
      priced: true,
    });
  });

  it("always returns a whole number", () => {
    const { costMicros } = estimateCostMicros(call({ inputTokens: 1, outputTokens: 1 }));
    expect(Number.isInteger(costMicros)).toBe(true);
  });

  it("reports an unknown Gemini model as unpriced at zero", () => {
    expect(estimateCostMicros(call({ model: "gemini-9-ultra", inputTokens: 1_000 }))).toEqual({
      costMicros: 0,
      priced: false,
    });
  });

  it("does not mistake an inherited property name for a model", () => {
    expect(estimateCostMicros(call({ model: "constructor", inputTokens: 1_000 })).priced).toBe(
      false,
    );
  });

  it("reports a Gemini call with no model as unpriced", () => {
    expect(estimateCostMicros(call({ model: null, inputTokens: 1_000 })).priced).toBe(false);
  });

  it("reports an unknown provider as unpriced at zero", () => {
    expect(estimateCostMicros(call({ provider: "openai" }))).toEqual({
      costMicros: 0,
      priced: false,
    });
  });

  it("charges a SerpApi search nothing by default, while the account is on the free tier", () => {
    expect(SERPAPI_MICROS_PER_CALL).toBe(0);
    expect(DEFAULT_PRICES.serpApiMicrosPerCall).toBe(SERPAPI_MICROS_PER_CALL);
    expect(
      estimateCostMicros(call({ provider: "serpapi", operation: "google_shopping", model: null })),
    ).toEqual({ costMicros: 0, priced: true });
  });

  describe("SerpApi at the paid rate", () => {
    const paid = { ...DEFAULT_PRICES, serpApiMicrosPerCall: 15_000 };
    const serp = (patch: Partial<CostInput>) =>
      estimateCostMicros(
        call({ provider: "serpapi", operation: "google_shopping", model: null, ...patch }),
        paid,
      );

    it.each(["google_shopping", "google_immersive_product"])(
      "charges a successful %s search the per-call rate",
      (operation) => {
        expect(serp({ operation })).toEqual({ costMicros: 15_000, priced: true });
      },
    );

    it.each(["google_shopping", "google_immersive_product"])(
      "charges a failed %s search nothing",
      (operation) => {
        expect(serp({ operation, outcome: "failed" })).toEqual({ costMicros: 0, priced: true });
      },
    );

    it("charges the Account API nothing, ok or failed", () => {
      expect(serp({ operation: "account" })).toEqual({ costMicros: 0, priced: true });
      expect(serp({ operation: "account", outcome: "failed" })).toEqual({
        costMicros: 0,
        priced: true,
      });
    });

    it("charges an operation it does not know nothing", () => {
      expect(serp({ operation: "google_lens" })).toEqual({ costMicros: 0, priced: true });
    });

    it("never charges a negative or fractional rate", () => {
      const at = (rate: number) =>
        estimateCostMicros(
          call({ provider: "serpapi", operation: "google_shopping", model: null }),
          { ...DEFAULT_PRICES, serpApiMicrosPerCall: rate },
        ).costMicros;
      expect(at(-5)).toBe(0);
      expect(at(14_999.6)).toBe(15_000);
    });
  });

  it("still prices a failed Gemini call by the tokens it reported", () => {
    expect(
      estimateCostMicros(call({ outcome: "failed", inputTokens: 1_000_000, outputTokens: 0 })),
    ).toEqual({ costMicros: 300_000, priced: true });
  });

  it("takes Gemini prices from the table it is given", () => {
    const prices = {
      ...DEFAULT_PRICES,
      geminiTokenPrices: {
        "gemini-test": [
          { effectiveFrom: null, inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 0 },
        ],
        "gemini-empty": [],
      },
    };
    expect(estimateCostMicros(call({ model: "gemini-test", inputTokens: 250 }), prices)).toEqual({
      costMicros: 250,
      priced: true,
    });
    expect(estimateCostMicros(call({ inputTokens: 250 }), prices).priced).toBe(false);
    expect(estimateCostMicros(call({ model: "gemini-empty" }), prices).priced).toBe(false);
  });

  describe("prices by date", () => {
    const flash = (startedAt: string) =>
      estimateCostMicros(
        call({
          model: "gemini-3.8-flash",
          startedAt: new Date(startedAt),
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
        }),
      );

    it.each([
      // 0.75 + 3.75 through 2026-12-31.
      ["2026-09-28T00:00:00.000Z", 4_500_000],
      ["2026-12-31T23:59:59.999Z", 4_500_000],
      // 1.50 + 7.50 from 2027-01-01.
      ["2027-01-01T00:00:00.000Z", 9_000_000],
      ["2027-06-15T12:00:00.000Z", 9_000_000],
      // Before the ledger began: the first entry still applies.
      ["2025-01-01T00:00:00.000Z", 4_500_000],
    ])("prices a gemini-3.8-flash call started at %s at %d micro-dollars", (startedAt, micros) => {
      expect(flash(startedAt)).toEqual({ costMicros: micros, priced: true });
    });

    it("keeps Flash-Lite at one price across the same dates", () => {
      for (const startedAt of ["2026-10-01T00:00:00.000Z", "2027-06-15T00:00:00.000Z"]) {
        expect(
          estimateCostMicros(
            call({ startedAt: new Date(startedAt), inputTokens: 1_000_000, outputTokens: 0 }),
          ).costMicros,
        ).toBe(300_000);
      }
    });

    it("is unpriced when the table's first price for the model starts after the call", () => {
      const prices = {
        ...DEFAULT_PRICES,
        geminiTokenPrices: {
          "gemini-new": [
            { effectiveFrom: "2027-03-01", inputMicrosPerMillion: 1, outputMicrosPerMillion: 1 },
          ],
        },
      };
      expect(estimateCostMicros(call({ model: "gemini-new", inputTokens: 5 }), prices)).toEqual({
        costMicros: 0,
        priced: false,
      });
    });
  });

  it.each(["wayback", "retailer"])("prices %s at zero, as priced", (provider) => {
    expect(estimateCostMicros(call({ provider, model: null }))).toEqual({
      costMicros: 0,
      priced: true,
    });
  });

  it("holds the prices checked on 2026-10-01, each model opening with an undated entry", () => {
    expect(GEMINI_TOKEN_PRICES).toEqual({
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
    });
    for (const entries of Object.values(GEMINI_TOKEN_PRICES)) {
      expect(entries[0].effectiveFrom).toBeNull();
    }
  });
});

describe("priceInForce", () => {
  const early = { effectiveFrom: null, inputMicrosPerMillion: 1, outputMicrosPerMillion: 1 };
  const mid = { effectiveFrom: "2026-06-01", inputMicrosPerMillion: 2, outputMicrosPerMillion: 2 };
  const late = { effectiveFrom: "2027-01-01", inputMicrosPerMillion: 3, outputMicrosPerMillion: 3 };
  const at = (iso: string) => new Date(iso);

  it.each([
    ["2026-05-31T23:59:59.999Z", early],
    ["2026-06-01T00:00:00.000Z", mid],
    ["2026-12-31T23:59:59.999Z", mid],
    ["2027-01-01T00:00:00.000Z", late],
  ])("at %s picks the latest entry that has started", (instant, expected) => {
    expect(priceInForce([early, mid, late], at(instant))).toBe(expected);
  });

  it("does not depend on the order of the entries", () => {
    expect(priceInForce([late, early, mid], at("2026-07-01T00:00:00.000Z"))).toBe(mid);
    expect(priceInForce([late, mid, early], at("2027-07-01T00:00:00.000Z"))).toBe(late);
  });

  it("is null when nothing has started yet, and for an empty list", () => {
    expect(priceInForce([mid, late], at("2026-01-01T00:00:00.000Z"))).toBeNull();
    expect(priceInForce([], at("2026-01-01T00:00:00.000Z"))).toBeNull();
  });
});

describe("isPriced", () => {
  it.each([
    ["gemini", "gemini-3.5-flash-lite", true],
    ["gemini", "gemini-3.8-flash", true],
    ["gemini", "gemini-9-ultra", false],
    ["gemini", "constructor", false],
    ["gemini", null, false],
    ["serpapi", null, true],
    ["wayback", null, true],
    ["retailer", null, true],
    ["openai", "gpt", false],
  ])("%s with model %s is %s", (provider, model, expected) => {
    expect(isPriced(provider, model)).toBe(expected);
  });

  it("answers from the table it is given", () => {
    const prices = {
      ...DEFAULT_PRICES,
      geminiTokenPrices: {
        "gemini-9-ultra": [
          { effectiveFrom: null, inputMicrosPerMillion: 1, outputMicrosPerMillion: 1 },
        ],
      },
    };
    expect(isPriced("gemini", "gemini-9-ultra", prices)).toBe(true);
    expect(isPriced("gemini", "gemini-3.8-flash", prices)).toBe(false);
  });
});

describe("isFreeProvider", () => {
  it.each([
    ["wayback", true],
    ["retailer", true],
    // Free while the per-call constant is zero.
    ["serpapi", SERPAPI_MICROS_PER_CALL === 0],
    ["gemini", false],
    ["openai", false],
  ])("%s is %s", (provider, expected) => {
    expect(isFreeProvider(provider)).toBe(expected);
  });
});
