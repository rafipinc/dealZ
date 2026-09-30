// Shared HTTP plumbing for sources. One request, one body, and every way it
// can go wrong mapped to a SourceError kind. Not exported from the index.

import { canonicaliseUrl } from "../lib/url";
import { SourceError, type SourceInput } from "./types";

export const USER_AGENT = "DealZ/0.1 (+https://github.com/rafipinc/dealZ)";
/** Default request timeout. Archived pages are slow; the wayback source passes a longer one. */
export const REQUEST_TIMEOUT_MS = 15_000;

export interface FetchTextInit extends RequestInit {
  /** Abort the request after this many milliseconds. Defaults to REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
}

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
 * Performs the request and returns the body as text. Throws SourceError:
 * "network" when fetch itself rejects or the body cannot be read, "blocked"
 * on 403, 429 or a challenge page, "http" on any other non-2xx status.
 */
export async function fetchText(
  input: SourceInput,
  url: string,
  init: FetchTextInit = {},
): Promise<string> {
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
  return body;
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
