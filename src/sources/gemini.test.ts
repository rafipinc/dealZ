import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXTRACT_MODEL,
  ESCALATION_MODEL,
  GEMINI_ENDPOINT,
  GEMINI_SLUG,
  generateContentUrl,
  generateJson,
  type GeminiJsonRequest,
} from "./gemini";
import { SourceError, type FetchLike } from "./types";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

const jbHiFi = fixture("gemini-extract-jbhifi.json");
const samsungDoubt = fixture("gemini-extract-samsung-doubt.json");
const API_KEY = "AIzaSy-test-key-0123456789";
const SCHEMA = { type: "OBJECT", properties: { current_price: { type: "NUMBER" } } };

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

function requestWith(fetch: FetchLike, patch: Partial<GeminiJsonRequest> = {}): GeminiJsonRequest {
  return {
    model: DEFAULT_EXTRACT_MODEL,
    systemInstruction: "Read the page.",
    text: "Samsung TV $2,795.00",
    responseSchema: SCHEMA,
    apiKey: API_KEY,
    fetch,
    ...patch,
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

describe("model names", () => {
  it("defaults to the lite model and escalates to the larger flash model", () => {
    expect(DEFAULT_EXTRACT_MODEL).toBe("gemini-3.5-flash-lite");
    expect(ESCALATION_MODEL).toBe("gemini-3.8-flash");
  });
});

describe("generateContentUrl", () => {
  it("names the model in the path and carries no query string", () => {
    expect(generateContentUrl("gemini-3.5-flash-lite")).toBe(
      `${GEMINI_ENDPOINT}/gemini-3.5-flash-lite:generateContent`,
    );
    expect(generateContentUrl("a/b")).not.toContain("a/b");
  });
});

describe("generateJson", () => {
  it("posts the system instruction, text and schema with the key in a header, not the URL", async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse(jbHiFi));
    await generateJson(requestWith(fetch));

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe(`${GEMINI_ENDPOINT}/${DEFAULT_EXTRACT_MODEL}:generateContent`);
    expect(call.url).not.toContain(API_KEY);
    expect(call.init?.method).toBe("POST");
    const headers = new Headers(call.init?.headers);
    expect(headers.get("x-goog-api-key")).toBe(API_KEY);
    expect(headers.get("content-type")).toBe("application/json");
    expect(call.init?.signal).toBeInstanceOf(AbortSignal);

    const body = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      systemInstruction: { parts: [{ text: "Read the page." }] },
      contents: [{ role: "user", parts: [{ text: "Samsung TV $2,795.00" }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: SCHEMA,
        temperature: 0,
      },
    });
    expect(JSON.stringify(body)).not.toContain(API_KEY);
  });

  it("parses the recorded JB Hi-Fi response into JSON, usage and model", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(jbHiFi));
    const result = await generateJson(requestWith(fetch));

    expect(result.json).toMatchObject({
      is_product_page: true,
      current_price: 2795,
      was_price: 3295,
      currency: "AUD",
      price_evidence: "Sale price: $2795",
      model_code: "QA65S85HAEXXY",
    });
    expect(result.usage).toEqual({ inputTokens: 766, outputTokens: 180, thinkingTokens: 0 });
    expect(result.model).toBe("gemini-3.5-flash-lite");
    expect(result.raw).toEqual(JSON.parse(jbHiFi));
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it("counts thinking tokens when the model reports them", async () => {
    const { fetch } = fakeFetch(() => jsonResponse(samsungDoubt));
    const result = await generateJson(requestWith(fetch, { model: ESCALATION_MODEL }));
    expect(result.usage).toEqual({ inputTokens: 1436, outputTokens: 173, thinkingTokens: 1017 });
    expect(result.model).toBe("gemini-3.8-flash");
  });

  it("falls back to the requested model and zero usage when the body omits them", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }),
    );
    const result = await generateJson(requestWith(fetch, { model: "gemini-test" }));
    expect(result.json).toEqual({ ok: true });
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, thinkingTokens: 0 });
    expect(result.model).toBe("gemini-test");
  });

  it("throws network, without the key, when fetch rejects", async () => {
    const fetch: FetchLike = async () => {
      throw new Error(`socket hang up for ${API_KEY}`);
    };
    const error = await sourceErrorFrom(generateJson(requestWith(fetch)));
    expect(error.kind).toBe("network");
    expect(error.retailerSlug).toBe(GEMINI_SLUG);
    expect(error.message).not.toContain(API_KEY);
    expect(error.message).toContain("REDACTED");
  });

  it.each([401, 403])("throws blocked on %d", async (status) => {
    const { fetch } = fakeFetch(() => jsonResponse({ error: { message: "bad key" } }, status));
    const error = await sourceErrorFrom(generateJson(requestWith(fetch)));
    expect(error.kind).toBe("blocked");
    expect(error.status).toBe(status);
    expect(error.message).not.toContain(API_KEY);
  });

  it("throws blocked with the status on 429", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ error: { message: "quota" } }, 429));
    const error = await sourceErrorFrom(generateJson(requestWith(fetch)));
    expect(error.kind).toBe("blocked");
    expect(error.status).toBe(429);
    expect(error.retailerSlug).toBe(GEMINI_SLUG);
  });

  it("throws http on any other non-2xx status", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ error: { message: "bad" } }, 500));
    const error = await sourceErrorFrom(generateJson(requestWith(fetch)));
    expect(error.kind).toBe("http");
    expect(error.status).toBe(500);
  });

  it("throws unparseable when the body is not JSON", async () => {
    const { fetch } = fakeFetch(() => new Response("<html>oops</html>", { status: 200 }));
    const error = await sourceErrorFrom(generateJson(requestWith(fetch)));
    expect(error.kind).toBe("unparseable");
  });

  it("throws unparseable when the body has no candidate text", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ candidates: [] }));
    const error = await sourceErrorFrom(generateJson(requestWith(fetch)));
    expect(error.kind).toBe("unparseable");
    expect(error.message).toContain("no candidate text");
  });

  it("throws unparseable when the candidate text is not JSON", async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({ candidates: [{ content: { parts: [{ text: "I cannot say." }] } }] }),
    );
    const error = await sourceErrorFrom(generateJson(requestWith(fetch)));
    expect(error.kind).toBe("unparseable");
    expect(error.message).toContain("non-JSON text");
  });

  it("aborts after the timeout", async () => {
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const error = await sourceErrorFrom(generateJson(requestWith(fetch, { timeoutMs: 5 })));
    expect(error.kind).toBe("network");
  });
});
