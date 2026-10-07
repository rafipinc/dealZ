// Shared HTTP plumbing for sources. One request, one body, and every way it
// can go wrong mapped to a SourceError kind. Not exported from the index.
//
// fetchText reports each request to the input's meter. fetchBody is the same
// request unmetered, for a caller (serpapi.ts) that judges the call by what
// the body says and reports it itself.

import { canonicaliseUrl } from "../lib/url";
import { beginCall } from "./meter";
import { SourceError, type SourceInput, type SourceOperation, type SourceProvider } from "./types";

export const USER_AGENT = "DealZ/0.1 (+https://github.com/rafipinc/dealZ)";
/** Default request timeout. Archived pages are slow; the wayback source passes a longer one. */
export const REQUEST_TIMEOUT_MS = 15_000;

export interface FetchTextInit extends RequestInit {
  /** Abort the request after this many milliseconds. Defaults to REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
  /**
   * What the request is, for the meter. Defaults to a retailer page, which is
   * what every live page source fetches.
   */
  call?: { provider: SourceProvider; operation: SourceOperation };
}

/** A response that arrived with a 2xx status and a readable body. */
export interface HttpAnswer {
  body: string;
  status: number;
}

const PAGE_CALL = { provider: "retailer", operation: "page" } as const;

/** Markers of bot-protection pages, matched case-insensitively. */
const CHALLENGE_MARKERS: readonly string[] = [
  "pardon our interruption", // Imperva
  "captcha-delivery.com", // DataDome
  "please enable js and disable any ad blocker", // DataDome
  "_incapsula_resource", // Imperva
  "cf-challenge", // Cloudflare
  "just a moment...", // Cloudflare
];

/** Only the head of the body is scanned; challenge pages announce themselves early. */
const CHALLENGE_SCAN_LENGTH = 8 * 1024;

/** True when a 2xx body is a bot challenge rather than the page asked for. */
export function looksLikeChallenge(body: string): boolean {
  const head = body.slice(0, CHALLENGE_SCAN_LENGTH).toLowerCase();
  return CHALLENGE_MARKERS.some((marker) => head.includes(marker));
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Performs the request and returns the body and status. Throws SourceError:
 * "network" when fetch itself rejects or the body cannot be read, "blocked"
 * on 403, 429 or a challenge page, "http" on any other non-2xx status.
 * Reports nothing to the meter; the caller does.
 */
export async function fetchBody(
  input: Pick<SourceInput, "retailerSlug" | "fetch">,
  url: string,
  init: Omit<FetchTextInit, "call"> = {},
): Promise<HttpAnswer> {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const { retailerSlug } = input;
  const { timeoutMs = REQUEST_TIMEOUT_MS, ...requestInit } = init;
  const headers = new Headers(requestInit.headers);
  headers.set("user-agent", USER_AGENT);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...requestInit,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    throw new SourceError(
      "network",
      retailerSlug,
      `Request to ${url} failed: ${messageOf(cause)}`,
      {
        cause,
      },
    );
  }

  const { status } = response;
  if (status === 403 || status === 429) {
    throw new SourceError("blocked", retailerSlug, `${url} answered ${status}`, { status });
  }
  if (!response.ok) {
    throw new SourceError("http", retailerSlug, `${url} answered ${status}`, { status });
  }

  let body: string;
  try {
    body = await response.text();
  } catch (cause) {
    throw new SourceError("network", retailerSlug, `Body of ${url} could not be read`, { cause });
  }
  if (looksLikeChallenge(body)) {
    throw new SourceError("blocked", retailerSlug, `${url} answered with a bot challenge page`, {
      status,
    });
  }
  return { body, status };
}

/**
 * fetchBody, returning the text and reporting the request to `input.meter`:
 * ok when a body came back, failed with the SourceError's kind otherwise.
 * What a parser later makes of the body is not the request's outcome.
 */
export async function fetchText(
  input: SourceInput,
  url: string,
  init: FetchTextInit = {},
): Promise<string> {
  const { call = PAGE_CALL, ...requestInit } = init;
  const finish = beginCall(input.meter, input.now, { ...call, retailerSlug: input.retailerSlug });
  try {
    const answer = await fetchBody(input, url, requestInit);
    finish({ httpStatus: answer.status });
    return answer.body;
  } catch (error) {
    finish({ error });
    throw error;
  }
}

/** Canonicalises the page URL, or throws SourceError so rule 9 holds for a bad URL. */
export function pageUrlOf(input: Pick<SourceInput, "retailerSlug" | "url">): string {
  try {
    return canonicaliseUrl(input.url);
  } catch (cause) {
    throw new SourceError("unparseable", input.retailerSlug, `Invalid page URL: ${input.url}`, {
      cause,
    });
  }
}

/** A storefront origin as a URL origin, or throws SourceError so rule 9 holds for a bad one. */
export function originOf(input: { retailerSlug: string; origin: string }): string {
  let url: URL;
  try {
    url = new URL(input.origin);
  } catch (cause) {
    throw new SourceError("unparseable", input.retailerSlug, `Invalid origin: ${input.origin}`, {
      cause,
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SourceError("unparseable", input.retailerSlug, `Invalid origin: ${input.origin}`);
  }
  return url.origin;
}
