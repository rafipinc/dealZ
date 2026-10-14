import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  allowedDomainsOnly,
  buildHistoryPrompt,
  CLAIM_PAGE_CONCURRENCY,
  DOMAIN_NOT_ALLOWED_REASON,
  HISTORY_ALLOWED_DOMAINS,
  HISTORY_MAX_CLAIMS,
  HISTORY_MAX_TOOL_CALLS,
  REDIRECTED_OFF_ALLOW_LIST,
  isAllowedHost,
  quotesOf,
  searchHistoryClaims,
  SOURCE_URL_INVALID_REASON,
  type AssessedClaim,
  type HistorySearchInput,
} from "./history-search";
import { DEFAULT_HISTORY_MODEL, OPENAI_ENDPOINT } from "./openai";
import { SourceError, type FetchLike, type SourceCall } from "./types";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

const s85h = fixture("openai-history-s85h-65.json");
const catalogue = fixture("jbhifi-catalogue-2026-05-28.html");
const API_KEY = "sk-test-key-0123456789abcdef";
const FIXED_NOW = new Date("2026-10-13T03:04:05.000Z");
const FROM = new Date("2026-04-01T00:00:00.000Z");
const TO = new Date("2026-10-13T00:00:00.000Z");

const PRODUCT = {
  title: 'Samsung 65" OLED S85H 4K Smart AI TV (2026)',
  modelCode: "QA65S85HAEXXY",
  gtin: "08806097962670",
};

/** The four catalogue pages the recorded answer cites, in the model's order. */
const VERIFIED_URL = "https://catalogue.jbhifi.com.au/2026/05/28-05-syt/index.html";
const ABSENT_URL_1 = "https://catalogue.jbhifi.com.au/2026/07/02-07-acp/index.html";
const BLOCKED_URL = "https://catalogue.jbhifi.com.au/2026/07/30-07-acp/index.html";
const ABSENT_URL_2 = "https://catalogue.jbhifi.com.au/2026/09/03-09-ldd/index.html";
const STATICICE_URL = "https://www.staticice.com.au/cgi-bin/search.cgi?q=QA65S85HAEXXY";

/** A catalogue page that carries the model code but not the quoted fragment or the price. */
const pageWithoutFragment = `<html><head><title>JB Hi-Fi catalogue</title></head>
<body><h1>Catalogue</h1><p>Samsung 65" OLED 4K Smart AI TV 902825 / QA65S85HAEXXY</p>
<p>See in store.</p></body></html>`;

interface ClaimRow {
  date?: string;
  retailer?: string;
  price_aud?: number | string;
  source_url?: string;
  quote?: string;
}

/** The recorded answer's claim rows, as the model wrote them. */
function fixtureRows(): ClaimRow[] {
  const body = JSON.parse(s85h) as { output: { type: string; content?: { text: string }[] }[] };
  const message = body.output.find((item) => item.type === "message");
  if (message?.content === undefined) throw new Error("Fixture has no message");
  return JSON.parse(message.content[0].text) as ClaimRow[];
}

/** The recorded response with its message text replaced, every other item kept. */
function responseWithText(text: string): string {
  const body = JSON.parse(s85h) as { output: { type: string; content?: { text: string }[] }[] };
  for (const item of body.output) {
    if (item.type === "message" && item.content !== undefined) item.content[0].text = text;
  }
  return JSON.stringify(body);
}

function responseWithRows(rows: ClaimRow[]): string {
  return responseWithText(JSON.stringify(rows));
}

const STATICICE_ROW: ClaimRow = {
  date: "2026-06-01",
  retailer: "StaticICE",
  price_aud: 2399,
  source_url: STATICICE_URL,
  quote: "$2399.00",
};

/** The recorded four claims plus one on a domain outside the allow-list. */
const fiveClaims = responseWithRows([...fixtureRows(), STATICICE_ROW]);

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

/** The pages the recorded claims cite: one verified, two without the fragment, one forbidden. */
const pageRoutes: [string, Responder][] = [
  ["2026/05/28-05-syt", html(catalogue)],
  ["2026/07/02-07-acp", html(pageWithoutFragment)],
  ["2026/07/30-07-acp", html("<html><body>Forbidden</body></html>", 403)],
  ["2026/09/03-09-ldd", html(pageWithoutFragment)],
];

const fiveClaimRoutes: [string, Responder][] = [[OPENAI_ENDPOINT, json(fiveClaims)], ...pageRoutes];

function inputWith(fetch: FetchLike, patch: Partial<HistorySearchInput> = {}): HistorySearchInput {
  return {
    product: PRODUCT,
    from: FROM,
    to: TO,
    apiKey: API_KEY,
    fetch,
    now: () => FIXED_NOW,
    ...patch,
  };
}

function claimFor(claims: AssessedClaim[], sourceUrl: string): AssessedClaim {
  const claim = claims.find((candidate) => candidate.sourceUrl === sourceUrl);
  if (claim === undefined) throw new Error(`No claim for ${sourceUrl}`);
  return claim;
}

function pageCalls(calls: Call[]): Call[] {
  return calls.filter((call) => call.url !== OPENAI_ENDPOINT);
}

describe("constants and the allow-list", () => {
  it("caps tool calls at 6, claims at 12 and claim pages in flight at 3", () => {
    expect(HISTORY_MAX_TOOL_CALLS).toBe(6);
    expect(HISTORY_MAX_CLAIMS).toBe(12);
    expect(CLAIM_PAGE_CONCURRENCY).toBe(3);
  });

  it("lists the retailers the lab reads, the deal site and the RRP site, each with a terms note", () => {
    expect(allowedDomainsOnly()).toEqual([
      "jbhifi.com.au",
      "catalogue.jbhifi.com.au",
      "thegoodguys.com.au",
      "harveynorman.com.au",
      "binglee.com.au",
      "samsung.com",
      "powerland.com.au",
      "toptek.com.au",
      "appliancecentral.com.au",
      "videopro.com.au",
      "ozbargain.com.au",
      "press-start.com.au",
    ]);
    for (const entry of HISTORY_ALLOWED_DOMAINS) expect(entry.note.length).toBeGreaterThan(10);
  });

  it("never lists staticice.com.au, whose terms forbid redisplay", () => {
    expect(allowedDomainsOnly().some((domain) => domain.includes("staticice"))).toBe(false);
  });

  it("counts a subdomain of an allowed domain as allowed and a lookalike as not", () => {
    const domains = allowedDomainsOnly();
    expect(isAllowedHost("www.jbhifi.com.au", domains)).toBe(true);
    expect(isAllowedHost("catalogue.jbhifi.com.au", domains)).toBe(true);
    expect(isAllowedHost("JBHIFI.com.au", domains)).toBe(true);
    expect(isAllowedHost("notjbhifi.com.au", domains)).toBe(false);
    expect(isAllowedHost("jbhifi.com.au.evil.example", domains)).toBe(false);
    expect(isAllowedHost("www.staticice.com.au", domains)).toBe(false);
  });
});

describe("buildHistoryPrompt", () => {
  it("names the product, the model code, the GTIN and both dates as Sydney ISO dates", () => {
    const prompt = buildHistoryPrompt({ ...PRODUCT, from: FROM, to: TO });
    expect(prompt).toContain(PRODUCT.title);
    expect(prompt).toContain("model code QA65S85HAEXXY");
    expect(prompt).toContain("GTIN 08806097962670");
    // 2026-04-01T00:00Z is 10:00 on 2026-04-01 in Sydney; 2026-10-13T00:00Z is 11:00 on 2026-10-13.
    expect(prompt).toContain("for the period 2026-04-01 to 2026-10-13");
    expect(prompt).toMatch(/^Use web search\./);
    expect(prompt).toContain("Return JSON only");
    expect(prompt).toContain("source_url");
    expect(prompt).toContain("Do not infer a date from today");
  });

  it("omits a model code or GTIN the caller does not have", () => {
    const prompt = buildHistoryPrompt({
      title: "Some TV",
      modelCode: null,
      gtin: "",
      from: FROM,
      to: TO,
    });
    expect(prompt).toContain("price history of Some TV, for the period");
    expect(prompt).not.toContain("model code");
    expect(prompt).not.toContain("GTIN");
  });
});

describe("searchHistoryClaims", () => {
  it("sends the prompt with the model code and both dates, fenced to the allow-list, within the tool cap", async () => {
    const calls: Call[] = [];
    await searchHistoryClaims(inputWith(fakeFetchBySubstring(fiveClaimRoutes, calls)));
    const request = calls.find((call) => call.url === OPENAI_ENDPOINT);
    if (request === undefined) throw new Error("No model request");
    const body = JSON.parse(String(request.init?.body)) as {
      model: string;
      input: string;
      max_tool_calls: number;
      tools: { filters: { allowed_domains: string[] } }[];
    };
    expect(body.model).toBe(DEFAULT_HISTORY_MODEL);
    expect(body.input).toContain("QA65S85HAEXXY");
    expect(body.input).toContain("2026-04-01");
    expect(body.input).toContain("2026-10-13");
    expect(body.max_tool_calls).toBe(HISTORY_MAX_TOOL_CALLS);
    expect(body.tools[0].filters.allowed_domains).toEqual(allowedDomainsOnly());
  });

  it("verifies the catalogue claim, dated 2026-05-28 from its URL and not the model's 2026-05-14", async () => {
    const result = await searchHistoryClaims(inputWith(fakeFetchBySubstring(fiveClaimRoutes)));
    const verified = claimFor(result.claims, VERIFIED_URL);
    expect(verified).toMatchObject({
      retailer: "JB Hi-Fi",
      retailerSlug: "jb-hi-fi",
      priceCents: 249500,
      verdict: "verified",
      confidence: 0.8,
      fragment: "strong",
      observedDate: "2026-05-28",
      dateSource: "url",
      claimedDate: "2026-05-14",
    });
    // Midnight of 2026-05-28 in Sydney (AEST, UTC+10).
    expect(verified.observedAt).toEqual(new Date("2026-05-27T14:00:00.000Z"));
    expect(verified.reasons).toEqual(["quoted fragment found on page", "dated from URL"]);
    expect(result.claims.filter((claim) => claim.verdict === "verified")).toHaveLength(1);
  });

  it("marks a claim on a page that answers 403 unverified at 0.4, naming the kind", async () => {
    const result = await searchHistoryClaims(inputWith(fakeFetchBySubstring(fiveClaimRoutes)));
    const blocked = claimFor(result.claims, BLOCKED_URL);
    expect(blocked).toMatchObject({
      verdict: "unverified",
      confidence: 0.4,
      observedDate: null,
      observedAt: null,
      fragment: null,
      dateSource: null,
      reasons: ["page unreachable: blocked"],
    });
  });

  it("rejects a claim whose fragment is not on the fetched page at 0.3", async () => {
    const result = await searchHistoryClaims(inputWith(fakeFetchBySubstring(fiveClaimRoutes)));
    for (const url of [ABSENT_URL_1, ABSENT_URL_2]) {
      expect(claimFor(result.claims, url)).toMatchObject({
        verdict: "rejected",
        confidence: 0.3,
        observedAt: null,
        fragment: "absent",
        reasons: ["quoted fragment not on page"],
      });
    }
  });

  it("rejects a claim on staticice.com.au without fetching it", async () => {
    const calls: Call[] = [];
    const result = await searchHistoryClaims(
      inputWith(fakeFetchBySubstring(fiveClaimRoutes, calls)),
    );
    expect(claimFor(result.claims, STATICICE_URL)).toMatchObject({
      retailerSlug: "staticice",
      verdict: "rejected",
      confidence: 0.3,
      observedDate: null,
      fragment: null,
      reasons: [DOMAIN_NOT_ALLOWED_REASON],
    });
    expect(calls.some((call) => call.url.includes("staticice"))).toBe(false);
    expect(pageCalls(calls)).toHaveLength(4);
  });

  it("sorts the recorded answer into one verified, three rejected and one unverified", async () => {
    const result = await searchHistoryClaims(inputWith(fakeFetchBySubstring(fiveClaimRoutes)));
    const verdicts = result.claims.map((claim) => claim.verdict);
    expect(verdicts.filter((v) => v === "verified")).toHaveLength(1);
    expect(verdicts.filter((v) => v === "rejected")).toHaveLength(3);
    expect(verdicts.filter((v) => v === "unverified")).toHaveLength(1);
    expect(result.claims).toHaveLength(5);
  });

  it("rejects a claim whose source_url is not a URL without fetching anything", async () => {
    const calls: Call[] = [];
    const result = await searchHistoryClaims(
      inputWith(
        fakeFetchBySubstring(
          [
            [
              OPENAI_ENDPOINT,
              json(
                responseWithRows([
                  { retailer: "JB Hi-Fi", price_aud: 2495, source_url: "not a url", quote: "x" },
                ]),
              ),
            ],
          ],
          calls,
        ),
      ),
    );
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]).toMatchObject({
      verdict: "rejected",
      confidence: 0.3,
      reasons: [SOURCE_URL_INVALID_REASON],
    });
    expect(pageCalls(calls)).toHaveLength(0);
  });

  it("fetches a page cited by two claims once and judges both", async () => {
    const calls: Call[] = [];
    const [first] = fixtureRows();
    const result = await searchHistoryClaims(
      inputWith(
        fakeFetchBySubstring(
          [
            [
              OPENAI_ENDPOINT,
              json(
                responseWithRows([
                  first,
                  { ...first, price_aud: 9999, quote: "$9999 a price not on this page" },
                ]),
              ),
            ],
            ...pageRoutes,
          ],
          calls,
        ),
      ),
    );
    expect(pageCalls(calls)).toHaveLength(1);
    expect(result.claims.map((claim) => claim.verdict)).toEqual(["verified", "rejected"]);
  });

  it("keeps at most HISTORY_MAX_CLAIMS claims and fetches at most that many pages", async () => {
    const calls: Call[] = [];
    const rows: ClaimRow[] = Array.from({ length: HISTORY_MAX_CLAIMS + 8 }, (_, i) => ({
      date: "2026-06-01",
      retailer: "The Good Guys",
      price_aud: 2795,
      source_url: `https://www.thegoodguys.com.au/samsung-s85h-${i}`,
      quote: "$2795",
    }));
    const result = await searchHistoryClaims(
      inputWith(
        fakeFetchBySubstring(
          [
            [OPENAI_ENDPOINT, json(responseWithRows(rows))],
            ["thegoodguys.com.au", html(pageWithoutFragment)],
          ],
          calls,
        ),
      ),
    );
    expect(result.claims).toHaveLength(HISTORY_MAX_CLAIMS);
    expect(pageCalls(calls)).toHaveLength(HISTORY_MAX_CLAIMS);
  });

  it("returns no claims when the model answers with prose and no array", async () => {
    const result = await searchHistoryClaims(
      inputWith(
        fakeFetchBySubstring([
          [OPENAI_ENDPOINT, json(responseWithText("I could not find any dated prices."))],
        ]),
      ),
    );
    expect(result.claims).toEqual([]);
    expect(quotesOf(result)).toEqual([]);
  });

  it("carries the product, the prompt, the clock's reading, the model, the counts and the raw body", async () => {
    const result = await searchHistoryClaims(inputWith(fakeFetchBySubstring(fiveClaimRoutes)));
    expect(result.product).toEqual(PRODUCT);
    expect(result.prompt).toBe(buildHistoryPrompt({ ...PRODUCT, from: FROM, to: TO }));
    expect(result.fetchedAt).toBe(FIXED_NOW);
    expect(result.model).toBe("gpt-6-luna");
    expect(result.toolCalls).toEqual({ searches: 3, pageOpens: 2 });
    expect(result.inputTokens).toBe(44_210);
    expect(result.outputTokens).toBe(2_116);
    expect(result.raw).toEqual(JSON.parse(fiveClaims));
  });

  it("takes the model, the domains and the tool cap it is given", async () => {
    const calls: Call[] = [];
    const result = await searchHistoryClaims(
      inputWith(fakeFetchBySubstring(fiveClaimRoutes, calls), {
        model: "gpt-test",
        allowedDomains: ["ozbargain.com.au"],
        maxToolCalls: 2,
      }),
    );
    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    expect(body.model).toBe("gpt-test");
    expect(body.max_tool_calls).toBe(2);
    expect(body.tools).toEqual([
      { type: "web_search", filters: { allowed_domains: ["ozbargain.com.au"] } },
    ]);
    // Every recorded claim is on catalogue.jbhifi.com.au, now outside the list: none is fetched.
    expect(pageCalls(calls)).toHaveLength(0);
    expect(result.claims.every((claim) => claim.reasons[0] === DOMAIN_NOT_ALLOWED_REASON)).toBe(
      true,
    );
  });

  it("rejects a page whose allowed host redirected it off the allow-list", async () => {
    const calls: Call[] = [];
    const offList = () => {
      const response = new Response(catalogue, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
      Object.defineProperty(response, "url", { value: "https://mirror.example.net/catalogue" });
      return response;
    };
    const result = await searchHistoryClaims(
      inputWith(
        fakeFetchBySubstring(
          [
            [OPENAI_ENDPOINT, json(fiveClaims)],
            ["2026/05/28-05-syt", offList],
            ...pageRoutes.slice(1),
          ],
          calls,
        ),
      ),
    );
    const claim = claimFor(result.claims, VERIFIED_URL);
    expect(claim.verdict).toBe("unverified");
    expect(claim.reasons).toEqual([`page unreachable: ${REDIRECTED_OFF_ALLOW_LIST}`]);
    expect(claim.fragment).toBeNull();
  });

  it("propagates a SourceError from the model request and fetches no page", async () => {
    const calls: Call[] = [];
    await expect(
      searchHistoryClaims(
        inputWith(
          fakeFetchBySubstring([[OPENAI_ENDPOINT, json('{"error":{"message":"no"}}', 429)]], calls),
        ),
      ),
    ).rejects.toMatchObject({ name: "SourceError", kind: "blocked", retailerSlug: "openai" });
    expect(pageCalls(calls)).toHaveLength(0);
  });

  it("never lets the key into an error message, the raw body or a claim", async () => {
    const leaking: FetchLike = async () => {
      throw new Error(`socket hang up for ${API_KEY}`);
    };
    let error: unknown;
    try {
      await searchHistoryClaims(inputWith(leaking));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SourceError);
    expect((error as SourceError).message).not.toContain(API_KEY);

    const echoed = fiveClaims.replace(
      '"status": "completed"',
      `"status": "completed", "echo": "${API_KEY}"`,
    );
    const result = await searchHistoryClaims(
      inputWith(fakeFetchBySubstring([[OPENAI_ENDPOINT, json(echoed)], ...pageRoutes])),
    );
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it("never sends a page request with a bearer header; only the model request carries the key", async () => {
    const calls: Call[] = [];
    await searchHistoryClaims(inputWith(fakeFetchBySubstring(fiveClaimRoutes, calls)));
    for (const call of pageCalls(calls)) {
      expect(new Headers(call.init?.headers).get("authorization")).toBeNull();
    }
  });
});

describe("quotesOf", () => {
  it("returns only the verified claim, as a model_search quote dated by the page", async () => {
    const result = await searchHistoryClaims(inputWith(fakeFetchBySubstring(fiveClaimRoutes)));
    const quotes = quotesOf(result);
    expect(quotes).toHaveLength(1);
    const [quote] = quotes;
    expect(quote).toMatchObject({
      retailerSlug: "jb-hi-fi",
      retailerName: "JB Hi-Fi",
      url: VERIFIED_URL,
      method: "history_search",
      fetchedAt: FIXED_NOW,
      observedAt: new Date("2026-05-27T14:00:00.000Z"),
      title: PRODUCT.title,
      priceCents: 249500,
      currency: "AUD",
      strikethroughCents: null,
      shippingCents: null,
      availability: "unknown",
      condition: "new",
      identifiers: { gtin: "08806097962670", mpn: "QA65S85HAEXXY", retailerSku: null },
      provenance: { kind: "model_search", via: VERIFIED_URL },
      confidence: 0.8,
    });
    expect(quote.evidence).toContain("$2495");
    expect(quote.raw).toBe(claimFor(result.claims, VERIFIED_URL));
  });

  it("strips tracking parameters from the quote's URL but keeps the cited page as via", async () => {
    const [first] = fixtureRows();
    const cited = `${VERIFIED_URL}?utm_source=model`;
    const result = await searchHistoryClaims(
      inputWith(
        fakeFetchBySubstring([
          [OPENAI_ENDPOINT, json(responseWithRows([{ ...first, source_url: cited }]))],
          ...pageRoutes,
        ]),
      ),
    );
    const [quote] = quotesOf(result);
    expect(quote.url).toBe(VERIFIED_URL);
    expect(quote.provenance.via).toBe(cited);
  });
});

describe("searchHistoryClaims metering", () => {
  it("reports one responses row, three searches, two page opens and one page row per claim fetched", async () => {
    const calls: SourceCall[] = [];
    await searchHistoryClaims(
      inputWith(fakeFetchBySubstring(fiveClaimRoutes), { meter: (call) => void calls.push(call) }),
    );
    const openai = calls.filter((call) => call.provider === "openai");
    expect(openai.map((call) => call.operation)).toEqual([
      "responses",
      "web_search_call",
      "web_search_open_page",
      "web_search_call",
      "web_search_open_page",
      "web_search_call",
    ]);
    expect(openai[0]).toMatchObject({
      outcome: "ok",
      httpStatus: 200,
      model: DEFAULT_HISTORY_MODEL,
      inputTokens: 44_210,
      outputTokens: 2_116,
      retailerSlug: null,
    });

    const pages = calls.filter((call) => call.provider === "retailer");
    expect(pages).toHaveLength(4);
    expect(pages.every((call) => call.operation === "page")).toBe(true);
    expect(pages.every((call) => call.retailerSlug === "jb-hi-fi")).toBe(true);
    expect(pages.filter((call) => call.outcome === "failed")).toEqual([
      expect.objectContaining({ errorKind: "blocked", httpStatus: 403 }),
    ]);
    expect(JSON.stringify(calls)).not.toContain(API_KEY);
  });

  it("names the page's host as the retailer when the model named none", async () => {
    const calls: SourceCall[] = [];
    const [first] = fixtureRows();
    const result = await searchHistoryClaims(
      inputWith(
        fakeFetchBySubstring([
          [OPENAI_ENDPOINT, json(responseWithRows([{ ...first, retailer: "" }]))],
          ...pageRoutes,
        ]),
        { meter: (call) => void calls.push(call) },
      ),
    );
    expect(result.claims[0].retailerSlug).toBe("catalogue-jbhifi-com-au");
    const [page] = calls.filter((call) => call.provider === "retailer");
    expect(page.retailerSlug).toBe("catalogue-jbhifi-com-au");
  });
});
