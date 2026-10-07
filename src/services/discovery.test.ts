import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { countOkCallsByOperation, type OkCallsByOperation } from "@/db/queries/api-usage";
import type { QueryDb } from "@/db/queries/db";
import { dayRangeIn, SYDNEY } from "@/lib/day-ranges";
import type { FetchLike } from "../sources/types";
import {
  MAX_QUERY_LENGTH as INDEX_MAX_QUERY_LENGTH,
  MAX_SEARCH_LIMIT,
  remember,
  rememberInspect,
  searchIndex,
  type IndexedProduct,
} from "./catalogue-index";
import {
  BUDGET_READ_TIMEOUT_MS,
  DEFAULT_SERPAPI_DAILY_CAP,
  discoverProducts,
  findProducts,
  INDEX_SUFFICIENT_MATCHES,
  INDEX_WRITE_TIMEOUT_MS,
  inspectCandidate,
  MAX_QUERY_LENGTH,
  SERPAPI_DAILY_CAP_ENV,
  serpApiBudget,
  type CountOkCalls,
  type StoreOutcomeFailed,
  type StoreOutcomeOk,
} from "./discovery";
import { NotFoundError, ValidationError } from "./errors";
import { searchableStorefronts } from "./tracked-products";
import { record } from "./usage";

/** The ledger's successful SerpApi calls today, by operation; the free account call is always among them. */
function ledgerRows(searches: number, immersive = 0): OkCallsByOperation[] {
  return [
    { operation: "account", count: 2 },
    ...(immersive > 0 ? [{ operation: "google_immersive_product", count: immersive }] : []),
    ...(searches > 0 ? [{ operation: "google_shopping", count: searches }] : []),
  ];
}

/** A counter answering with the given rows for every period. */
function countingOk(rows: OkCallsByOperation[]): CountOkCalls {
  return async () => rows;
}

const noSerpApiToday = countingOk(ledgerRows(0));

/** A handle that is never queried: the counter is injected, or its query is mocked below. */
const fakeDb = {} as QueryDb;

// The real recorder writes to the application database. No test here may
// reach one, so the default is replaced; tests of the ledger inject their own.
vi.mock("./usage", () => ({
  record: vi.fn(async () => undefined),
}));
// The budget's default counter is the ledger query; replaced so no test reaches a database.
vi.mock("@/db/queries/api-usage", () => ({
  countOkCallsByOperation: vi.fn(async () => ledgerRows(0)),
}));
// The real index writers and reader do too; tests of the index inject their own.
vi.mock("./catalogue-index", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./catalogue-index")>()),
  remember: vi.fn(async () => ({ written: 0 })),
  rememberInspect: vi.fn(async () => ({ written: 0 })),
  searchIndex: vi.fn(async (input: { query: string }) => ({
    query: input.query,
    queryKind: "text",
    gtin: null,
    products: [],
    total: 0,
  })),
}));

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../sources/fixtures/${name}`, import.meta.url)),
    "utf8",
  );
}

const jbLgC5 = fixture("jbhifi-suggest-lg-c5-65.json");
const jbGtinS85h = fixture("jbhifi-suggest-gtin-s85h.json");
const jbEmpty = fixture("jbhifi-suggest-empty.json");
const jbXboxSeriesS = fixture("jbhifi-suggest-xbox-series-s.json");
const jbDvdPlayer = fixture("jbhifi-suggest-dvd-player.json");
const powerlandXboxSeriesS = fixture("powerland-suggest-xbox-series-s.json");
const powerlandDvdPlayer = fixture("powerland-suggest-dvd-player.json");
const powerlandLgC5 = fixture("powerland-suggest-lg-c5-65.json");
const bingLee = fixture("binglee-challenge.html");
const jbS85hProduct = fixture("jbhifi-s85h-65.shopify.json");
const serpApiS85h = fixture("serpapi-google-shopping-s85h.json");

const JB_ORIGIN = "https://www.jbhifi.com.au";
const POWERLAND_ORIGIN = "https://powerland.com.au";
const SERPAPI_ORIGIN = "https://serpapi.com";
const JB_S85H_URL = `${JB_ORIGIN}/products/samsung-65-s85h-oled-4k-smart-ai-tv-2026`;
const S85H_GTIN = "8806097962670";
const FIXED_NOW = new Date("2026-10-06T01:02:03.000Z");

type Call = { url: string; init?: RequestInit };
type Responder = (url: string) => Response | Promise<Response>;

/** Routes by origin; a request to any other host is a test error. */
function fakeFetchByOrigin(routes: Record<string, Responder>, calls: Call[] = []): FetchLike {
  return async (url, init) => {
    calls.push({ url, init });
    const route = routes[new URL(url).origin];
    if (route === undefined) throw new Error(`Unexpected request to ${url}`);
    return route(url);
  };
}

function json(body: string, status = 200): Responder {
  return () => new Response(body, { status, headers: { "content-type": "application/json" } });
}

function html(body: string, status = 200): Responder {
  return () => new Response(body, { status, headers: { "content-type": "text/html" } });
}

const happyRoutes: Record<string, Responder> = {
  [JB_ORIGIN]: json(jbLgC5),
  [POWERLAND_ORIGIN]: json(powerlandLgC5),
};

function okStore(stores: { retailerSlug: string; status: string }[], slug: string): StoreOutcomeOk {
  const store = stores.find((candidate) => candidate.retailerSlug === slug);
  if (store === undefined || store.status !== "ok") throw new Error(`No ok outcome for ${slug}`);
  return store as StoreOutcomeOk;
}

function failedStore(
  stores: { retailerSlug: string; status: string }[],
  slug: string,
): StoreOutcomeFailed {
  const store = stores.find((candidate) => candidate.retailerSlug === slug);
  if (store === undefined || store.status !== "failed") {
    throw new Error(`No failed outcome for ${slug}`);
  }
  return store as StoreOutcomeFailed;
}

describe("findProducts", () => {
  beforeEach(() => {
    vi.mocked(record).mockClear();
  });

  it("asks every searchable storefront for a title and reports each side by side", async () => {
    const calls: Call[] = [];
    const report = await findProducts({
      query: "  LG C5 65 ",
      fetch: fakeFetchByOrigin(happyRoutes, calls),
      now: () => FIXED_NOW,
    });

    expect(report.query).toBe("LG C5 65");
    expect(report.queryKind).toBe("text");
    expect(report.gtin).toBeNull();
    expect(report.fetchedAt).toBe(FIXED_NOW);
    expect(report.stores.map((store) => [store.retailerSlug, store.status])).toEqual(
      searchableStorefronts.map((store) => [store.retailerSlug, "ok"]),
    );
    expect(report.total).toBe(7);

    const jb = okStore(report.stores, "jb-hi-fi");
    expect(jb.retailerName).toBe("JB Hi-Fi");
    expect(jb.origin).toBe(JB_ORIGIN);
    expect(jb.candidates).toHaveLength(4);
    // No title carries "C5", so every row is partial; the tightest title is first.
    expect(jb.candidates.map((entry) => entry.candidate.title)).toEqual([
      'LG 65" OLED AI B6 4K Smart TV [2026]',
      'LG 65" OLED EVO AI C6 4K Smart TV [2026]',
      'LG 65" OLED EVO AI G6 4K Smart TV [2026]',
      'LG 65" QNED70B AI Mini-LED 4K Smart TV [2026]',
    ]);
    expect(jb.candidates[1].candidate.priceCents).toBe(326600);
    expect(jb.candidates.every((entry) => entry.relevance.tier === "partial")).toBe(true);
    expect(jb.candidates.every((entry) => entry.relevance.missing.join() === "c5")).toBe(true);
    expect(jb.candidates.every((entry) => entry.trackedVariantSlug === null)).toBe(true);
    expect(jb.candidates.every((entry) => entry.matchedBy === null)).toBe(true);

    const powerland = okStore(report.stores, "powerland");
    expect(powerland.candidates).toHaveLength(3);
    expect(powerland.candidates.map((entry) => entry.candidate.identifiers.mpn)).toEqual([
      "OLED65B6PSA",
      "65QNED70BSA",
      "65QNED86BSA",
    ]);
    expect(report.tiers).toEqual({ match: 0, accessory: 0, partial: 7, unrelated: 0 });

    // One request per store, each to its own search endpoint.
    expect(calls.map((call) => new URL(call.url).origin).sort()).toEqual(
      [JB_ORIGIN, POWERLAND_ORIGIN].sort(),
    );
    expect(calls.every((call) => call.url.includes("/search/suggest.json?q=LG+C5+65"))).toBe(true);
  });

  it("judges each candidate against the query and orders a store's rows by tier then score", async () => {
    const report = await findProducts({
      query: "Xbox Series S",
      fetch: fakeFetchByOrigin({
        [JB_ORIGIN]: json(jbXboxSeriesS),
        [POWERLAND_ORIGIN]: json(powerlandXboxSeriesS),
      }),
      now: () => FIXED_NOW,
    });
    // The raw count is untouched; the tiers say how much of it answered the question.
    expect(report.total).toBe(20);
    expect(report.tiers).toEqual({ match: 2, accessory: 0, partial: 13, unrelated: 5 });

    const jb = okStore(report.stores, "jb-hi-fi");
    expect(jb.candidates.map((entry) => entry.relevance.tier)).toEqual([
      "match",
      "match",
      "partial",
      "partial",
      "partial",
      "partial",
      "partial",
      "unrelated",
      "unrelated",
      "unrelated",
    ]);
    expect(jb.candidates[0].candidate.title).toBe("Xbox Series S 512GB Console");
    expect(jb.candidates[0].relevance.reason).toBe("every word in the title");
    expect(jb.candidates[1].candidate.title).toBe("Xbox Series S 1TB Console (Robot White)");

    // Powerland knows no Xbox; its best row shares only "S-Series" with the query.
    const powerland = okStore(report.stores, "powerland");
    expect(powerland.candidates[0].candidate.title).toBe(
      "Samsung 5 Channel S-Series Soundbar HW-S61B/XY",
    );
    expect(powerland.candidates[0].relevance.tier).toBe("partial");
    expect(powerland.candidates.every((entry) => entry.relevance.tier !== "match")).toBe(true);
  });

  it("keeps every matching row and marks a store's unrelated answers as such", async () => {
    const report = await findProducts({
      query: "DVD player",
      fetch: fakeFetchByOrigin({
        [JB_ORIGIN]: json(jbDvdPlayer),
        [POWERLAND_ORIGIN]: json(powerlandDvdPlayer),
      }),
      now: () => FIXED_NOW,
    });
    expect(report.total).toBe(20);
    expect(report.tiers).toEqual({ match: 10, accessory: 0, partial: 0, unrelated: 10 });

    const jb = okStore(report.stores, "jb-hi-fi");
    expect(jb.candidates.every((entry) => entry.relevance.tier === "match")).toBe(true);
    // Equal scores fall back to the title, so the order is stable across runs.
    expect(jb.candidates[0].candidate.title).toBe("Blaupunkt DVD Player with HDMI");

    const powerland = okStore(report.stores, "powerland");
    expect(powerland.candidates.every((entry) => entry.relevance.tier === "unrelated")).toBe(true);
    expect(powerland.candidates[0].candidate.title).toBe(
      'Hisense 55" S7S Hi-QLED 4K Canvas TV 55S7SAU',
    );
    expect(powerland.candidates[0].relevance.reason).toBe("no query word in the title");
  });

  it("reports one store failing without hiding the other", async () => {
    const report = await findProducts({
      query: "LG C5 65",
      fetch: fakeFetchByOrigin({
        [JB_ORIGIN]: html(bingLee),
        [POWERLAND_ORIGIN]: json(powerlandLgC5),
      }),
      now: () => FIXED_NOW,
    });
    const jb = failedStore(report.stores, "jb-hi-fi");
    expect(jb.kind).toBe("blocked");
    expect(jb.message).toContain("bot challenge");
    expect(okStore(report.stores, "powerland").candidates).toHaveLength(3);
    expect(report.total).toBe(3);
  });

  it("reports a store whose fetch itself fails as a network failure", async () => {
    const report = await findProducts({
      query: "LG C5 65",
      fetch: fakeFetchByOrigin({
        [JB_ORIGIN]: () => {
          throw new Error("socket hang up");
        },
        [POWERLAND_ORIGIN]: json(jbEmpty),
      }),
      now: () => FIXED_NOW,
    });
    const jb = failedStore(report.stores, "jb-hi-fi");
    expect(jb.kind).toBe("network");
    expect(jb.message).toContain("socket hang up");
    expect(okStore(report.stores, "powerland").candidates).toEqual([]);
  });

  it("routes a GTIN query: sent as typed, reported in 14-digit form, and matched to the tracked variant by URL", async () => {
    const calls: Call[] = [];
    const report = await findProducts({
      query: S85H_GTIN,
      fetch: fakeFetchByOrigin(
        { [JB_ORIGIN]: json(jbGtinS85h), [POWERLAND_ORIGIN]: json(jbEmpty) },
        calls,
      ),
      now: () => FIXED_NOW,
    });

    expect(report.queryKind).toBe("gtin");
    expect(report.gtin).toBe("08806097962670");
    expect(report.query).toBe(S85H_GTIN);
    expect(calls.every((call) => call.url.includes(`q=${S85H_GTIN}&`))).toBe(true);

    const jb = okStore(report.stores, "jb-hi-fi");
    expect(jb.candidates).toHaveLength(1);
    expect(jb.candidates[0].candidate.url).toBe(JB_S85H_URL);
    // The suggest response carries no GTIN; the tracked page URL is what ties it to the variant.
    expect(jb.candidates[0].candidate.identifiers.gtin).toBeNull();
    expect(jb.candidates[0].trackedVariantSlug).toBe("samsung-s85h-65-au");
    expect(jb.candidates[0].matchedBy).toBe("url");
    // The title never carries the barcode; the store's own match is taken as a match.
    expect(jb.candidates[0].relevance).toEqual({
      tier: "match",
      score: 1,
      matched: [],
      missing: [],
      reason: "the store matched the barcode",
    });
    expect(report.tiers).toEqual({ match: 1, accessory: 0, partial: 0, unrelated: 0 });
  });

  it("matches a candidate to the tracked variant by model code when the title carries it", async () => {
    const suggest = JSON.stringify({
      resources: {
        results: {
          products: [
            {
              title: 'Samsung 65" S85H 4K Vision AI OLED Smart TV QA65S85HAEXXY',
              url: "/products/samsung-65-s85h-another-handle",
              price: "2888.00",
            },
          ],
        },
      },
    });
    const report = await findProducts({
      query: "S85H",
      fetch: fakeFetchByOrigin({ [JB_ORIGIN]: json(jbEmpty), [POWERLAND_ORIGIN]: json(suggest) }),
      now: () => FIXED_NOW,
    });
    const [entry] = okStore(report.stores, "powerland").candidates;
    expect(entry.trackedVariantSlug).toBe("samsung-s85h-65-au");
    expect(entry.matchedBy).toBe("mpn");
  });

  it("sends a digit string with a bad check digit as text", async () => {
    const calls: Call[] = [];
    const report = await findProducts({
      query: "8806097962671",
      fetch: fakeFetchByOrigin(
        { [JB_ORIGIN]: json(jbEmpty), [POWERLAND_ORIGIN]: json(jbEmpty) },
        calls,
      ),
      now: () => FIXED_NOW,
    });
    expect(report.queryKind).toBe("text");
    expect(report.gtin).toBeNull();
    expect(report.total).toBe(0);
    expect(calls).toHaveLength(2);
  });

  it("passes the limit to each store and defaults it to 10", async () => {
    const calls: Call[] = [];
    const fetch = fakeFetchByOrigin(
      { [JB_ORIGIN]: json(jbEmpty), [POWERLAND_ORIGIN]: json(jbEmpty) },
      calls,
    );
    await findProducts({ query: "LG", fetch, now: () => FIXED_NOW });
    await findProducts({ query: "LG", limit: 3, fetch, now: () => FIXED_NOW });
    expect(calls.slice(0, 2).every((call) => call.url.endsWith("resources%5Blimit%5D=10"))).toBe(
      true,
    );
    expect(calls.slice(2).every((call) => call.url.endsWith("resources%5Blimit%5D=3"))).toBe(true);
  });

  it("throws ValidationError for a blank query", async () => {
    await expect(findProducts({ query: "   " })).rejects.toBeInstanceOf(ValidationError);
    await expect(findProducts({ query: "" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("throws ValidationError for a query over 200 characters", async () => {
    await expect(findProducts({ query: "x".repeat(201) })).rejects.toBeInstanceOf(ValidationError);
  });

  it("throws ValidationError for a limit outside 1 to 20", async () => {
    await expect(findProducts({ query: "LG", limit: 0 })).rejects.toBeInstanceOf(ValidationError);
    await expect(findProducts({ query: "LG", limit: 21 })).rejects.toBeInstanceOf(ValidationError);
    await expect(findProducts({ query: "LG", limit: 2.5 })).rejects.toBeInstanceOf(ValidationError);
  });

  it("records one search call per store in the usage ledger, for no variant", async () => {
    const written: unknown[] = [];
    const report = await findProducts({
      query: "LG C5 65",
      fetch: fakeFetchByOrigin({
        [JB_ORIGIN]: html(bingLee),
        [POWERLAND_ORIGIN]: json(powerlandLgC5),
      }),
      now: () => FIXED_NOW,
      recordUsage: async (entry) => void written.push(entry),
    });
    expect(report.usage).toEqual({ calls: 2, recorded: 2 });
    expect(written).toHaveLength(2);
    expect(written).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "retailer",
          operation: "search",
          outcome: "failed",
          errorKind: "blocked",
          retailerSlug: "jb-hi-fi",
          variantSlug: null,
        }),
        expect.objectContaining({
          provider: "retailer",
          operation: "search",
          outcome: "ok",
          retailerSlug: "powerland",
          variantSlug: null,
        }),
      ]),
    );
  });

  it("uses usage.record when no recorder is given", async () => {
    await findProducts({
      query: "LG C5 65",
      fetch: fakeFetchByOrigin(happyRoutes),
      now: () => FIXED_NOW,
    });
    expect(record).toHaveBeenCalledTimes(2);
  });

  describe("remembering candidates in the catalogue index", () => {
    beforeEach(() => {
      vi.mocked(remember).mockClear();
    });

    it("writes every candidate the stores returned, source search, and reports the count", async () => {
      const batches: unknown[] = [];
      const report = await findProducts({
        query: "LG C5 65",
        fetch: fakeFetchByOrigin(happyRoutes),
        now: () => FIXED_NOW,
        rememberCandidates: async (input) => {
          batches.push(input);
          return { written: input.candidates.length };
        },
      });
      expect(report.remembered).toBe(7);
      expect(batches).toHaveLength(1);
      expect(batches[0]).toMatchObject({ source: "search" });
      expect((batches[0] as { candidates: unknown[] }).candidates).toHaveLength(7);
    });

    it("writes only the stores that answered", async () => {
      const batches: { candidates: { retailerSlug: string }[] }[] = [];
      const report = await findProducts({
        query: "LG C5 65",
        fetch: fakeFetchByOrigin({
          [JB_ORIGIN]: html(bingLee),
          [POWERLAND_ORIGIN]: json(powerlandLgC5),
        }),
        now: () => FIXED_NOW,
        rememberCandidates: async (input) => {
          batches.push(input);
          return { written: input.candidates.length };
        },
      });
      expect(report.remembered).toBe(3);
      expect(batches[0].candidates.every((c) => c.retailerSlug === "powerland")).toBe(true);
    });

    it("writes nothing when no store returned a candidate", async () => {
      const rememberCandidates = vi.fn(async () => ({ written: 0 }));
      const report = await findProducts({
        query: "LG C5 65",
        fetch: fakeFetchByOrigin({ [JB_ORIGIN]: json(jbEmpty), [POWERLAND_ORIGIN]: json(jbEmpty) }),
        now: () => FIXED_NOW,
        rememberCandidates,
      });
      expect(report.remembered).toBe(0);
      expect(rememberCandidates).not.toHaveBeenCalled();
    });

    it("still answers, with remembered 0, when the index cannot be written", async () => {
      const report = await findProducts({
        query: "LG C5 65",
        fetch: fakeFetchByOrigin(happyRoutes),
        now: () => FIXED_NOW,
        rememberCandidates: () => {
          throw new Error("index down");
        },
      });
      expect(report.total).toBe(7);
      expect(report.remembered).toBe(0);
      expect(report.usage).toEqual({ calls: 2, recorded: 2 });
    });

    it("uses catalogue-index.remember when none is given", async () => {
      await findProducts({
        query: "LG C5 65",
        fetch: fakeFetchByOrigin(happyRoutes),
        now: () => FIXED_NOW,
      });
      expect(remember).toHaveBeenCalledTimes(1);
      expect(vi.mocked(remember).mock.calls[0][0]).toMatchObject({ source: "search" });
    });

    describe("an index that never answers", () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      /** Resolves to "pending" if the promise has not settled after everything queued has run. */
      async function stateOf<T>(promise: Promise<T>): Promise<T | "pending"> {
        const pending = Symbol("pending");
        await vi.advanceTimersByTimeAsync(0);
        const first = await Promise.race([promise, Promise.resolve(pending)]);
        return first === pending ? "pending" : (first as T);
      }

      it("waits two seconds and no longer", () => {
        expect(INDEX_WRITE_TIMEOUT_MS).toBe(2_000);
      });

      it("returns once the bound passes, with remembered 0", async () => {
        const report = findProducts({
          query: "LG C5 65",
          fetch: fakeFetchByOrigin(happyRoutes),
          now: () => FIXED_NOW,
          rememberCandidates: () => new Promise(() => {}),
        });
        await vi.advanceTimersByTimeAsync(INDEX_WRITE_TIMEOUT_MS - 1);
        expect(await stateOf(report)).toBe("pending");
        await vi.advanceTimersByTimeAsync(1);
        const settled = await report;
        expect(settled.total).toBe(7);
        expect(settled.remembered).toBe(0);
      });
    });
  });
});

describe("inspectCandidate", () => {
  beforeEach(() => {
    vi.mocked(record).mockClear();
  });

  it("reads the product JSON and reports the GTIN, SKU and the tracked variant it matches", async () => {
    const calls: Call[] = [];
    const written: unknown[] = [];
    const report = await inspectCandidate({
      retailerSlug: "jb-hi-fi",
      url: `${JB_S85H_URL}?_pos=1&_psq=8806097962670&_ss=e`,
      fetch: fakeFetchByOrigin({ [JB_ORIGIN]: json(jbS85hProduct) }, calls),
      now: () => FIXED_NOW,
      recordUsage: async (entry) => void written.push(entry),
    });

    expect(calls.map((call) => call.url)).toEqual([`${JB_S85H_URL}.json`]);
    expect(report.retailerSlug).toBe("jb-hi-fi");
    expect(report.url).toBe(JB_S85H_URL);
    expect(report.fetchedAt).toBe(FIXED_NOW);
    expect(report.outcome.status).toBe("ok");
    if (report.outcome.status !== "ok") throw new Error("unreachable");
    expect(report.outcome.quote.identifiers).toEqual({
      gtin: "08806097962670",
      mpn: null,
      retailerSku: "902825",
    });
    expect(report.outcome.quote.priceCents).toBe(279500);
    expect(report.outcome.trackedVariantSlug).toBe("samsung-s85h-65-au");
    expect(report.outcome.matchedBy).toBe("gtin");
    expect(report.usage).toEqual({ calls: 1, recorded: 1 });
    expect(written[0]).toMatchObject({
      provider: "retailer",
      operation: "page",
      outcome: "ok",
      retailerSlug: "jb-hi-fi",
      variantSlug: "samsung-s85h-65-au",
    });
  });

  it("remembers the inspected product in the catalogue index and reports it", async () => {
    const inputs: unknown[] = [];
    const report = await inspectCandidate({
      retailerSlug: "jb-hi-fi",
      url: JB_S85H_URL,
      fetch: fakeFetchByOrigin({ [JB_ORIGIN]: json(jbS85hProduct) }),
      now: () => FIXED_NOW,
      recordUsage: async () => undefined,
      rememberInspected: async (input) => {
        inputs.push(input);
        return { written: 1 };
      },
    });
    expect(report.remembered).toBe(1);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      quote: { identifiers: { gtin: "08806097962670", retailerSku: "902825" } },
    });
  });

  it("remembers nothing when the page could not be read, and still answers when the index cannot be written", async () => {
    const rememberInspected = vi.fn(async () => ({ written: 1 }));
    const failed = await inspectCandidate({
      retailerSlug: "powerland",
      url: `${POWERLAND_ORIGIN}/products/gone`,
      fetch: fakeFetchByOrigin({ [POWERLAND_ORIGIN]: html("not found", 404) }),
      now: () => FIXED_NOW,
      recordUsage: async () => undefined,
      rememberInspected,
    });
    expect(failed.remembered).toBe(0);
    expect(rememberInspected).not.toHaveBeenCalled();

    const unwritten = await inspectCandidate({
      retailerSlug: "jb-hi-fi",
      url: JB_S85H_URL,
      fetch: fakeFetchByOrigin({ [JB_ORIGIN]: json(jbS85hProduct) }),
      now: () => FIXED_NOW,
      recordUsage: async () => undefined,
      rememberInspected: async () => {
        throw new Error("index down");
      },
    });
    expect(unwritten.outcome.status).toBe("ok");
    expect(unwritten.remembered).toBe(0);
  });

  it("uses catalogue-index.rememberInspect when none is given", async () => {
    vi.mocked(rememberInspect).mockClear();
    await inspectCandidate({
      retailerSlug: "jb-hi-fi",
      url: JB_S85H_URL,
      fetch: fakeFetchByOrigin({ [JB_ORIGIN]: json(jbS85hProduct) }),
      now: () => FIXED_NOW,
      recordUsage: async () => undefined,
    });
    expect(rememberInspect).toHaveBeenCalledTimes(1);
  });

  it("reports a page that cannot be read as a failed outcome, not an error", async () => {
    const report = await inspectCandidate({
      retailerSlug: "powerland",
      url: `${POWERLAND_ORIGIN}/products/gone`,
      fetch: fakeFetchByOrigin({ [POWERLAND_ORIGIN]: html("not found", 404) }),
      now: () => FIXED_NOW,
      recordUsage: async () => undefined,
    });
    expect(report.outcome).toEqual({
      status: "failed",
      kind: "http",
      message: `${POWERLAND_ORIGIN}/products/gone.json answered 404`,
    });
    expect(report.usage).toEqual({ calls: 1, recorded: 1 });
  });

  it("throws NotFoundError for a store that is not searchable", async () => {
    await expect(
      inspectCandidate({ retailerSlug: "bing-lee", url: "https://www.binglee.com.au/products/x" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws ValidationError for a URL on another host, before any request", async () => {
    const calls: Call[] = [];
    await expect(
      inspectCandidate({
        retailerSlug: "jb-hi-fi",
        url: "https://evil.example/products/x",
        fetch: fakeFetchByOrigin({}, calls),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      inspectCandidate({
        retailerSlug: "jb-hi-fi",
        url: "https://jbhifi.com.au.evil.example/products/x",
        fetch: fakeFetchByOrigin({}, calls),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toHaveLength(0);
  });

  it("throws ValidationError for a path on the store that is not a product page, before any request", async () => {
    const calls: Call[] = [];
    for (const path of ["/admin", "/collections/tvs", "/", "/product/x", "/products"]) {
      await expect(
        inspectCandidate({
          retailerSlug: "jb-hi-fi",
          url: `${JB_ORIGIN}${path}`,
          fetch: fakeFetchByOrigin({}, calls),
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    }
    expect(calls).toHaveLength(0);
  });

  it("throws ValidationError for a URL that is not absolute http(s)", async () => {
    await expect(
      inspectCandidate({ retailerSlug: "jb-hi-fi", url: "/products/x" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      inspectCandidate({ retailerSlug: "jb-hi-fi", url: "ftp://www.jbhifi.com.au/products/x" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

// ---------- discoverProducts: the index first, then the stores and Google Shopping ----------

/** One product as the index reports it, with as many offers as `stores` names. */
function indexedProduct(
  key: string,
  tier: IndexedProduct["relevance"]["tier"],
  stores: string[] = ["powerland"],
): IndexedProduct {
  return {
    key,
    title: `Product ${key}`,
    brand: "Samsung",
    mpn: null,
    gtin: null,
    imageUrl: null,
    offers: stores.map((retailerSlug) => ({
      retailerSlug,
      retailerName: retailerSlug,
      priceCents: 100000,
      compareAtCents: null,
      available: true,
      canonicalUrl: `https://${retailerSlug}.example/products/${key}`,
      lastSeenAt: FIXED_NOW,
      source: "search",
      via: "storefront",
    })),
    cheapest: { retailerSlug: stores[0], priceCents: 100000 },
    relevance: { tier, score: 1, matched: [], missing: [], reason: "test" },
    trackedVariantSlug: null,
    matchedBy: null,
  };
}

/** An index that answers `first` on the first search and `second` after the sources were remembered. */
function fakeIndex(first: IndexedProduct[], second: IndexedProduct[] = first) {
  const calls: unknown[] = [];
  const search: typeof searchIndex = vi.fn(async (input) => {
    calls.push(input);
    const products = calls.length === 1 ? first : second;
    return {
      query: input.query,
      queryKind: "text" as const,
      gtin: null,
      products,
      total: products.length,
    };
  });
  return { search, calls };
}

const threeMatches = [
  indexedProduct("a", "match"),
  indexedProduct("b", "match"),
  indexedProduct("c", "match"),
];
const twoMatches = [indexedProduct("a", "match"), indexedProduct("b", "match")];

/** Every source answering: both stores and Google Shopping, from the recorded fixtures. */
const fanoutRoutes: Record<string, Responder> = {
  [JB_ORIGIN]: json(jbLgC5),
  [POWERLAND_ORIGIN]: json(powerlandLgC5),
  [SERPAPI_ORIGIN]: json(serpApiS85h),
};

function serpApiCalls(calls: Call[]): URL[] {
  return calls.map((call) => new URL(call.url)).filter((url) => url.origin === SERPAPI_ORIGIN);
}

describe("discoverProducts", () => {
  beforeEach(() => {
    vi.stubEnv("SERPAPI_API_KEY", "sk-test-0123456789abcdef");
    vi.stubEnv(SERPAPI_DAILY_CAP_ENV, "");
    vi.mocked(record).mockClear();
    vi.mocked(countOkCallsByOperation).mockClear();
    vi.mocked(searchIndex).mockClear();
    vi.mocked(remember).mockClear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("answers from the index, with no external call and no budget read, when it holds three matching products", async () => {
    const calls: Call[] = [];
    const { search, calls: searches } = fakeIndex(threeMatches);
    const countOkCalls = vi.fn(countingOk(ledgerRows(3)));
    const report = await discoverProducts({
      query: "  samsung 65 ",
      fetch: fakeFetchByOrigin({}, calls),
      now: () => FIXED_NOW,
      searchIndex: search,
      countOkCalls,
    });

    expect(INDEX_SUFFICIENT_MATCHES).toBe(3);
    expect(calls).toEqual([]);
    expect(searches).toEqual([{ query: "samsung 65", limit: MAX_SEARCH_LIMIT, db: undefined }]);
    expect(report).toEqual({
      query: "samsung 65",
      queryKind: "text",
      gtin: null,
      fetchedAt: FIXED_NOW,
      source: "index",
      products: threeMatches,
      total: 3,
      googleShopping: { status: "skipped", reason: "index_sufficient" },
      storefronts: null,
      budget: null,
      usage: { calls: 0, recorded: 0 },
      candidates: [],
      found: 0,
      remembered: 0,
    });
    expect(remember).not.toHaveBeenCalled();
    // The free path never waits on the ledger.
    expect(countOkCalls).not.toHaveBeenCalled();
  });

  it("asks the stores and Google Shopping together when the index holds fewer than three matches, remembers everything and searches the index again", async () => {
    const calls: Call[] = [];
    const batches: { candidates: { retailerSlug: string; method: string }[]; source: string }[] =
      [];
    const merged = [indexedProduct("m", "match", ["jb-hi-fi", "the-good-guys"])];
    const { search, calls: searches } = fakeIndex(twoMatches, merged);
    const periods: { provider: string; from: Date; to: Date }[] = [];
    let ledgerOk = 3;
    const report = await discoverProducts({
      query: "Samsung QA65S85HAEXXY",
      fetch: fakeFetchByOrigin(fanoutRoutes, calls),
      now: () => FIXED_NOW,
      searchIndex: search,
      recordUsage: async () => {
        ledgerOk += 1;
      },
      countOkCalls: async (period) => {
        periods.push(period);
        return ledgerRows(ledgerOk);
      },
      rememberCandidates: async (input) => {
        batches.push(input);
        return { written: input.candidates.length };
      },
    });

    // One request per storefront and one hop-1 request to SerpApi, never the immersive hop.
    expect(calls.map((call) => new URL(call.url).origin).sort()).toEqual(
      [JB_ORIGIN, POWERLAND_ORIGIN, SERPAPI_ORIGIN].sort(),
    );
    const [serpApi] = serpApiCalls(calls);
    expect(serpApi.searchParams.get("engine")).toBe("google_shopping");
    expect(serpApi.searchParams.get("q")).toBe("Samsung QA65S85HAEXXY");
    expect(serpApi.searchParams.get("gl")).toBe("au");

    expect(report.source).toBe("fanout");
    expect(report.storefronts?.map((store) => [store.retailerSlug, store.status])).toEqual(
      searchableStorefronts.map((store) => [store.retailerSlug, "ok"]),
    );
    expect(report.googleShopping.status).toBe("ok");
    if (report.googleShopping.status !== "ok") throw new Error("unreachable");
    expect(report.googleShopping.found).toBe(5);
    expect(report.googleShopping.candidates).toHaveLength(5);
    expect(
      report.googleShopping.candidates.every(
        (entry) => entry.candidate.method === "google_shopping",
      ),
    ).toBe(true);
    // Judged like a store's answer: the Good Guys title carries "Samsung" but not the code.
    expect(report.googleShopping.candidates[0].relevance.tier).toBe("partial");

    // Both sources' candidates, one batch, source search, then the index is searched again.
    expect(report.found).toBe(12);
    expect(report.remembered).toBe(12);
    expect(batches).toHaveLength(1);
    expect(batches[0].source).toBe("search");
    expect(batches[0].candidates.filter((c) => c.method === "google_shopping")).toHaveLength(5);
    expect(batches[0].candidates.filter((c) => c.method === "storefront_search")).toHaveLength(7);
    expect(searches).toHaveLength(2);
    expect(report.products).toEqual(merged);
    expect(report.total).toBe(1);

    // Three calls, all recorded; the budget is re-read after the ledger was written.
    expect(report.usage).toEqual({ calls: 3, recorded: 3 });
    expect(periods).toHaveLength(2);
    expect(periods.every((period) => period.provider === "serpapi")).toBe(true);
    expect(report.budget).toEqual({ cap: 20, capSource: "default", usedToday: 6, remaining: 14 });
    expect(JSON.stringify(report)).not.toContain("sk-test");
  });

  describe("ranking every source's candidates in one list", () => {
    /** A predictive search answer listing `titles`, every one a Sony priced $100. */
    function storeAnswer(titles: string[]): Responder {
      const products = titles.map((title, index) => ({
        title,
        handle: `sony-${index}`,
        url: `/products/sony-${index}`,
        price: "100.00",
        vendor: "Sony",
        type: "TV",
        available: true,
        variants: [],
      }));
      return json(JSON.stringify({ resources: { results: { products } } }));
    }

    /** A Google Shopping answer: one result per [title, seller]. */
    function googleAnswer(results: [string, string][]): Responder {
      const shopping_results = results.map(([title, source], index) => ({
        position: index + 1,
        title,
        product_id: String(index + 1),
        product_link: `https://www.google.com.au/search?prds=${index + 1}`,
        source,
        price: "$100.00",
        extracted_price: 100,
      }));
      return json(JSON.stringify({ search_metadata: { status: "Success" }, shopping_results }));
    }

    async function discover(routes: Record<string, Responder>) {
      return discoverProducts({
        query: "sony bravia 8",
        fetch: fakeFetchByOrigin(routes),
        now: () => FIXED_NOW,
        searchIndex: fakeIndex([]).search,
        countOkCalls: noSerpApiToday,
        recordUsage: async () => undefined,
        rememberCandidates: async (input) => ({ written: input.candidates.length }),
      });
    }

    /** "tier score | title | store | via position", one line per ranked candidate. */
    function lines(report: Awaited<ReturnType<typeof discoverProducts>>): string[] {
      return report.candidates.map(
        (entry) =>
          `${entry.relevance.tier} ${entry.relevance.score} | ${entry.candidate.title} | ${entry.retailerName} | ${entry.via} ${entry.position}`,
      );
    }

    it("interleaves storefront and Google rows by tier, then score, then title, then the store's name", async () => {
      const report = await discover({
        [JB_ORIGIN]: storeAnswer([
          "Sony speaker",
          "Sony Bravia 8 Wall Mount",
          "Sony Bravia 8 55 TV",
        ]),
        [POWERLAND_ORIGIN]: storeAnswer(["Sony Bravia 8 55 TV"]),
        [SERPAPI_ORIGIN]: googleAnswer([
          ["Sony Bravia 8 TV", "Bing Lee"],
          ["Sony Bravia 8 55 TV", "Appliances Online"],
        ]),
      });

      expect(lines(report)).toEqual([
        // The highest score leads, whichever source it came from.
        "match 5.9 | Sony Bravia 8 TV | Bing Lee | google_shopping 0",
        // One title at one score from three stores: the store's name decides.
        "match 5.8 | Sony Bravia 8 55 TV | Appliances Online | google_shopping 1",
        "match 5.8 | Sony Bravia 8 55 TV | JB Hi-Fi | storefront 0",
        "match 5.8 | Sony Bravia 8 55 TV | Powerland | storefront 0",
        // A better tier beats a higher score.
        "accessory 5.8 | Sony Bravia 8 Wall Mount | JB Hi-Fi | storefront 1",
        "partial 0.9 | Sony speaker | JB Hi-Fi | storefront 2",
      ]);
      expect(report.candidates).toHaveLength(report.found);
    });

    it("places a Google row under the seller Google named, and a storefront row under the store", async () => {
      const report = await discover({
        [JB_ORIGIN]: storeAnswer(["Sony Bravia 8 55 TV"]),
        [POWERLAND_ORIGIN]: storeAnswer([]),
        [SERPAPI_ORIGIN]: googleAnswer([["Sony Bravia 8 TV", "Bing Lee"]]),
      });

      expect(report.candidates).toEqual([
        expect.objectContaining({
          retailerSlug: "bing-lee",
          retailerName: "Bing Lee",
          via: "google_shopping",
          position: 0,
          trackedVariantSlug: null,
          matchedBy: null,
          candidate: expect.objectContaining({ method: "google_shopping" }),
        }),
        expect.objectContaining({
          retailerSlug: "jb-hi-fi",
          retailerName: "JB Hi-Fi",
          via: "storefront",
          position: 0,
          candidate: expect.objectContaining({ method: "storefront_search" }),
        }),
      ]);
    });

    it("adds nothing for a store that failed or a Google search that was skipped", async () => {
      vi.stubEnv("SERPAPI_API_KEY", "");
      const report = await discover({
        [JB_ORIGIN]: html(bingLee, 403),
        [POWERLAND_ORIGIN]: storeAnswer(["Sony Bravia 8 55 TV"]),
      });

      expect(report.googleShopping).toEqual({ status: "skipped", reason: "no_key" });
      expect(report.storefronts?.map((store) => store.status)).toEqual(["failed", "ok"]);
      expect(lines(report)).toEqual(["match 5.8 | Sony Bravia 8 55 TV | Powerland | storefront 0"]);
    });
  });

  it("skips Google Shopping when the daily cap is reached and still asks the stores", async () => {
    const calls: Call[] = [];
    const countOkCalls = vi.fn(countingOk(ledgerRows(DEFAULT_SERPAPI_DAILY_CAP)));
    const report = await discoverProducts({
      query: "LG C5 65",
      fetch: fakeFetchByOrigin(fanoutRoutes, calls),
      now: () => FIXED_NOW,
      searchIndex: fakeIndex([]).search,
      recordUsage: async () => undefined,
      countOkCalls,
    });
    expect(serpApiCalls(calls)).toEqual([]);
    expect(report.googleShopping).toEqual({ status: "skipped", reason: "cap_reached" });
    expect(report.storefronts?.every((store) => store.status === "ok")).toBe(true);
    expect(report.found).toBe(7);
    expect(report.usage).toEqual({ calls: 2, recorded: 2 });
    expect(report.budget).toEqual({ cap: 20, capSource: "default", usedToday: 20, remaining: 0 });
    // Nothing was spent, so the budget is not read again.
    expect(countOkCalls).toHaveBeenCalledTimes(1);
  });

  it("counts the immersive hop as spend and the account call as nothing", async () => {
    const calls: Call[] = [];
    const report = await discoverProducts({
      query: "LG C5 65",
      fetch: fakeFetchByOrigin(fanoutRoutes, calls),
      now: () => FIXED_NOW,
      searchIndex: fakeIndex([]).search,
      recordUsage: async () => undefined,
      // 19 searches and 1 immersive hop make 20; the 2 account calls would make 22.
      countOkCalls: countingOk(ledgerRows(19, 1)),
    });
    expect(serpApiCalls(calls)).toEqual([]);
    expect(report.googleShopping).toEqual({ status: "skipped", reason: "cap_reached" });
    expect(report.budget).toEqual({ cap: 20, capSource: "default", usedToday: 20, remaining: 0 });
  });

  it("honours a lower cap from the environment", async () => {
    vi.stubEnv(SERPAPI_DAILY_CAP_ENV, "2");
    const calls: Call[] = [];
    const report = await discoverProducts({
      query: "LG C5 65",
      fetch: fakeFetchByOrigin(fanoutRoutes, calls),
      now: () => FIXED_NOW,
      searchIndex: fakeIndex([]).search,
      recordUsage: async () => undefined,
      countOkCalls: countingOk(ledgerRows(2)),
    });
    expect(serpApiCalls(calls)).toEqual([]);
    expect(report.googleShopping).toEqual({ status: "skipped", reason: "cap_reached" });
    expect(report.budget).toEqual({ cap: 2, capSource: "env", usedToday: 2, remaining: 0 });
  });

  it("ignores a malformed cap, keeps the default and says so, and still asks Google Shopping", async () => {
    vi.stubEnv(SERPAPI_DAILY_CAP_ENV, "lots");
    const calls: Call[] = [];
    const report = await discoverProducts({
      query: "LG C5 65",
      fetch: fakeFetchByOrigin(fanoutRoutes, calls),
      now: () => FIXED_NOW,
      searchIndex: fakeIndex([]).search,
      recordUsage: async () => undefined,
      countOkCalls: countingOk(ledgerRows(1)),
    });
    expect(serpApiCalls(calls)).toHaveLength(1);
    expect(report.googleShopping.status).toBe("ok");
    expect(report.budget).toEqual({ cap: 20, capSource: "invalid", usedToday: 1, remaining: 19 });
  });

  it("skips Google Shopping, with reason budget_unknown and no budget, when the ledger cannot be read, and still asks the stores", async () => {
    const calls: Call[] = [];
    const report = await discoverProducts({
      query: "LG C5 65",
      fetch: fakeFetchByOrigin(fanoutRoutes, calls),
      now: () => FIXED_NOW,
      searchIndex: fakeIndex([]).search,
      recordUsage: async () => undefined,
      countOkCalls: async () => {
        throw new Error("connection refused");
      },
    });
    expect(serpApiCalls(calls)).toEqual([]);
    expect(report.source).toBe("fanout");
    expect(report.googleShopping).toEqual({ status: "skipped", reason: "budget_unknown" });
    expect(report.budget).toBeNull();
    expect(report.storefronts?.every((store) => store.status === "ok")).toBe(true);
    expect(report.found).toBe(7);
    expect(report.usage).toEqual({ calls: 2, recorded: 2 });
  });

  it("treats a budget read that never answers as budget_unknown, so the next search is not held behind it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const hanging = {
        query: "LG C5 65",
        fetch: fakeFetchByOrigin(fanoutRoutes),
        now: () => FIXED_NOW,
        searchIndex: fakeIndex([]).search,
        recordUsage: async () => undefined,
        countOkCalls: () => new Promise<OkCallsByOperation[]>(() => undefined),
      };
      const first = discoverProducts(hanging);
      const second = discoverProducts(hanging);
      await vi.advanceTimersByTimeAsync(2 * BUDGET_READ_TIMEOUT_MS);
      const reports = await Promise.all([first, second]);
      for (const report of reports) {
        expect(report.googleShopping).toEqual({ status: "skipped", reason: "budget_unknown" });
        expect(report.storefronts?.every((store) => store.status === "ok")).toBe(true);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the first budget reading when the re-read after a Google answer fails", async () => {
    let reads = 0;
    const report = await discoverProducts({
      query: "LG C5 65",
      fetch: fakeFetchByOrigin(fanoutRoutes),
      now: () => FIXED_NOW,
      searchIndex: fakeIndex([]).search,
      recordUsage: async () => undefined,
      countOkCalls: async () => {
        reads += 1;
        if (reads > 1) throw new Error("connection refused");
        return ledgerRows(4);
      },
    });
    expect(report.googleShopping.status).toBe("ok");
    expect(reads).toBe(2);
    expect(report.budget).toEqual({ cap: 20, capSource: "default", usedToday: 4, remaining: 16 });
  });

  it("lets only one of two concurrent searches spend the last search under the cap", async () => {
    vi.stubEnv(SERPAPI_DAILY_CAP_ENV, "1");
    const calls: Call[] = [];
    const ledger: { provider: string; operation: string; outcome: string }[] = [];
    // The ledger as the budget reads it: every successful SerpApi search recorded so far.
    const countOkCalls: CountOkCalls = async () =>
      ledgerRows(
        ledger.filter(
          (call) =>
            call.provider === "serpapi" &&
            call.operation === "google_shopping" &&
            call.outcome === "ok",
        ).length,
      );
    const search = (query: string) =>
      discoverProducts({
        query,
        fetch: fakeFetchByOrigin(fanoutRoutes, calls),
        now: () => FIXED_NOW,
        searchIndex: fakeIndex([]).search,
        recordUsage: async (call) => {
          ledger.push({
            provider: call.provider,
            operation: call.operation,
            outcome: call.outcome,
          });
        },
        countOkCalls,
      });

    const [first, second] = await Promise.all([search("LG C5 65"), search("LG C5 55")]);

    expect(serpApiCalls(calls)).toHaveLength(1);
    const outcomes = [first.googleShopping, second.googleShopping];
    expect(outcomes.filter((outcome) => outcome.status === "ok")).toHaveLength(1);
    expect(outcomes).toContainEqual({ status: "skipped", reason: "cap_reached" });
    // The stores were asked by both: only the paid call waits its turn.
    expect(first.storefronts?.every((store) => store.status === "ok")).toBe(true);
    expect(second.storefronts?.every((store) => store.status === "ok")).toBe(true);
  });

  it("asks the stores while another search holds the paid call", async () => {
    let releaseGoogle: () => void = () => undefined;
    const googleHeld = new Promise<void>((resolve) => {
      releaseGoogle = resolve;
    });
    const storeOrigins: string[] = [];
    const slowGoogle = fakeFetchByOrigin({
      ...fanoutRoutes,
      [SERPAPI_ORIGIN]: async (url) => {
        await googleHeld;
        return json(serpApiS85h)(url);
      },
    });
    const first = discoverProducts({
      query: "LG C5 65",
      fetch: slowGoogle,
      now: () => FIXED_NOW,
      searchIndex: fakeIndex([]).search,
      recordUsage: async () => undefined,
      countOkCalls: noSerpApiToday,
    });
    const second = discoverProducts({
      query: "LG C5 55",
      fetch: fakeFetchByOrigin({
        ...fanoutRoutes,
        [JB_ORIGIN]: (url) => {
          storeOrigins.push(JB_ORIGIN);
          return json(jbLgC5)(url);
        },
        [POWERLAND_ORIGIN]: (url) => {
          storeOrigins.push(POWERLAND_ORIGIN);
          return json(powerlandLgC5)(url);
        },
      }),
      now: () => FIXED_NOW,
      searchIndex: fakeIndex([]).search,
      recordUsage: async () => undefined,
      countOkCalls: noSerpApiToday,
    });
    // The first search's Google call is still out, yet the second has asked both stores.
    await vi.waitFor(() => expect(storeOrigins).toHaveLength(2));
    releaseGoogle();
    const reports = await Promise.all([first, second]);
    expect(reports.map((report) => report.googleShopping.status)).toEqual(["ok", "ok"]);
  });

  it("skips Google Shopping without a key, from the environment or the argument", async () => {
    vi.stubEnv("SERPAPI_API_KEY", "");
    const calls: Call[] = [];
    const report = await discoverProducts({
      query: "LG C5 65",
      fetch: fakeFetchByOrigin(fanoutRoutes, calls),
      now: () => FIXED_NOW,
      searchIndex: fakeIndex([]).search,
      recordUsage: async () => undefined,
      countOkCalls: noSerpApiToday,
    });
    expect(serpApiCalls(calls)).toEqual([]);
    expect(report.googleShopping).toEqual({ status: "skipped", reason: "no_key" });
    expect(report.found).toBe(7);
    expect(report.budget).toEqual({ cap: 20, capSource: "default", usedToday: 0, remaining: 20 });

    const given = await discoverProducts({
      query: "LG C5 65",
      serpApiKey: "sk-given",
      fetch: fakeFetchByOrigin(fanoutRoutes, calls),
      now: () => FIXED_NOW,
      searchIndex: fakeIndex([]).search,
      recordUsage: async () => undefined,
      countOkCalls: noSerpApiToday,
    });
    expect(given.googleShopping.status).toBe("ok");
    expect(serpApiCalls(calls)[0].searchParams.get("api_key")).toBe("sk-given");
  });

  it("reports a Google Shopping failure without hiding the storefront results", async () => {
    const written: { provider: string; outcome: string }[] = [];
    const report = await discoverProducts({
      query: "LG C5 65",
      fetch: fakeFetchByOrigin({
        ...fanoutRoutes,
        [SERPAPI_ORIGIN]: json(JSON.stringify({ error: "Your account has run out of searches." })),
      }),
      now: () => FIXED_NOW,
      searchIndex: fakeIndex([]).search,
      recordUsage: async (entry) => void written.push(entry),
      countOkCalls: countingOk(ledgerRows(1)),
    });
    expect(report.googleShopping).toEqual({
      status: "failed",
      kind: "http",
      message: "SerpApi answered: Your account has run out of searches.",
    });
    expect(report.storefronts?.every((store) => store.status === "ok")).toBe(true);
    expect(report.found).toBe(7);
    expect(report.usage).toEqual({ calls: 3, recorded: 3 });
    expect(written).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "serpapi", outcome: "failed", errorKind: "http" }),
      ]),
    );
  });

  it("never puts the key in a report: ok, failed or skipped", async () => {
    vi.stubEnv("SERPAPI_API_KEY", "");
    const serpApiKey = "sk-secret-key-0123456789";
    const common = {
      query: "LG C5 65",
      serpApiKey,
      now: () => FIXED_NOW,
      recordUsage: async () => undefined,
    };
    const ok = await discoverProducts({
      ...common,
      fetch: fakeFetchByOrigin(fanoutRoutes),
      searchIndex: fakeIndex([]).search,
      countOkCalls: noSerpApiToday,
    });
    expect(ok.googleShopping.status).toBe("ok");

    const failed = await discoverProducts({
      ...common,
      fetch: fakeFetchByOrigin({ ...fanoutRoutes, [SERPAPI_ORIGIN]: html("gone", 404) }),
      searchIndex: fakeIndex([]).search,
      countOkCalls: noSerpApiToday,
    });
    expect(failed.googleShopping.status).toBe("failed");

    const skipped = await discoverProducts({
      ...common,
      fetch: fakeFetchByOrigin(fanoutRoutes),
      searchIndex: fakeIndex([]).search,
      countOkCalls: countingOk(ledgerRows(DEFAULT_SERPAPI_DAILY_CAP)),
    });
    expect(skipped.googleShopping).toEqual({ status: "skipped", reason: "cap_reached" });

    for (const report of [ok, failed, skipped]) {
      const text = JSON.stringify(report);
      expect(text).not.toContain(serpApiKey);
      expect(text).not.toContain("sk-secret");
    }
  });

  it("reports a store failing beside a Google answer", async () => {
    const report = await discoverProducts({
      query: "LG C5 65",
      fetch: fakeFetchByOrigin({ ...fanoutRoutes, [JB_ORIGIN]: html(bingLee) }),
      now: () => FIXED_NOW,
      searchIndex: fakeIndex([]).search,
      recordUsage: async () => undefined,
      countOkCalls: noSerpApiToday,
    });
    expect(report.storefronts && failedStore(report.storefronts, "jb-hi-fi").kind).toBe("blocked");
    expect(report.googleShopping.status).toBe("ok");
    expect(report.found).toBe(3 + 5);
  });

  it("sends a GTIN to Google Shopping as its digits and takes Google's match as a match", async () => {
    const calls: Call[] = [];
    const { search, calls: searches } = fakeIndex([]);
    const report = await discoverProducts({
      query: S85H_GTIN,
      fetch: fakeFetchByOrigin(
        { ...fanoutRoutes, [JB_ORIGIN]: json(jbGtinS85h), [POWERLAND_ORIGIN]: json(jbEmpty) },
        calls,
      ),
      now: () => FIXED_NOW,
      searchIndex: search,
      recordUsage: async () => undefined,
      countOkCalls: noSerpApiToday,
    });
    expect(report.queryKind).toBe("gtin");
    expect(report.gtin).toBe("08806097962670");
    expect(serpApiCalls(calls)[0].searchParams.get("q")).toBe(S85H_GTIN);
    expect(searches).toHaveLength(2);
    if (report.googleShopping.status !== "ok") throw new Error("expected a Google answer");
    expect(
      report.googleShopping.candidates.every(
        (entry) => entry.relevance.reason === "the store matched the barcode",
      ),
    ).toBe(true);
  });

  it("answers a GTIN from the index alone when it holds the barcode", async () => {
    const calls: Call[] = [];
    const report = await discoverProducts({
      query: S85H_GTIN,
      fetch: fakeFetchByOrigin({}, calls),
      now: () => FIXED_NOW,
      searchIndex: fakeIndex([indexedProduct("gtin", "match")]).search,
      countOkCalls: noSerpApiToday,
    });
    expect(calls).toEqual([]);
    expect(report.source).toBe("index");
    expect(report.googleShopping).toEqual({ status: "skipped", reason: "index_sufficient" });
  });

  it("remembers nothing when no source returned a candidate, and still answers when the index cannot be written", async () => {
    const rememberCandidates = vi.fn(async () => ({ written: 0 }));
    const empty = await discoverProducts({
      query: "LG C5 65",
      fetch: fakeFetchByOrigin({
        [JB_ORIGIN]: json(jbEmpty),
        [POWERLAND_ORIGIN]: json(jbEmpty),
        [SERPAPI_ORIGIN]: json(JSON.stringify({ shopping_results: [] })),
      }),
      now: () => FIXED_NOW,
      searchIndex: fakeIndex([]).search,
      recordUsage: async () => undefined,
      countOkCalls: noSerpApiToday,
      rememberCandidates,
    });
    expect(empty.found).toBe(0);
    expect(empty.remembered).toBe(0);
    expect(rememberCandidates).not.toHaveBeenCalled();

    const unwritten = await discoverProducts({
      query: "LG C5 65",
      fetch: fakeFetchByOrigin(fanoutRoutes),
      now: () => FIXED_NOW,
      searchIndex: fakeIndex([]).search,
      recordUsage: async () => undefined,
      countOkCalls: noSerpApiToday,
      rememberCandidates: () => {
        throw new Error("index down");
      },
    });
    expect(unwritten.found).toBe(12);
    expect(unwritten.remembered).toBe(0);
    expect(unwritten.usage).toEqual({ calls: 3, recorded: 3 });
  });

  it("uses catalogue-index.searchIndex, catalogue-index.remember and the ledger query when none is given", async () => {
    await discoverProducts({
      query: "LG C5 65",
      fetch: fakeFetchByOrigin(fanoutRoutes),
      now: () => FIXED_NOW,
      recordUsage: async () => undefined,
      // A handle so the default counter does not open the application database.
      db: fakeDb,
    });
    expect(searchIndex).toHaveBeenCalledTimes(2);
    expect(remember).toHaveBeenCalledTimes(1);
    expect(vi.mocked(remember).mock.calls[0][0]).toMatchObject({ source: "search" });
    expect(countOkCallsByOperation).toHaveBeenCalledTimes(2);
    expect(vi.mocked(countOkCallsByOperation).mock.calls[0][0]).toBe(fakeDb);
  });

  it("propagates an index that cannot be read, before any request: the index is the answer, not a side effect", async () => {
    const countOkCalls = vi.fn(noSerpApiToday);
    const calls: Call[] = [];
    await expect(
      discoverProducts({
        query: "LG C5 65",
        fetch: fakeFetchByOrigin(fanoutRoutes, calls),
        now: () => FIXED_NOW,
        searchIndex: async () => {
          throw new Error("connection refused");
        },
        countOkCalls,
      }),
    ).rejects.toThrow("connection refused");
    // It failed before the budget was wanted and before any store or Google was asked.
    expect(countOkCalls).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("throws ValidationError for a blank query, a long one or a limit outside 1 to 20", async () => {
    await expect(discoverProducts({ query: "   " })).rejects.toBeInstanceOf(ValidationError);
    await expect(discoverProducts({ query: "x".repeat(201) })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(discoverProducts({ query: "LG", limit: 0 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(discoverProducts({ query: "LG", limit: 21 })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

describe("MAX_QUERY_LENGTH", () => {
  it("is the catalogue index's limit, so every search box takes the same queries", () => {
    expect(MAX_QUERY_LENGTH).toBe(INDEX_MAX_QUERY_LENGTH);
    expect(MAX_QUERY_LENGTH).toBe(200);
  });
});

describe("serpApiBudget", () => {
  beforeEach(() => {
    vi.stubEnv(SERPAPI_DAILY_CAP_ENV, "");
    vi.mocked(countOkCallsByOperation).mockClear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("counts the day's successful SerpApi searches in Sydney, both hops and never the account call, against a cap of 20 by default", async () => {
    const periods: { provider: string; from: Date; to: Date }[] = [];
    const budget = await serpApiBudget({
      now: () => FIXED_NOW,
      countOkCalls: async (period) => {
        periods.push(period);
        return ledgerRows(2, 1);
      },
    });
    expect(DEFAULT_SERPAPI_DAILY_CAP).toBe(20);
    expect(budget).toEqual({
      cap: 20,
      capSource: "default",
      usedToday: 3,
      remaining: 17,
      allowed: true,
    });
    expect(periods).toEqual([{ provider: "serpapi", ...dayRangeIn(FIXED_NOW, SYDNEY) }]);
  });

  it("reports zero used when the ledger holds no SerpApi search today", async () => {
    const budget = await serpApiBudget({ now: () => FIXED_NOW, countOkCalls: noSerpApiToday });
    expect(budget).toEqual({
      cap: 20,
      capSource: "default",
      usedToday: 0,
      remaining: 20,
      allowed: true,
    });
  });

  it("reads the cap from SERPAPI_DAILY_CAP and never reports a negative remainder", async () => {
    vi.stubEnv(SERPAPI_DAILY_CAP_ENV, " 5 ");
    const at = await serpApiBudget({
      now: () => FIXED_NOW,
      countOkCalls: countingOk(ledgerRows(5)),
    });
    expect(at).toEqual({ cap: 5, capSource: "env", usedToday: 5, remaining: 0, allowed: false });
    const over = await serpApiBudget({
      now: () => FIXED_NOW,
      countOkCalls: countingOk(ledgerRows(9)),
    });
    expect(over).toEqual({ cap: 5, capSource: "env", usedToday: 9, remaining: 0, allowed: false });

    vi.stubEnv(SERPAPI_DAILY_CAP_ENV, "0");
    const none = await serpApiBudget({ now: () => FIXED_NOW, countOkCalls: noSerpApiToday });
    expect(none).toEqual({ cap: 0, capSource: "env", usedToday: 0, remaining: 0, allowed: false });
  });

  it("falls back to the default, marked invalid, for a cap that is not a whole, non-negative number, and never throws", async () => {
    for (const value of ["twenty", "-1", "2.5", "Infinity", "NaN"]) {
      vi.stubEnv(SERPAPI_DAILY_CAP_ENV, value);
      const budget = await serpApiBudget({
        now: () => FIXED_NOW,
        countOkCalls: countingOk(ledgerRows(1)),
      });
      expect(budget).toEqual({
        cap: 20,
        capSource: "invalid",
        usedToday: 1,
        remaining: 19,
        allowed: true,
      });
    }
  });

  it("uses the ledger query over the given handle when no counter is given, and propagates its failure", async () => {
    const budget = await serpApiBudget({ now: () => FIXED_NOW, db: fakeDb });
    expect(countOkCallsByOperation).toHaveBeenCalledWith(fakeDb, {
      provider: "serpapi",
      ...dayRangeIn(FIXED_NOW, SYDNEY),
    });
    expect(budget.usedToday).toBe(0);

    vi.mocked(countOkCallsByOperation).mockRejectedValueOnce(new Error("connection refused"));
    await expect(serpApiBudget({ now: () => FIXED_NOW, db: fakeDb })).rejects.toThrow(
      "connection refused",
    );
  });

  it("throws ValidationError for a counter that is not a function", async () => {
    await expect(
      serpApiBudget({ countOkCalls: "nope" as unknown as CountOkCalls }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
