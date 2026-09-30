import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REQUEST_TIMEOUT_MS, USER_AGENT, fetchText, looksLikeChallenge, pageUrlOf } from "./http";
import { SourceError, type FetchLike, type SourceInput } from "./types";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

const harveyNorman = fixture("harveynorman-challenge.html");
const bingLee = fixture("binglee-challenge.html");
const theGoodGuys = fixture("thegoodguys-s85h-65.html");
const samsung = fixture("samsung-au-s85h-65.html");
const plainPage = "<html><head><title>A TV</title></head><body><p>$2,795.00</p></body></html>";

const URL_UNDER_TEST = "https://example.com/products/tv";

function inputWith(fetch: FetchLike): SourceInput {
  return { retailerSlug: "example", url: URL_UNDER_TEST, fetch };
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

describe("looksLikeChallenge", () => {
  it("recognises the Harvey Norman Imperva page", () => {
    expect(looksLikeChallenge(harveyNorman)).toBe(true);
  });

  it("recognises the Bing Lee DataDome page", () => {
    expect(looksLikeChallenge(bingLee)).toBe(true);
  });

  it("passes The Good Guys product page", () => {
    expect(looksLikeChallenge(theGoodGuys)).toBe(false);
  });

  it("passes the Samsung product page", () => {
    expect(looksLikeChallenge(samsung)).toBe(false);
  });

  it("passes a plain page", () => {
    expect(looksLikeChallenge(plainPage)).toBe(false);
  });

  it("matches markers case-insensitively", () => {
    expect(looksLikeChallenge("<title>JUST A MOMENT...</title>")).toBe(true);
    expect(looksLikeChallenge("<script src='/_Incapsula_Resource?x=1'>")).toBe(true);
    expect(looksLikeChallenge("<div id='cf-challenge-running'>")).toBe(true);
  });

  it("only scans the first 8 KB of the body", () => {
    const late = plainPage.padEnd(9000, " ") + "Pardon Our Interruption";
    expect(looksLikeChallenge(late)).toBe(false);
  });
});

describe("fetchText", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the body of a 2xx response and sends the DealZ user agent with the caller's headers", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return new Response(plainPage, { status: 200 });
    };
    const body = await fetchText(inputWith(fetch), URL_UNDER_TEST, {
      headers: { accept: "text/html" },
    });
    expect(body).toBe(plainPage);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(URL_UNDER_TEST);
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get("user-agent")).toBe(USER_AGENT);
    expect(headers.get("accept")).toBe("text/html");
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
    expect(REQUEST_TIMEOUT_MS).toBe(15_000);
  });

  it("does not forward timeoutMs to fetch and aborts the request when it elapses", async () => {
    const calls: { init?: RequestInit }[] = [];
    const fetch: FetchLike = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        calls.push({ init });
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const error = await sourceErrorFrom(
      fetchText(inputWith(fetch), URL_UNDER_TEST, { timeoutMs: 5 }),
    );
    expect(error.kind).toBe("network");
    expect(error.message).toContain("timeout");
    expect(calls[0].init).not.toHaveProperty("timeoutMs");
  });

  it("falls back to globalThis.fetch when none is injected", async () => {
    vi.stubGlobal("fetch", async () => new Response(plainPage, { status: 200 }));
    const body = await fetchText({ retailerSlug: "example", url: URL_UNDER_TEST }, URL_UNDER_TEST);
    expect(body).toBe(plainPage);
  });

  it("throws blocked with the status on a 403", async () => {
    const fetch: FetchLike = async () => new Response(bingLee, { status: 403 });
    const error = await sourceErrorFrom(fetchText(inputWith(fetch), URL_UNDER_TEST));
    expect(error.kind).toBe("blocked");
    expect(error.status).toBe(403);
    expect(error.retailerSlug).toBe("example");
  });

  it("throws blocked with the status on a 429", async () => {
    const fetch: FetchLike = async () => new Response("slow down", { status: 429 });
    const error = await sourceErrorFrom(fetchText(inputWith(fetch), URL_UNDER_TEST));
    expect(error.kind).toBe("blocked");
    expect(error.status).toBe(429);
  });

  it("throws http with the status on another non-2xx", async () => {
    const fetch: FetchLike = async () => new Response("gone", { status: 500 });
    const error = await sourceErrorFrom(fetchText(inputWith(fetch), URL_UNDER_TEST));
    expect(error.kind).toBe("http");
    expect(error.status).toBe(500);
  });

  it("throws network when fetch rejects", async () => {
    const cause = new Error("ECONNRESET");
    const fetch: FetchLike = async () => {
      throw cause;
    };
    const error = await sourceErrorFrom(fetchText(inputWith(fetch), URL_UNDER_TEST));
    expect(error.kind).toBe("network");
    expect(error.status).toBeNull();
    expect(error.message).toContain("ECONNRESET");
    expect(error.cause).toBe(cause);
  });

  it("throws network when fetch rejects with something that is not an Error", async () => {
    const fetch: FetchLike = async () => {
      throw "aborted";
    };
    const error = await sourceErrorFrom(fetchText(inputWith(fetch), URL_UNDER_TEST));
    expect(error.kind).toBe("network");
    expect(error.message).toContain("aborted");
  });

  it("throws network when the body cannot be read", async () => {
    const broken = {
      ok: true,
      status: 200,
      text: () => Promise.reject(new Error("stream closed")),
    } as unknown as Response;
    const fetch: FetchLike = async () => broken;
    const error = await sourceErrorFrom(fetchText(inputWith(fetch), URL_UNDER_TEST));
    expect(error.kind).toBe("network");
  });

  it("throws blocked when a 200 body is a challenge page", async () => {
    const fetch: FetchLike = async () => new Response(harveyNorman, { status: 200 });
    const error = await sourceErrorFrom(fetchText(inputWith(fetch), URL_UNDER_TEST));
    expect(error.kind).toBe("blocked");
    expect(error.status).toBe(200);
  });
});

describe("pageUrlOf", () => {
  it("canonicalises a valid page URL", () => {
    expect(
      pageUrlOf({ retailerSlug: "jb-hi-fi", url: "https://www.jbhifi.com.au/products/x?gclid=1" }),
    ).toBe("https://www.jbhifi.com.au/products/x");
  });
  it("throws an unparseable SourceError for a URL that is not http", () => {
    expect(() => pageUrlOf({ retailerSlug: "jb-hi-fi", url: "not a url" })).toThrowError(
      SourceError,
    );
    try {
      pageUrlOf({ retailerSlug: "jb-hi-fi", url: "ftp://example.com/x" });
    } catch (error) {
      expect(error).toBeInstanceOf(SourceError);
      expect((error as SourceError).kind).toBe("unparseable");
      expect((error as SourceError).retailerSlug).toBe("jb-hi-fi");
    }
  });
});
