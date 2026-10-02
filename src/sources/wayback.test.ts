import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SourceError, type ArchiveSourceInput, type FetchLike, type SourceCall } from "./types";
import {
  ARCHIVE_CONFIDENCE,
  AVAILABILITY_ENDPOINT,
  CDX_ENDPOINT,
  fetchWaybackHistory,
  monthsBetween,
  parseWaybackTimestamp,
  RATE_LIMITED_SKIP_MESSAGE,
  waybackSnapshotUrl,
} from "./wayback";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

const cdxBody = fixture("wayback-cdx-jbhifi.json");
const availableBody = fixture("wayback-available.json");
const productPage = fixture("thegoodguys-s85h-65.html");
const harveyNorman = fixture("harveynorman-challenge.html");

const PAGE_URL = "https://www.jbhifi.com.au/products/samsung-65-s85h-oled-4k-smart-ai-tv-2026";
const FROM = new Date("2026-05-01T00:00:00.000Z");
const TO = new Date("2026-09-28T00:00:00.000Z");
const FIXED_NOW = new Date("2026-09-28T03:04:05.000Z");
const TIMESTAMPS = ["20260514025141", "20260608031844", "20260807110400", "20260927050146"];

/** A distinct price per snapshot so each quote can be told apart. */
const PRICE_BY_TIMESTAMP: Record<string, string> = {
  "20260514025141": "3295.00",
  "20260608031844": "2995.00",
  "20260807110400": "2795.00",
  "20260927050146": "2695.00",
};

function snapshotPage(ts: string): string {
  const price = PRICE_BY_TIMESTAMP[ts] ?? "2795.00";
  return productPage.replace('"price": "2795.00"', `"price": "${price}"`);
}

function timestampOf(url: string): string | null {
  const match = /\/web\/(\d{14})id_\//.exec(url);
  return match === null ? null : match[1];
}

type Call = { url: string; init?: RequestInit };
type Responder = (url: string, call: Call) => Response | Promise<Response>;

/** Routes by URL: CDX, availability and snapshot requests each get a handler. */
function fakeFetch(handlers: {
  cdx?: Responder;
  available?: Responder;
  snapshot?: (ts: string, url: string, call: Call) => Response | Promise<Response>;
}) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    if (url.startsWith(CDX_ENDPOINT)) {
      return (handlers.cdx ?? (() => new Response(cdxBody, { status: 200 })))(url, call);
    }
    if (url.startsWith(AVAILABILITY_ENDPOINT)) {
      return (handlers.available ?? (() => new Response(availableBody, { status: 200 })))(
        url,
        call,
      );
    }
    const ts = timestampOf(url);
    if (ts === null) throw new Error(`Unexpected request: ${url}`);
    return (handlers.snapshot ?? ((t) => new Response(snapshotPage(t), { status: 200 })))(
      ts,
      url,
      call,
    );
  };
  return { fetch, calls };
}

function inputWith(fetch: FetchLike, patch: Partial<ArchiveSourceInput> = {}): ArchiveSourceInput {
  return {
    retailerSlug: "jb-hi-fi",
    retailerName: "JB Hi-Fi",
    url: `${PAGE_URL}?gclid=abc`,
    from: FROM,
    to: TO,
    maxSnapshots: 12,
    fetch,
    now: () => FIXED_NOW,
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

describe("parseWaybackTimestamp", () => {
  it("reads yyyyMMddHHmmss as UTC", () => {
    expect(parseWaybackTimestamp("20260514025141").toISOString()).toBe("2026-05-14T02:51:41.000Z");
  });

  it("throws on anything else", () => {
    expect(() => parseWaybackTimestamp("2026-05-14")).toThrowError(RangeError);
    expect(() => parseWaybackTimestamp("202605140251411")).toThrowError(RangeError);
  });
});

describe("waybackSnapshotUrl", () => {
  it("uses the id_ flag so the original bytes come back", () => {
    expect(waybackSnapshotUrl("20260514025141", PAGE_URL)).toBe(
      `https://web.archive.org/web/20260514025141id_/${PAGE_URL}`,
    );
  });
});

describe("monthsBetween", () => {
  it("lists every month from the first to the last, crossing a year boundary", () => {
    expect(monthsBetween(FROM, TO)).toEqual(["202605", "202606", "202607", "202608", "202609"]);
    expect(
      monthsBetween(new Date("2025-11-20T00:00:00Z"), new Date("2026-02-01T00:00:00Z")),
    ).toEqual(["202511", "202512", "202601", "202602"]);
  });

  it("returns nothing when from is after to", () => {
    expect(monthsBetween(TO, FROM)).toEqual([]);
  });
});

describe("fetchWaybackHistory", () => {
  it("asks the CDX API for monthly html captures of the page without its scheme", async () => {
    const { fetch, calls } = fakeFetch({});
    await fetchWaybackHistory(inputWith(fetch));
    const cdx = new URL(calls[0].url);
    expect(cdx.origin + cdx.pathname).toBe(CDX_ENDPOINT);
    expect(cdx.searchParams.get("url")).toBe(PAGE_URL.replace("https://", ""));
    expect(cdx.searchParams.get("from")).toBe("20260501");
    expect(cdx.searchParams.get("to")).toBe("20260928");
    expect(cdx.searchParams.get("output")).toBe("json");
    expect(cdx.searchParams.get("fl")).toBe("timestamp,statuscode,mimetype");
    expect(cdx.searchParams.getAll("filter")).toEqual(["statuscode:200", "mimetype:text/html"]);
    expect(cdx.searchParams.get("collapse")).toBe("timestamp:6");
  });

  it("turns four snapshots into four quotes, newest first, dated by capture", async () => {
    const { fetch, calls } = fakeFetch({});
    const { quotes, snapshotsFound, skipped } = await fetchWaybackHistory(inputWith(fetch));

    expect(calls).toHaveLength(5);
    const snapshotCalls = calls.slice(1);
    expect(snapshotCalls.map((c) => c.url).sort()).toEqual(
      TIMESTAMPS.map((ts) => waybackSnapshotUrl(ts, PAGE_URL)).sort(),
    );
    expect(new Headers(snapshotCalls[0].init?.headers).get("accept")).toBe("text/html");

    expect(quotes.map((q) => q.observedAt.toISOString())).toEqual([
      "2026-09-27T05:01:46.000Z",
      "2026-08-07T11:04:00.000Z",
      "2026-06-08T03:18:44.000Z",
      "2026-05-14T02:51:41.000Z",
    ]);
    expect(quotes.map((q) => q.priceCents)).toEqual([269500, 279500, 299500, 329500]);
    expect(snapshotsFound).toBe(4);
    expect(skipped).toEqual([]);
    expect(quotes.map((q) => q.provenance)).toEqual(
      [...TIMESTAMPS].reverse().map((ts) => ({
        kind: "archive",
        via: waybackSnapshotUrl(ts, PAGE_URL),
      })),
    );
    for (const quote of quotes) {
      expect(quote.method).toBe("wayback");
      expect(quote.url).toBe(PAGE_URL);
      expect(quote.retailerSlug).toBe("jb-hi-fi");
      expect(quote.retailerName).toBe("JB Hi-Fi");
      expect(quote.fetchedAt).toBe(FIXED_NOW);
      expect(quote.condition).toBe("new");
      expect(quote.currency).toBe("AUD");
      expect(quote.confidence).toBe(ARCHIVE_CONFIDENCE);
      expect(quote.confidence).toBe(0.9);
      expect(quote.evidence).toBeNull();
      expect(quote.shippingCents).toBeNull();
    }
  });

  it("keeps only the newest maxSnapshots captures", async () => {
    const { fetch, calls } = fakeFetch({});
    const { quotes, snapshotsFound } = await fetchWaybackHistory(
      inputWith(fetch, { maxSnapshots: 2 }),
    );
    expect(calls).toHaveLength(3);
    expect(snapshotsFound).toBe(2);
    expect(quotes.map((q) => q.observedAt.toISOString())).toEqual([
      "2026-09-27T05:01:46.000Z",
      "2026-08-07T11:04:00.000Z",
    ]);
  });

  it("reports a capture that answers 404 and one that answers a challenge page, and keeps the rest", async () => {
    // The challenge sits on the oldest capture so nothing is left to skip after it.
    const { fetch } = fakeFetch({
      snapshot: (ts) => {
        if (ts === "20260608031844") return new Response("gone", { status: 404 });
        if (ts === "20260514025141") return new Response(harveyNorman, { status: 200 });
        return new Response(snapshotPage(ts), { status: 200 });
      },
    });
    const { quotes, snapshotsFound, skipped } = await fetchWaybackHistory(inputWith(fetch));

    expect(quotes.map((q) => q.priceCents)).toEqual([269500, 279500]);
    expect(snapshotsFound).toBe(4);
    expect(skipped).toHaveLength(2);
    expect(
      skipped.map(({ snapshotUrl, observedAt, kind }) => ({ snapshotUrl, observedAt, kind })),
    ).toEqual([
      {
        snapshotUrl: waybackSnapshotUrl("20260608031844", PAGE_URL),
        observedAt: new Date("2026-06-08T03:18:44.000Z"),
        kind: "http",
      },
      {
        snapshotUrl: waybackSnapshotUrl("20260514025141", PAGE_URL),
        observedAt: new Date("2026-05-14T02:51:41.000Z"),
        kind: "blocked",
      },
    ]);
    expect(skipped[0].message).toContain("404");
    expect(skipped[1].message).toContain("bot challenge");
  });

  it("stops requesting a page's remaining snapshots once the archive rate-limits it", async () => {
    const { fetch, calls } = fakeFetch({
      snapshot: async (ts) => {
        // The newest capture is refused at once; the two in flight beside it
        // take a moment, so the fourth is admitted after the refusal.
        if (ts === "20260927050146") return new Response("slow down", { status: 429 });
        await new Promise((resolve) => setTimeout(resolve, 5));
        return new Response(snapshotPage(ts), { status: 200 });
      },
    });
    const { quotes, snapshotsFound, skipped } = await fetchWaybackHistory(inputWith(fetch));

    expect(quotes.map((q) => q.priceCents)).toEqual([279500, 299500]);
    expect(snapshotsFound).toBe(4);
    expect(calls.filter((c) => timestampOf(c.url) !== null)).toHaveLength(3);
    expect(skipped).toEqual([
      {
        snapshotUrl: waybackSnapshotUrl("20260927050146", PAGE_URL),
        observedAt: new Date("2026-09-27T05:01:46.000Z"),
        kind: "blocked",
        message: `${waybackSnapshotUrl("20260927050146", PAGE_URL)} answered 429`,
      },
      {
        snapshotUrl: waybackSnapshotUrl("20260514025141", PAGE_URL),
        observedAt: new Date("2026-05-14T02:51:41.000Z"),
        kind: "blocked",
        message: RATE_LIMITED_SKIP_MESSAGE,
      },
    ]);
  });

  it("reports a capture without a Product as unparseable", async () => {
    const { fetch } = fakeFetch({
      snapshot: (ts) =>
        ts === "20260608031844"
          ? new Response("<html>no product</html>", { status: 200 })
          : new Response(snapshotPage(ts), { status: 200 }),
    });
    const { quotes, snapshotsFound, skipped } = await fetchWaybackHistory(inputWith(fetch));
    expect(quotes.map((q) => q.priceCents)).toEqual([269500, 279500, 329500]);
    expect(snapshotsFound).toBe(4);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].kind).toBe("unparseable");
    expect(skipped[0].snapshotUrl).toBe(waybackSnapshotUrl("20260608031844", PAGE_URL));
    expect(skipped[0].message).toContain("no JSON-LD Product");
  });

  it("reports every capture as a network skip when no snapshot can be downloaded", async () => {
    const { fetch } = fakeFetch({
      snapshot: () => {
        throw new Error("ENOTFOUND web.archive.org");
      },
    });
    const { quotes, snapshotsFound, skipped } = await fetchWaybackHistory(inputWith(fetch));
    expect(quotes).toEqual([]);
    expect(snapshotsFound).toBe(4);
    expect(skipped).toHaveLength(4);
    expect(skipped.map((s) => s.kind)).toEqual(["network", "network", "network", "network"]);
    expect(skipped.map((s) => s.snapshotUrl)).toEqual(
      [...TIMESTAMPS].reverse().map((ts) => waybackSnapshotUrl(ts, PAGE_URL)),
    );
    expect(skipped.map((s) => s.observedAt.toISOString())).toEqual([
      "2026-09-27T05:01:46.000Z",
      "2026-08-07T11:04:00.000Z",
      "2026-06-08T03:18:44.000Z",
      "2026-05-14T02:51:41.000Z",
    ]);
    for (const entry of skipped) expect(entry.message).toContain("ENOTFOUND");
  });

  it("ignores CDX rows that are not captures", async () => {
    const { fetch } = fakeFetch({
      cdx: () =>
        new Response(
          JSON.stringify([
            ["timestamp"],
            ["20260927050146"],
            ["not-a-timestamp"],
            "not a row",
            [20260807110400],
          ]),
          { status: 200 },
        ),
    });
    const { quotes } = await fetchWaybackHistory(inputWith(fetch));
    expect(quotes).toHaveLength(1);
  });

  it("reports no captures for an empty CDX body without fetching anything else", async () => {
    const { fetch, calls } = fakeFetch({ cdx: () => new Response("", { status: 200 }) });
    expect(await fetchWaybackHistory(inputWith(fetch))).toEqual({
      quotes: [],
      snapshotsFound: 0,
      skipped: [],
    });
    expect(calls).toHaveLength(1);
  });

  it("throws unparseable when the CDX body is not a JSON table and does not fall back", async () => {
    const { fetch: notJson, calls } = fakeFetch({
      cdx: () => new Response("<html>oops</html>", { status: 200 }),
    });
    const a = await sourceErrorFrom(fetchWaybackHistory(inputWith(notJson)));
    expect(a.kind).toBe("unparseable");
    expect(calls).toHaveLength(1);

    const { fetch: notTable } = fakeFetch({
      cdx: () => new Response('{"rows": []}', { status: 200 }),
    });
    const b = await sourceErrorFrom(fetchWaybackHistory(inputWith(notTable)));
    expect(b.kind).toBe("unparseable");
  });

  it("falls back to the availability API when the CDX host is unreachable and deduplicates timestamps", async () => {
    const { fetch, calls } = fakeFetch({
      cdx: () => {
        throw new Error("ENOTFOUND web.archive.org");
      },
    });
    const { quotes } = await fetchWaybackHistory(inputWith(fetch));

    const availability = calls.filter((c) => c.url.startsWith(AVAILABILITY_ENDPOINT));
    expect(availability).toHaveLength(5);
    const first = new URL(availability[0].url);
    expect(first.searchParams.get("url")).toBe(PAGE_URL);
    expect(first.searchParams.get("timestamp")).toBe("20260515");

    expect(quotes).toHaveLength(1);
    expect(quotes[0].observedAt.toISOString()).toBe("2026-09-27T05:01:46.000Z");
    expect(quotes[0].provenance.via).toBe(waybackSnapshotUrl("20260927050146", PAGE_URL));
  });

  it("falls back on a CDX http error and ignores availability answers without a 200 capture", async () => {
    const byMonth: Record<string, unknown> = {
      "20260515": { archived_snapshots: {} },
      "20260615": {
        archived_snapshots: { closest: { status: "404", timestamp: "20260608031844" } },
      },
      "20260715": "not json",
      "20260815": {
        archived_snapshots: { closest: { status: "200", timestamp: "20260807110400" } },
      },
      "20260915": { url: PAGE_URL },
    };
    const { fetch } = fakeFetch({
      cdx: () => new Response("service unavailable", { status: 503 }),
      available: (url) => {
        const ts = new URL(url).searchParams.get("timestamp") ?? "";
        const body = byMonth[ts];
        return new Response(typeof body === "string" ? body : JSON.stringify(body), {
          status: 200,
        });
      },
    });
    const { quotes } = await fetchWaybackHistory(inputWith(fetch));
    expect(quotes.map((q) => q.observedAt.toISOString())).toEqual(["2026-08-07T11:04:00.000Z"]);
  });

  it("survives some availability months failing as long as one answers", async () => {
    const { fetch } = fakeFetch({
      cdx: () => new Response("bad gateway", { status: 502 }),
      available: (url) =>
        url.includes("timestamp=202609")
          ? new Response(availableBody, { status: 200 })
          : new Response("no", { status: 500 }),
    });
    const { quotes } = await fetchWaybackHistory(inputWith(fetch));
    expect(quotes).toHaveLength(1);
  });

  it("throws when both discovery routes fail", async () => {
    const { fetch } = fakeFetch({
      cdx: () => {
        throw new Error("ENOTFOUND web.archive.org");
      },
      available: () => new Response("no", { status: 500 }),
    });
    const error = await sourceErrorFrom(fetchWaybackHistory(inputWith(fetch)));
    expect(error.kind).toBe("http");
    expect(error.status).toBe(500);
    expect(error.retailerSlug).toBe("jb-hi-fi");
    expect(error.message).toContain("Neither the CDX API");
    expect(error.message).toContain("availability API");
  });

  it("returns nothing when CDX fails and the range has no months for the fallback to try", async () => {
    const { fetch } = fakeFetch({
      cdx: () => {
        throw new Error("ENOTFOUND web.archive.org");
      },
    });
    const result = await fetchWaybackHistory(inputWith(fetch, { from: TO, to: FROM }));
    expect(result).toEqual({ quotes: [], snapshotsFound: 0, skipped: [] });
  });

  it("throws unparseable for a page URL that is not http", async () => {
    const { fetch } = fakeFetch({});
    const error = await sourceErrorFrom(fetchWaybackHistory(inputWith(fetch, { url: "nope" })));
    expect(error.kind).toBe("unparseable");
  });

  it("never has more than three snapshot requests in flight", async () => {
    const rows = [["timestamp"], ...Array.from({ length: 7 }, (_, i) => [`2026090${i + 1}120000`])];
    let inFlight = 0;
    let peak = 0;
    const { fetch } = fakeFetch({
      cdx: () => new Response(JSON.stringify(rows), { status: 200 }),
      snapshot: async (ts) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return new Response(snapshotPage(ts), { status: 200 });
      },
    });
    const { quotes } = await fetchWaybackHistory(inputWith(fetch));
    expect(quotes).toHaveLength(7);
    expect(peak).toBe(3);
    expect(quotes.map((q) => q.observedAt.getUTCDate())).toEqual([7, 6, 5, 4, 3, 2, 1]);
  });

  it("never has more than three archive requests in flight across two pages fetched at once", async () => {
    const rows = [["timestamp"], ...Array.from({ length: 7 }, (_, i) => [`2026090${i + 1}120000`])];
    const inner = fakeFetch({
      cdx: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return new Response(JSON.stringify(rows), { status: 200 });
      },
      snapshot: async (ts) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return new Response(snapshotPage(ts), { status: 200 });
      },
    });
    let inFlight = 0;
    let peak = 0;
    const fetch: FetchLike = async (url, init) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        return await inner.fetch(url, init);
      } finally {
        inFlight -= 1;
      }
    };
    const otherPage = "https://www.jbhifi.com.au/products/samsung-55-s85h-oled-4k-smart-ai-tv-2026";
    const [a, b] = await Promise.all([
      fetchWaybackHistory(inputWith(fetch)),
      fetchWaybackHistory(inputWith(fetch, { url: otherPage })),
    ]);
    expect(a.quotes).toHaveLength(7);
    expect(b.quotes).toHaveLength(7);
    expect(inner.calls).toHaveLength(16);
    expect(peak).toBe(3);
  });
});

describe("fetchWaybackHistory metering", () => {
  function metered(fetch: FetchLike, patch: Partial<ArchiveSourceInput> = {}) {
    const calls: SourceCall[] = [];
    const input = inputWith(fetch, { meter: (call) => void calls.push(call), ...patch });
    return { input, calls };
  }

  const operations = (calls: SourceCall[]): string[] => calls.map((call) => call.operation).sort();

  it("reports the index request and each snapshot, all for the page's retailer", async () => {
    const { fetch, calls: requests } = fakeFetch({});
    const { input, calls } = metered(fetch);
    await fetchWaybackHistory(input);

    expect(calls).toHaveLength(requests.length);
    expect(operations(calls)).toEqual(["cdx", "snapshot", "snapshot", "snapshot", "snapshot"]);
    expect(calls.every((call) => call.provider === "wayback")).toBe(true);
    expect(calls.every((call) => call.retailerSlug === "jb-hi-fi")).toBe(true);
    expect(calls.every((call) => call.outcome === "ok" && call.httpStatus === 200)).toBe(true);
    expect(calls.every((call) => call.startedAt === FIXED_NOW && call.durationMs === 0)).toBe(true);
  });

  it("reports a failed snapshot as a failed call and a capture without a Product as an ok one", async () => {
    const { fetch } = fakeFetch({
      snapshot: (ts) => {
        if (ts === "20260514025141") return new Response("gone", { status: 404 });
        if (ts === "20260608031844") return new Response("<html></html>", { status: 200 });
        return new Response(snapshotPage(ts), { status: 200 });
      },
    });
    const { input, calls } = metered(fetch);
    const result = await fetchWaybackHistory(input);

    expect(result.skipped).toHaveLength(2);
    const snapshots = calls.filter((call) => call.operation === "snapshot");
    expect(snapshots).toHaveLength(4);
    // The archive served the page; that it holds no price is not the request's failure.
    expect(snapshots.filter((call) => call.outcome === "failed")).toEqual([
      expect.objectContaining({ errorKind: "http", httpStatus: 404 }),
    ]);
  });

  it("reports the failed index request and every availability request of the fallback", async () => {
    const { fetch, calls: requests } = fakeFetch({
      cdx: () => {
        throw new Error("connect ETIMEDOUT");
      },
    });
    const { input, calls } = metered(fetch);
    await fetchWaybackHistory(input);

    expect(calls).toHaveLength(requests.length);
    const cdx = calls.filter((call) => call.operation === "cdx");
    expect(cdx).toEqual([
      expect.objectContaining({ outcome: "failed", errorKind: "network", httpStatus: null }),
    ]);
    // One availability request per month from May to September.
    expect(calls.filter((call) => call.operation === "availability")).toHaveLength(5);
  });

  it("reports nothing for a snapshot skipped after a rate limit, since no request was made", async () => {
    const { fetch, calls: requests } = fakeFetch({
      snapshot: () => new Response("slow down", { status: 429 }),
    });
    const { input, calls } = metered(fetch);
    const result = await fetchWaybackHistory(input);

    expect(result.skipped).toHaveLength(4);
    expect(calls).toHaveLength(requests.length);
    expect(calls.filter((call) => call.operation === "snapshot").length).toBeLessThan(4);
  });

  it("never puts a URL in a call", async () => {
    const { input, calls } = metered(fakeFetch({}).fetch);
    await fetchWaybackHistory(input);
    const text = JSON.stringify(calls);
    expect(text).not.toContain("archive.org");
    expect(text).not.toContain("jbhifi.com.au");
  });

  it("returns the history even when the meter throws", async () => {
    const { input } = metered(fakeFetch({}).fetch, {
      meter: () => {
        throw new Error("ledger down");
      },
    });
    expect((await fetchWaybackHistory(input)).quotes).toHaveLength(4);
  });
});
