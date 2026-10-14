import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRICES,
  GEMINI_TOKEN_PRICES,
  OPENAI_SEARCH_MICROS_PER_CALL,
  OPENAI_TOKEN_PRICES,
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
    expect(estimateCostMicros(call({ provider: "anthropic" }))).toEqual({
      costMicros: 0,
      priced: false,
    });
  });

  describe("OpenAI", () => {
    const openai = (patch: Partial<CostInput>, prices = DEFAULT_PRICES) =>
      estimateCostMicros(
        call({ provider: "openai", operation: "responses", model: "gpt-6-luna", ...patch }),
        prices,
      );

    it.each([
      // 1,000,000 input tokens on gpt-6-luna is USD 0.10.
      [{ inputTokens: 1_000_000, outputTokens: 0 }, 100_000],
      // 1,000,000 output tokens is USD 0.50.
      [{ inputTokens: 0, outputTokens: 1_000_000 }, 500_000],
      // The recorded S85H search: 44,210 in, 2,116 out is 4,421 + 1,058.
      [{ inputTokens: 44_210, outputTokens: 2_116 }, 5_479],
    ])("prices a responses call %j by its tokens at %d micro-dollars", (patch, expected) => {
      expect(openai(patch)).toEqual({ costMicros: expected, priced: true });
    });

    it("charges a successful web_search_call the per-call rate, USD 10 per 1,000", () => {
      expect(OPENAI_SEARCH_MICROS_PER_CALL).toBe(10_000);
      expect(DEFAULT_PRICES.openAiSearchMicrosPerCall).toBe(OPENAI_SEARCH_MICROS_PER_CALL);
      expect(openai({ operation: "web_search_call" })).toEqual({
        costMicros: 10_000,
        priced: true,
      });
    });

    it("charges a failed web_search_call nothing, as priced", () => {
      expect(openai({ operation: "web_search_call", outcome: "failed" })).toEqual({
        costMicros: 0,
        priced: true,
      });
    });

    it("charges a web_search_open_page row nothing, as priced, whatever its outcome", () => {
      // The provider bills per search query, not per page the model opened.
      expect(openai({ operation: "web_search_open_page" })).toEqual({
        costMicros: 0,
        priced: true,
      });
      expect(openai({ operation: "web_search_open_page", outcome: "failed" })).toEqual({
        costMicros: 0,
        priced: true,
      });
    });

    it("reports a web_search_open_page row of an unknown model as unpriced", () => {
      expect(openai({ operation: "web_search_open_page", model: "gpt-9-nova" }).priced).toBe(false);
    });

    it("ignores tokens on a web_search_call row", () => {
      expect(
        openai({ operation: "web_search_call", inputTokens: 1_000_000, outputTokens: 1_000_000 }),
      ).toEqual({ costMicros: 10_000, priced: true });
    });

    it("still prices a failed responses call by the tokens it reported", () => {
      expect(openai({ outcome: "failed", inputTokens: 1_000_000, outputTokens: 0 })).toEqual({
        costMicros: 100_000,
        priced: true,
      });
    });

    it.each(["responses", "web_search_call"])(
      "reports an unknown OpenAI model as unpriced at zero for %s",
      (operation) => {
        expect(openai({ operation, model: "gpt-9-nova", inputTokens: 1_000 })).toEqual({
          costMicros: 0,
          priced: false,
        });
        expect(openai({ operation, model: null }).priced).toBe(false);
      },
    );

    it("takes the OpenAI prices and the search rate from the table it is given", () => {
      const prices = {
        ...DEFAULT_PRICES,
        openAiTokenPrices: {
          "gpt-test": [
            { effectiveFrom: null, inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 0 },
          ],
        },
        openAiSearchMicrosPerCall: 25_000,
      };
      expect(openai({ model: "gpt-test", inputTokens: 250 }, prices)).toEqual({
        costMicros: 250,
        priced: true,
      });
      expect(openai({ model: "gpt-test", operation: "web_search_call" }, prices)).toEqual({
        costMicros: 25_000,
        priced: true,
      });
      expect(openai({ inputTokens: 250 }, prices).priced).toBe(false);
    });

    it("never charges a negative or fractional search rate", () => {
      const at = (rate: number) =>
        openai(
          { operation: "web_search_call" },
          { ...DEFAULT_PRICES, openAiSearchMicrosPerCall: rate },
        ).costMicros;
      expect(at(-5)).toBe(0);
      expect(at(9_999.6)).toBe(10_000);
    });

    it("holds the prices checked on 2026-10-13, opening with an undated entry", () => {
      expect(OPENAI_TOKEN_PRICES).toEqual({
        "gpt-6-luna": [
          { effectiveFrom: null, inputMicrosPerMillion: 100_000, outputMicrosPerMillion: 500_000 },
        ],
      });
      for (const entries of Object.values(OPENAI_TOKEN_PRICES)) {
        expect(entries[0].effectiveFrom).toBeNull();
      }
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
    ["openai", "gpt-6-luna", true],
    ["openai", "gpt", false],
    ["openai", null, false],
    ["anthropic", "claude", false],
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
    // Billed by the token and by the search; never free.
    ["openai", false],
    ["anthropic", false],
  ])("%s is %s", (provider, expected) => {
    expect(isFreeProvider(provider)).toBe(expected);
  });
});
