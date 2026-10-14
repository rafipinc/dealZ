// The history view builder only: how the HistoryReport of the quotes service
// becomes the strings and chart coordinates the lab panel draws. The other
// view builders are covered end to end.

import { describe, expect, it } from "vitest";
import type {
  HistoryModelClaim,
  HistoryModelPoint,
  HistoryPage,
  HistoryReport,
} from "@/services/quotes";
import { toHistoryView, type HistoryView } from "./view";

/** Midnight in Sydney (AEST) of an ISO date, as the service dates its points. */
const sydney = (isoDate: string) => new Date(`${isoDate}T00:00:00+10:00`);

const variant = {
  slug: "hisense-s85h-65-au",
  displayName: "Hisense 65-inch S85H",
  mpn: "65S85H",
  gtin: "06942147498651",
  rrpCents: 329_900,
};

const jbPage: HistoryPage = {
  status: "ok",
  retailerSlug: "jb-hi-fi",
  retailerName: "JB Hi-Fi",
  url: "https://www.jbhifi.com.au/products/hisense-65-s85h",
  snapshotsFound: 2,
  points: [
    {
      observedAt: sydney("2026-05-14"),
      priceCents: 249_500,
      strikethroughCents: null,
      condition: "new",
      snapshotUrl: "https://web.archive.org/web/20260514/jb",
    },
    {
      observedAt: sydney("2026-07-02"),
      priceCents: 219_500,
      strikethroughCents: 249_500,
      condition: "new",
      snapshotUrl: "https://web.archive.org/web/20260702/jb",
    },
  ],
  skipped: [],
};

const goodGuysPage: HistoryPage = {
  status: "failed",
  retailerSlug: "the-good-guys",
  retailerName: "The Good Guys",
  url: "https://www.thegoodguys.com.au/hisense-65-s85h",
  kind: "blocked",
  message: "bot protection answered",
};

const verifiedPoint: HistoryModelPoint = {
  retailerSlug: "jb-hi-fi",
  retailerName: "JB Hi-Fi",
  observedAt: sydney("2026-05-28"),
  priceCents: 199_500,
  sourceUrl: "https://www.jbhifi.com.au/pages/catalogue-2026-05-28",
  quote: "Hisense 65 S85H $1995",
  confidence: 0.8,
  dateSource: "url",
};

const candidateClaim: HistoryModelClaim = {
  retailerSlug: "bing-lee",
  retailerName: "Bing Lee",
  priceCents: 179_500,
  sourceUrl: "https://www.binglee.com.au/hisense-65s85h",
  quote: "65S85H $1,795",
  claimedDate: "2026-06-10",
  verdict: "candidate",
  confidence: 0.6,
  observedDate: "2026-06-24",
  observedAt: sydney("2026-06-24"),
  fragment: "weak",
  dateSource: "page",
  reasons: ["price near the model code", "fragment matched weakly"],
};

const unverifiedClaim: HistoryModelClaim = {
  ...candidateClaim,
  retailerSlug: "harvey-norman",
  retailerName: "Harvey Norman",
  sourceUrl: "https://www.harveynorman.com.au/hisense-65s85h",
  claimedDate: null,
  verdict: "unverified",
  confidence: 0.4,
  observedDate: null,
  observedAt: null,
  fragment: null,
  dateSource: null,
  reasons: ["page unreachable"],
};

const okSearch: HistoryReport["modelSearch"] = {
  status: "ok",
  model: "gpt-6-luna",
  searches: 3,
  pageOpens: 5,
  verified: [verifiedPoint],
  candidates: [candidateClaim],
  rejected: [],
  unverified: [unverifiedClaim],
};

const baseReport: HistoryReport = {
  variant,
  fetchedAt: new Date("2026-10-13T02:00:00.000Z"),
  from: sydney("2026-03-01"),
  to: sydney("2026-10-13"),
  pages: [jbPage, goodGuysPage],
  modelSearch: { status: "skipped", reason: "no-key" },
  lowest: {
    kind: "archive",
    retailerSlug: "jb-hi-fi",
    priceCents: 219_500,
    observedAt: sydney("2026-07-02"),
  },
  usage: { calls: 3, recorded: 3 },
};

const withModel: HistoryReport = {
  ...baseReport,
  modelSearch: okSearch,
  lowest: {
    kind: "model",
    retailerSlug: "jb-hi-fi",
    priceCents: 199_500,
    observedAt: sydney("2026-05-28"),
  },
};

function okSearchView(view: HistoryView) {
  if (view.modelSearch.status !== "ok") throw new Error("expected an ok model search");
  return view.modelSearch;
}

describe("toHistoryView: model search status", () => {
  it.each([
    ["no-key", "No OpenAI key is set"],
    ["daily-cap", "The OpenAI daily cap is reached"],
    ["disabled", "The model search is disabled, OPENAI_DAILY_CAP is 0"],
    ["budget-unknown", "The ledger could not be read, so nothing was spent"],
  ] as const)("says why a %s skip asked nothing", (reason, sentence) => {
    const view = toHistoryView({ ...baseReport, modelSearch: { status: "skipped", reason } });
    expect(view.modelSearch).toEqual({ status: "skipped", reason, sentence });
  });

  it("carries the kind and message of a failed search", () => {
    const view = toHistoryView({
      ...baseReport,
      modelSearch: { status: "failed", kind: "network", message: "timed out" },
    });
    expect(view.modelSearch).toMatchObject({
      status: "failed",
      kind: "network",
      message: "timed out",
    });
    expect(view.modelSearch.sentence).toMatch(/failed/);
  });

  it("reports the model, its searches and page opens", () => {
    const search = okSearchView(toHistoryView(withModel));
    expect(search).toMatchObject({ model: "gpt-6-luna", searches: 3, pageOpens: 5 });
    expect(search.sentence).toBe(
      "The model answered: 1 point verified on the page, 2 other claims",
    );
  });

  it("says when the model answered with nothing", () => {
    const search = okSearchView(
      toHistoryView({
        ...baseReport,
        modelSearch: { ...okSearch, verified: [], candidates: [], unverified: [] },
      }),
    );
    expect(search.sentence).toBe("The model answered with no claims");
  });
});

describe("toHistoryView: verified points and claims", () => {
  it("formats a verified point with its source, date source and confidence", () => {
    const [point] = okSearchView(toHistoryView(withModel)).verified;
    expect(point).toEqual({
      date: "2026-05-28",
      label: "28 May 2026",
      price: "$1,995.00",
      priceCents: 199_500,
      retailerName: "JB Hi-Fi",
      retailerSlug: "jb-hi-fi",
      sourceUrl: verifiedPoint.sourceUrl,
      quote: "Hisense 65 S85H $1995",
      quoteFull: "Hisense 65 S85H $1995",
      confidence: "0.8",
      dateSourceLabel: "from the URL",
    });
  });

  it("truncates a long quote to 160 characters and keeps the whole in quoteFull", () => {
    const quote = "x".repeat(200);
    const [point] = okSearchView(
      toHistoryView({
        ...withModel,
        modelSearch: { ...okSearch, verified: [{ ...verifiedPoint, quote, dateSource: "page" }] },
      }),
    ).verified;
    expect(point.quote).toHaveLength(160);
    expect(point.quote.endsWith("…")).toBe(true);
    expect(point.quoteFull).toBe(quote);
    expect(point.dateSourceLabel).toBe("from the page");
  });

  it("lists candidates, rejected and unverified claims together with a verdict label", () => {
    const { claims } = okSearchView(toHistoryView(withModel));
    expect(claims.map((claim) => claim.verdictLabel)).toEqual(["Candidate", "Unverified"]);
    expect(claims[0]).toMatchObject({
      retailerName: "Bing Lee",
      claimedDateLabel: "2026-06-10",
      observedLabel: "24 June 2026",
      price: "$1,795.00",
      sourceUrl: candidateClaim.sourceUrl,
      reason: "price near the model code; fragment matched weakly",
    });
    expect(claims[1]).toMatchObject({ claimedDateLabel: "none", observedLabel: "undated" });
  });
});

describe("toHistoryView: chart", () => {
  it("draws an archive series linking each point to its snapshot", () => {
    const chart = toHistoryView(baseReport).chart;
    expect(chart?.series).toHaveLength(1);
    expect(chart?.series[0]).toMatchObject({ retailerSlug: "jb-hi-fi", kind: "archive" });
    expect(chart?.series[0].points[0]).toEqual({
      x: "2026-05-14",
      y: 249_500,
      title: "JB Hi-Fi, 14 May 2026, $2,495.00, archive capture",
      href: "https://web.archive.org/web/20260514/jb",
      kind: "archive",
    });
  });

  it("gives a verified model point its own series, sharing the retailer's colour", () => {
    const chart = toHistoryView(withModel).chart;
    const archive = chart?.series.find((series) => series.kind === "archive");
    const model = chart?.series.find((series) => series.kind === "model");
    expect(model).toMatchObject({ retailerSlug: "jb-hi-fi", retailerName: "JB Hi-Fi" });
    expect(model?.colourIndex).toBe(archive?.colourIndex);
    expect(model?.points).toEqual([
      {
        x: "2026-05-28",
        y: 199_500,
        title: "JB Hi-Fi, 28 May 2026, $1,995.00, model-found page",
        href: verifiedPoint.sourceUrl,
        kind: "model",
      },
    ]);
    expect(chart?.ariaLabel).toContain("JB Hi-Fi: 1 model-found price");
    expect(chart?.ariaLabel).toContain("JB Hi-Fi: 2 archived prices");
  });

  it("never charts a candidate", () => {
    const chart = toHistoryView(withModel).chart;
    expect(chart?.series.some((series) => series.retailerSlug === "bing-lee")).toBe(false);
    expect(chart?.series.flatMap((series) => series.points).some((p) => p.y === 179_500)).toBe(
      false,
    );
  });

  it("widens the bounds to a model point lower and earlier than every capture", () => {
    const early: HistoryModelPoint = { ...verifiedPoint, observedAt: sydney("2026-04-01") };
    const chart = toHistoryView({
      ...withModel,
      modelSearch: { ...okSearch, verified: [early] },
    }).chart;
    expect(chart?.yMin).toBeLessThanOrEqual(199_500);
    expect(chart?.yMin).toBe(190_000);
    expect(chart?.yMax).toBeGreaterThanOrEqual(249_500);
    expect(chart?.xMin).toBe("2026-04-01");
    expect(chart?.xMax).toBe("2026-07-02");
  });

  it("charts the model points alone when no page gave a point", () => {
    const chart = toHistoryView({
      ...withModel,
      pages: [goodGuysPage],
    }).chart;
    expect(chart?.series.map((series) => series.kind)).toEqual(["model"]);
    expect(chart?.xMin).toBe("2026-05-27");
    expect(chart?.xMax).toBe("2026-05-29");
  });

  it("has no chart when nothing was charted", () => {
    const view = toHistoryView({ ...baseReport, pages: [goodGuysPage], lowest: null });
    expect(view.chart).toBeNull();
    expect(view.lowest).toBeNull();
  });
});

describe("toHistoryView: lowest", () => {
  it("labels an archive lowest and links to its snapshot", () => {
    expect(toHistoryView(baseReport).lowest).toEqual({
      kind: "archive",
      kindLabel: "archive capture",
      href: "https://web.archive.org/web/20260702/jb",
      retailerSlug: "jb-hi-fi",
      retailerName: "JB Hi-Fi",
      price: "$2,195.00",
      priceCents: 219_500,
      date: "2026-07-02",
      label: "2 July 2026",
    });
  });

  it("labels a model lowest and links to the page it was verified on", () => {
    expect(toHistoryView(withModel).lowest).toEqual({
      kind: "model",
      kindLabel: "model-found page",
      href: verifiedPoint.sourceUrl,
      retailerSlug: "jb-hi-fi",
      retailerName: "JB Hi-Fi",
      price: "$1,995.00",
      priceCents: 199_500,
      date: "2026-05-28",
      label: "28 May 2026",
    });
  });
});
