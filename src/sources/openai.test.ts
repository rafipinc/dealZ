import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HISTORY_MODEL,
  OPENAI_ENDPOINT,
  OPENAI_SLUG,
  OPENAI_TIMEOUT_MS,
  searchHistory,
  type OpenAiHistoryRequest,
} from "./openai";
import { SourceError, type FetchLike, type SourceCall } from "./types";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

const s85h = fixture("openai-history-s85h-65.json");
const API_KEY = "sk-test-key-0123456789abcdef";
const DOMAINS = ["jbhifi.com.au", "thegoodguys.com.au"];
const PROMPT = "Use web search. Find the dated price history of QA65S85HAEXXY.";

type Call = { url: string; init?: RequestInit };

function fakeFetch(respond: (url: string) => Response | Promise<Response>, calls: Call[] = []) {
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return respond(url);
  };
  return { fetch, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestWith(
  fetch: FetchLike,
  patch: Partial<OpenAiHistoryRequest> = {},
): OpenAiHistoryRequest {
  return {
    model: DEFAULT_HISTORY_MODEL,
    apiKey: API_KEY,
    prompt: PROMPT,
    allowedDomains: DOMAINS,
    maxToolCalls: 6,
    retailerSlug: null,
    fetch,
    ...patch,
  };
}

/** A completed response with one message and no searches, for the edge cases. */
function completed(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
    ...extra,
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

describe("constants", () => {
  it("defaults to the model confirmed on 2026-10-13 and allows 90 seconds", () => {
    expect(DEFAULT_HISTORY_MODEL).toBe("gpt-6-luna");
    expect(OPENAI_TIMEOUT_MS).toBe(90_000);
    expect(OPENAI_ENDPOINT).toBe("https://api.openai.com/v1/responses");
  });
});

describe("searchHistory", () => {
  it("posts the Responses body with the key in a bearer header, not the URL", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(s85h));
    await searchHistory(requestWith(fetch));

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe(OPENAI_ENDPOINT);
    expect(call.url).not.toContain(API_KEY);
    expect(call.init?.method).toBe("POST");
    const headers = new Headers(call.init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(headers.get("content-type")).toBe("application/json");
    expect(call.init?.signal).toBeInstanceOf(AbortSignal);

    const body = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      model: "gpt-6-luna",
      max_tool_calls: 6,
      tools: [{ type: "web_search", filters: { allowed_domains: DOMAINS } }],
      include: ["web_search_call.action.sources"],
      input: PROMPT,
    });
    expect(JSON.stringify(body)).not.toContain(API_KEY);
  });

  it("parses the recorded response into four points of text, five tool calls and the tokens", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(s85h));
    const result = await searchHistory(requestWith(fetch));

    const points = JSON.parse(result.text) as { date: string; price_aud: number }[];
    expect(points).toHaveLength(4);
    expect(points[0]).toMatchObject({
      date: "2026-05-14",
      retailer: "JB Hi-Fi",
      price_aud: 2495,
      source_url: "https://catalogue.jbhifi.com.au/2026/05/28-05-syt/index.html",
    });
    expect(points.map((point) => point.price_aud)).toEqual([2495, 2795, 2795, 2795]);

    expect(result.toolCalls).toEqual([
      { type: "search", query: "site:jbhifi.com.au QA65S85HAEXXY", url: null },
      {
        type: "open_page",
        query: null,
        url: "https://www.thegoodguys.com.au/samsung-65-inches-oled-s85h-4k-smart-ai-tv-2026-qa65s85haexxy",
      },
      { type: "search", query: 'site:ozbargain.com.au "QA65S85HAEXXY"', url: null },
      {
        type: "open_page",
        query: null,
        url: "https://catalogue.jbhifi.com.au/2026/05/28-05-syt/index.html",
      },
      { type: "search", query: 'site:catalogue.jbhifi.com.au/2026/ "QA65S85HAEXXY"', url: null },
    ]);
    expect(result.inputTokens).toBe(44_210);
    expect(result.outputTokens).toBe(2_116);
    expect(result.model).toBe("gpt-6-luna");
    expect(result.raw).toEqual(JSON.parse(s85h));
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it("falls back to the requested model and zero tokens when the body omits them", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(completed("[]")));
    const result = await searchHistory(requestWith(fetch, { model: "gpt-test" }));
    expect(result.text).toBe("[]");
    expect(result.toolCalls).toEqual([]);
    expect(result.model).toBe("gpt-test");
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });

  it("skips output items of a kind it does not know and keeps an unknown action as other", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({
        status: "completed",
        output: [
          { type: "reasoning", encrypted_content: "opaque" },
          { type: "web_search_call", action: { type: "find_in_page", pattern: "price" } },
          { type: "something_new", payload: { nested: true } },
          { type: "message", content: [{ type: "refusal", refusal: "no" }] },
          { type: "message", content: [{ type: "output_text", text: "[1]" }] },
          "not even an object",
        ],
      }),
    );
    const result = await searchHistory(requestWith(fetch));
    expect(result.text).toBe("[1]");
    expect(result.toolCalls).toEqual([{ type: "other", query: null, url: null }]);
  });

  it("joins the text of every output_text part, in order", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({
        status: "completed",
        output: [
          {
            type: "message",
            content: [
              { type: "output_text", text: "first" },
              { type: "output_text", text: "second" },
            ],
          },
          { type: "message", content: [{ type: "output_text", text: "third" }] },
        ],
      }),
    );
    const result = await searchHistory(requestWith(fetch));
    expect(result.text).toBe("first\nsecond\nthird");
  });

  it("removes the key from raw when the body echoes it", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse(completed("[]", { metadata: { echo: `key ${API_KEY} here` } })),
    );
    const result = await searchHistory(requestWith(fetch));
    expect(JSON.stringify(result.raw)).not.toContain(API_KEY);
    expect(JSON.stringify(result.raw)).toContain("REDACTED");
  });

  it("throws network, without the key, when fetch rejects", async () => {
    const fetch: FetchLike = async () => {
      throw new Error(`socket hang up for ${API_KEY}`);
    };
    const error = await sourceErrorFrom(searchHistory(requestWith(fetch)));
    expect(error.kind).toBe("network");
    expect(error.retailerSlug).toBe(OPENAI_SLUG);
    expect(error.message).not.toContain(API_KEY);
    expect(error.message).toContain("REDACTED");
  });

  it.each([401, 403, 429])("throws blocked on %d", async (status) => {
    const { fetch } = fakeFetch(() => jsonResponse({ error: { message: "bad key" } }, status));
    const error = await sourceErrorFrom(searchHistory(requestWith(fetch)));
    expect(error.kind).toBe("blocked");
    expect(error.status).toBe(status);
    expect(error.retailerSlug).toBe(OPENAI_SLUG);
    expect(error.message).not.toContain(API_KEY);
  });

  it("throws http on any other non-2xx status", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ error: { message: "bad" } }, 500));
    const error = await sourceErrorFrom(searchHistory(requestWith(fetch)));
    expect(error.kind).toBe("http");
    expect(error.status).toBe(500);
  });

  it("throws http, with the status and without the key, on an error object in a 200 body", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({
        status: "failed",
        error: {
          message: `The server had an error while handling ${API_KEY}`,
          type: "server_error",
        },
        output: [],
      }),
    );
    const error = await sourceErrorFrom(searchHistory(requestWith(fetch)));
    expect(error.kind).toBe("http");
    expect(error.status).toBe(200);
    expect(error.message).toContain("server had an error");
    expect(error.message).not.toContain(API_KEY);
  });

  it("throws unparseable, naming the status, when the response did not complete", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [{ type: "web_search_call", action: { type: "search", query: "q" } }],
      }),
    );
    const error = await sourceErrorFrom(searchHistory(requestWith(fetch)));
    expect(error.kind).toBe("unparseable");
    expect(error.message).toContain("incomplete");
  });

  it("throws unparseable when the body is not JSON", async () => {
    const { fetch } = fakeFetch(() => new Response("<html>oops</html>", { status: 200 }));
    const error = await sourceErrorFrom(searchHistory(requestWith(fetch)));
    expect(error.kind).toBe("unparseable");
    expect(error.message).toContain("non-JSON");
  });

  it("throws unparseable when the body has an unexpected shape", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ status: "completed", output: "none" }));
    const error = await sourceErrorFrom(searchHistory(requestWith(fetch)));
    expect(error.kind).toBe("unparseable");
    expect(error.message).toContain("unexpected shape");
  });

  it("throws unparseable when a completed response carries no message text", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({
        status: "completed",
        output: [{ type: "web_search_call", action: { type: "search", query: "q" } }],
      }),
    );
    const error = await sourceErrorFrom(searchHistory(requestWith(fetch)));
    expect(error.kind).toBe("unparseable");
    expect(error.message).toContain("no message text");
  });

  it("aborts after the timeout", async () => {
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const error = await sourceErrorFrom(searchHistory(requestWith(fetch, { timeoutMs: 5 })));
    expect(error.kind).toBe("network");
  });
});

describe("searchHistory metering", () => {
  const T0 = new Date("2026-10-13T00:00:00.000Z");

  /** A request whose meter collects, with a clock that advances 900 ms a read. */
  function metered(fetch: FetchLike, patch: Partial<OpenAiHistoryRequest> = {}) {
    const calls: SourceCall[] = [];
    let reads = 0;
    const request = requestWith(fetch, {
      now: () => new Date(T0.getTime() + 900 * reads++),
      meter: (call) => void calls.push(call),
      ...patch,
    });
    return { request, calls };
  }

  it("reports one ok responses call with the tokens, then one row per search and one per page open", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(s85h));
    const { request, calls } = metered(fetch);
    await searchHistory(request);

    expect(calls).toHaveLength(6);
    expect(calls[0]).toEqual({
      provider: "openai",
      operation: "responses",
      startedAt: T0,
      durationMs: 900,
      outcome: "ok",
      errorKind: null,
      httpStatus: 200,
      model: DEFAULT_HISTORY_MODEL,
      inputTokens: 44_210,
      outputTokens: 2_116,
      retailerSlug: null,
    });
    // The searches happened inside the one request: stamped when the answer
    // was read, after the request's own finish, with no duration of their own.
    const search: SourceCall = {
      provider: "openai",
      operation: "web_search_call",
      startedAt: new Date(T0.getTime() + 1_800),
      durationMs: 0,
      outcome: "ok",
      errorKind: null,
      httpStatus: null,
      model: DEFAULT_HISTORY_MODEL,
      inputTokens: null,
      outputTokens: null,
      retailerSlug: null,
    };
    const open: SourceCall = { ...search, operation: "web_search_open_page" };
    expect(calls.slice(1)).toEqual([search, open, search, open, search]);
  });

  it("reports as many priced search rows as the provider says it billed", async () => {
    // The provider bills per search query, not per page opened. The fixture
    // states its count; the ledger must agree with it, or the cost is wrong.
    const billed = (JSON.parse(s85h) as { tool_usage: { web_search: { num_requests: number } } })
      .tool_usage.web_search.num_requests;
    expect(billed).toBe(3);
    const { fetch } = fakeFetch(() => jsonResponse(s85h));
    const { request, calls } = metered(fetch);
    await searchHistory(request);
    expect(calls.filter((call) => call.operation === "web_search_call")).toHaveLength(billed);
    expect(calls.filter((call) => call.operation === "web_search_open_page")).toHaveLength(2);
  });

  it("reports an action it does not know as a page open, never as a priced search", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse(
        completed("[]", {
          output: [
            { type: "web_search_call", action: { type: "find_in_page", pattern: "price" } },
            { type: "message", content: [{ type: "output_text", text: "[]" }] },
          ],
        }),
      ),
    );
    const { request, calls } = metered(fetch);
    await searchHistory(request);
    expect(calls.map((call) => call.operation)).toEqual(["responses", "web_search_open_page"]);
  });

  it("reports no web_search_call rows when the model made no search", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(completed("[]")));
    const { request, calls } = metered(fetch);
    await searchHistory(request);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      operation: "responses",
      outcome: "ok",
      inputTokens: null,
      outputTokens: null,
      retailerSlug: null,
    });
  });

  it("counts a usage block with missing counts as zero", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(completed("[]", { usage: {} })));
    const { request, calls } = metered(fetch);
    await searchHistory(request);
    expect(calls[0]).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });

  it.each([
    [401, "blocked"],
    [429, "blocked"],
    [500, "http"],
  ] as const)("reports a %d as one failed call of kind %s", async (status, kind) => {
    const { fetch } = fakeFetch(() => jsonResponse({ error: { message: "no" } }, status));
    const { request, calls } = metered(fetch);
    await sourceErrorFrom(searchHistory(request));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      outcome: "failed",
      errorKind: kind,
      httpStatus: status,
      inputTokens: null,
      outputTokens: null,
    });
  });

  it("reports a rejected fetch as a failed network call with no status", async () => {
    const { request, calls } = metered(async () => {
      throw new Error(`socket hang up for ${API_KEY}`);
    });
    await sourceErrorFrom(searchHistory(request));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ outcome: "failed", errorKind: "network", httpStatus: null });
    expect(JSON.stringify(calls)).not.toContain(API_KEY);
  });

  it("reports an error body as one failed http call with the tokens it carried", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({
        status: "failed",
        error: { message: "server error" },
        usage: { input_tokens: 300, output_tokens: 5 },
        output: [],
      }),
    );
    const { request, calls } = metered(fetch);
    await sourceErrorFrom(searchHistory(request));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      outcome: "failed",
      errorKind: "http",
      httpStatus: 200,
      inputTokens: 300,
      outputTokens: 5,
    });
  });

  it("still reports the searches of a response that did not complete, since they were billed", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({
        status: "incomplete",
        usage: { input_tokens: 10_000, output_tokens: 4_000 },
        output: [
          { type: "web_search_call", action: { type: "search", query: "a" } },
          { type: "web_search_call", action: { type: "open_page", url: "https://x.example/" } },
        ],
      }),
    );
    const { request, calls } = metered(fetch);
    await sourceErrorFrom(searchHistory(request));
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({
      operation: "responses",
      outcome: "failed",
      errorKind: "unparseable",
      httpStatus: 200,
      inputTokens: 10_000,
      outputTokens: 4_000,
    });
    expect(calls.slice(1).map((call) => call.operation)).toEqual([
      "web_search_call",
      "web_search_open_page",
    ]);
  });

  it("never puts the key or the endpoint in a call", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(s85h));
    const { request, calls } = metered(fetch);
    await searchHistory(request);
    expect(JSON.stringify(calls)).not.toContain(API_KEY);
    expect(JSON.stringify(calls)).not.toContain("api.openai.com");
  });

  it("returns the answer even when the meter throws on every call", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(s85h));
    const result = await searchHistory(
      requestWith(fetch, {
        meter: () => {
          throw new Error("ledger down");
        },
      }),
    );
    expect(result.toolCalls).toHaveLength(5);
  });

  it("reads no clock without a meter", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(s85h));
    const result = await searchHistory(
      requestWith(fetch, {
        now: () => {
          throw new Error("no clock");
        },
      }),
    );
    expect(result.model).toBe("gpt-6-luna");
  });
});
