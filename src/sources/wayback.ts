// wayback: reads the Wayback Machine's copies of one retailer page and
// returns one quote per snapshot that carries a JSON-LD Product with a
// price. This is how price history is backfilled for a page DealZ did not
// watch at the time. Two steps: discover snapshot timestamps, then fetch
// each snapshot's original bytes and parse it like a live page.
//
// Discovery has two routes. The CDX API (web.archive.org/cdx) lists every
// capture and is the primary. On 2026-09-28 that host was unreachable from
// the development machine while archive.org itself answered, so the
// availability API (archive.org/wayback/available), which returns the
// closest single capture to a timestamp, is the fallback: one request per
// month in the range, results deduplicated. Only when both routes fail does
// the source throw. A snapshot that fails to fetch or parse is reported in
// `skipped`, never dropped silently.
//
// Politeness. Every request to the archive, whichever page or call it is
// for, passes through one module-level gate that admits SNAPSHOT_CONCURRENCY
// requests at a time, first come first served. The gate is process-wide
// state on purpose: it guards one external host against this process as a
// whole, so five pages fetched in parallel still make at most three archive
// requests at once. It holds no business state. Once a snapshot download is
// answered with a rate limit (kind "blocked"), the rest of that page's
// snapshots that have not started are skipped rather than sent.

import { quoteFromJsonLdHtml } from "./json-ld";
import { fetchText, pageUrlOf, type FetchTextInit } from "./http";
import { createLimiter } from "./limiter";
import {
  SourceError,
  type ArchiveResult,
  type ArchiveSkippedSnapshot,
  type ArchiveSource,
  type ArchiveSourceInput,
  type PriceQuote,
  type SourceInput,
} from "./types";

export const CDX_ENDPOINT = "https://web.archive.org/cdx/search/cdx";
export const AVAILABILITY_ENDPOINT = "https://archive.org/wayback/available";
/** Archive requests in flight across the whole process. The archive is slow and rate-limits eager clients. */
export const SNAPSHOT_CONCURRENCY = 3;
/** Archived pages take longer than live ones. */
export const SNAPSHOT_TIMEOUT_MS = 30_000;
/** Message on a snapshot skipped because an earlier one on the same page was rate-limited. */
export const RATE_LIMITED_SKIP_MESSAGE = "Skipped after the archive rate-limited this page";
/**
 * Confidence for a price read from an archived copy: the same structured
 * data as the live page, but dated, and a capture can be stale or partial
 * (a page cached mid-update, a snapshot of a redirect). So 0.9, not 1.
 */
export const ARCHIVE_CONFIDENCE = 0.9;

/** Process-wide politeness gate for archive.org; see the note at the top. */
const archiveGate = createLimiter(SNAPSHOT_CONCURRENCY);

const TIMESTAMP_RE = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/;

/** A Wayback timestamp (yyyyMMddHHmmss, UTC) as a Date. Throws RangeError when malformed. */
export function parseWaybackTimestamp(ts: string): Date {
  const match = TIMESTAMP_RE.exec(ts);
  if (match === null) throw new RangeError(`Not a Wayback timestamp: ${ts}`);
  const [, year, month, day, hour, minute, second] = match.map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
}

/** The `id_` flag asks for the original bytes without the Wayback toolbar. */
export function waybackSnapshotUrl(ts: string, url: string): string {
  return `https://web.archive.org/web/${ts}id_/${url}`;
}

function yyyymmdd(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

/** "yyyyMM" for every month from `from` to `to` inclusive, in UTC. */
export function monthsBetween(from: Date, to: Date): string[] {
  const months: string[] = [];
  let year = from.getUTCFullYear();
  let month = from.getUTCMonth();
  const endYear = to.getUTCFullYear();
  const endMonth = to.getUTCMonth();
  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push(`${year}${String(month + 1).padStart(2, "0")}`);
    month += 1;
    if (month === 12) {
      month = 0;
      year += 1;
    }
  }
  return months;
}

function cdxUrl(pageUrl: string, from: Date, to: Date): string {
  const params = new URLSearchParams({
    url: pageUrl.replace(/^https?:\/\//, ""),
    from: yyyymmdd(from),
    to: yyyymmdd(to),
    output: "json",
    fl: "timestamp,statuscode,mimetype",
  });
  params.append("filter", "statuscode:200");
  params.append("filter", "mimetype:text/html");
  params.append("collapse", "timestamp:6");
  return `${CDX_ENDPOINT}?${params.toString()}`;
}

function availabilityUrl(pageUrl: string, month: string): string {
  const params = new URLSearchParams({ url: pageUrl, timestamp: `${month}15` });
  return `${AVAILABILITY_ENDPOINT}?${params.toString()}`;
}

/** fetchText behind the archive gate. Every archive request goes through here. */
function fetchArchive(input: SourceInput, url: string, init: FetchTextInit): Promise<string> {
  return archiveGate.run(() => fetchText(input, url, init));
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && TIMESTAMP_RE.test(value);
}

/** Newest first, deduplicated, capped. */
function newest(timestamps: string[], maxSnapshots: number): string[] {
  return Array.from(new Set(timestamps))
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    .slice(0, Math.max(0, maxSnapshots));
}

async function discoverViaCdx(input: ArchiveSourceInput, pageUrl: string): Promise<string[]> {
  const url = cdxUrl(pageUrl, input.from, input.to);
  const body = await fetchArchive(input, url, {
    headers: { accept: "application/json" },
    call: { provider: "wayback", operation: "cdx" },
  });
  if (body.trim() === "") return [];
  let rows: unknown;
  try {
    rows = JSON.parse(body);
  } catch (cause) {
    throw new SourceError("unparseable", input.retailerSlug, `${url} is not JSON`, { cause });
  }
  if (!Array.isArray(rows)) {
    throw new SourceError("unparseable", input.retailerSlug, `${url} is not a CDX table`);
  }
  // The first row is the header (fl order); every other row is a capture.
  return rows
    .slice(1)
    .map((row) => (Array.isArray(row) ? row[0] : null))
    .filter(isTimestamp);
}

function closestTimestampOf(body: string): string | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const snapshots = (json as { archived_snapshots?: unknown }).archived_snapshots;
  if (typeof snapshots !== "object" || snapshots === null) return null;
  const closest = (snapshots as { closest?: unknown }).closest;
  if (typeof closest !== "object" || closest === null) return null;
  const { status, timestamp } = closest as { status?: unknown; timestamp?: unknown };
  return status === "200" && isTimestamp(timestamp) ? timestamp : null;
}

async function discoverViaAvailability(
  input: ArchiveSourceInput,
  pageUrl: string,
  cdxError: SourceError,
): Promise<string[]> {
  const months = monthsBetween(input.from, input.to);
  let failures = 0;
  let lastError: SourceError = cdxError;
  const found = await Promise.all(
    months.map(async (month) => {
      try {
        const body = await fetchArchive(input, availabilityUrl(pageUrl, month), {
          headers: { accept: "application/json" },
          call: { provider: "wayback", operation: "availability" },
        });
        return closestTimestampOf(body);
      } catch (error) {
        failures += 1;
        if (error instanceof SourceError) lastError = error;
        return null;
      }
    }),
  );
  if (months.length > 0 && failures === months.length) {
    throw new SourceError(
      lastError.kind,
      input.retailerSlug,
      `Neither the CDX API (${cdxError.message}) nor the availability API (${lastError.message}) answered for ${pageUrl}`,
      { status: lastError.status ?? undefined, cause: lastError },
    );
  }
  return found.filter((ts): ts is string => ts !== null);
}

async function discoverSnapshots(input: ArchiveSourceInput, pageUrl: string): Promise<string[]> {
  try {
    return await discoverViaCdx(input, pageUrl);
  } catch (error) {
    if (error instanceof SourceError && (error.kind === "network" || error.kind === "http")) {
      return discoverViaAvailability(input, pageUrl, error);
    }
    throw error;
  }
}

type SnapshotOutcome =
  { kind: "quote"; quote: PriceQuote } | { kind: "skipped"; skipped: ArchiveSkippedSnapshot };

function skippedSnapshot(snapshotUrl: string, ts: string, error: unknown): ArchiveSkippedSnapshot {
  const observedAt = parseWaybackTimestamp(ts);
  if (error instanceof SourceError) {
    return { snapshotUrl, observedAt, kind: error.kind, message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { snapshotUrl, observedAt, kind: "unparseable", message };
}

export const fetchWaybackHistory: ArchiveSource = async (input) => {
  const pageUrl = pageUrlOf(input);
  const now = input.now ?? (() => new Date());

  const timestamps = newest(await discoverSnapshots(input, pageUrl), input.maxSnapshots);
  const fetchedAt = now();

  // Set once the archive answers "blocked" for this page. Snapshots that have
  // not been admitted by the gate yet are then skipped instead of requested.
  let rateLimited = false;

  // Every snapshot is queued on the gate at once; admission is FIFO, so they
  // start newest first, and Promise.all keeps the results in that order.
  const outcomes = await Promise.all(
    timestamps.map(async (ts): Promise<SnapshotOutcome> => {
      const snapshotUrl = waybackSnapshotUrl(ts, pageUrl);
      try {
        const html = await archiveGate.run(async () => {
          if (rateLimited) {
            throw new SourceError("blocked", input.retailerSlug, RATE_LIMITED_SKIP_MESSAGE);
          }
          try {
            return await fetchText(input, snapshotUrl, {
              headers: { accept: "text/html" },
              timeoutMs: SNAPSHOT_TIMEOUT_MS,
              call: { provider: "wayback", operation: "snapshot" },
            });
          } catch (error) {
            // Flagged here, before the gate hands the slot to the next
            // snapshot, so that one sees it.
            if (error instanceof SourceError && error.kind === "blocked") rateLimited = true;
            throw error;
          }
        });
        const quote = quoteFromJsonLdHtml(html, {
          pageUrl,
          method: "wayback",
          input,
          fetchedAt,
          observedAt: parseWaybackTimestamp(ts),
          provenance: { kind: "archive", via: snapshotUrl },
          confidence: ARCHIVE_CONFIDENCE,
        });
        return { kind: "quote", quote };
      } catch (error) {
        // A blocked, missing or product-less snapshot is not history, but the
        // caller must see that it was there.
        return { kind: "skipped", skipped: skippedSnapshot(snapshotUrl, ts, error) };
      }
    }),
  );

  const result: ArchiveResult = { quotes: [], snapshotsFound: timestamps.length, skipped: [] };
  for (const outcome of outcomes) {
    if (outcome.kind === "quote") result.quotes.push(outcome.quote);
    else result.skipped.push(outcome.skipped);
  }
  return result;
};
