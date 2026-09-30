// Serialisable views of the quotes service reports for the lab page.
// Everything the client shows is pre-formatted here so the panels render
// strings and style sign. No Dates cross the boundary: timestamps are ISO
// strings and chart coordinates are ISO dates and integer cents.

import { formatAud, formatVsCheapest, formatVsRrp } from "@/lib/money";
import type {
  ExtractReport,
  HistoryPage,
  HistoryPoint,
  HistoryReport,
  HistorySkippedSnapshot,
  IdentifierMatch,
  QuoteOutcome,
  QuoteOutcomeOk,
  QuoteReport,
  SearchQuote,
  SearchReport,
} from "@/services/quotes";
import { trackedVariants } from "@/services/tracked-products";

type Availability = QuoteOutcomeOk["quote"]["availability"];
type Condition = HistoryPoint["condition"];
type FailureKind = "blocked" | "http" | "unparseable" | "network";

export interface ViewError {
  ok: false;
  error: string;
  /** True for a configuration notice the user can act on, not a failure. */
  notice?: true;
}

interface VariantView {
  slug: string;
  displayName: string;
  mpn: string;
  gtin: string;
  rrp: string;
  rrpCents: number;
}

// ---------- Live quotes ----------

interface OutcomeViewBase {
  retailerSlug: string;
  retailerName: string;
  url: string;
}

export interface QuoteOutcomeViewOk extends OutcomeViewBase {
  status: "ok";
  title: string | null;
  price: string;
  priceCents: number;
  currency: string;
  was: string | null;
  wasCents: number | null;
  shippingCents: number | null;
  /** "Free", "$59.00" or "unknown". */
  delivery: string;
  isCheapest: boolean;
  /** "cheapest" for the cheapest row, "candidate" for a row needing review, otherwise "+$400.00". */
  vsCheapest: string;
  deltaFromCheapestCents: number;
  /** "-$500.00 (15% under RRP)", "+$100.00 (3% over RRP)" or "$0.00 (at RRP)". */
  vsRrp: string;
  deltaFromRrpCents: number;
  availability: Availability;
  stock: string;
  identifierMatch: IdentifierMatch;
  identifierLabel: string;
  gtin: string | null;
  mpn: string | null;
  retailerSku: string | null;
  method: string;
  /** 0 to 1, as the source assigned it. */
  confidence: number;
  /** "100%", "80%", "40%". */
  confidenceLabel: string;
  /** The model read this page because it carried no structured data (ADR-0013). */
  readByModel: boolean;
  /** Below the review threshold: a candidate, never a price. */
  needsReview: boolean;
  /** The page gave no price; this one came from the Google Shopping search. */
  filledBySearch: boolean;
  /** Why the page itself gave no price, when filledBySearch. */
  gapReason: string | null;
  /** The text fragment the price was read from, when a parser had to choose. */
  evidence: string | null;
  fetchedAt: string;
  raw: unknown;
}

export interface QuoteOutcomeViewFailed extends OutcomeViewBase {
  status: "failed";
  kind: FailureKind;
  message: string;
}

export interface QuoteOutcomeViewSkipped extends OutcomeViewBase {
  status: "skipped";
  reason: string;
}

export type QuoteOutcomeView =
  QuoteOutcomeViewOk | QuoteOutcomeViewFailed | QuoteOutcomeViewSkipped;

export interface QuoteViewOk {
  ok: true;
  variant: VariantView;
  fetchedAt: string;
  fetchedAtLabel: string;
  answered: number;
  total: number;
  cheapest: {
    retailerSlug: string;
    retailerName: string;
    price: string;
    priceCents: number;
  } | null;
  /** One sentence on what the search layer did, or null when every page answered. */
  gapFillNote: string | null;
  outcomes: QuoteOutcomeView[];
}

export type QuoteViewError = ViewError;

export type QuoteView = QuoteViewOk | QuoteViewError;

const SYDNEY = "Australia/Sydney";

const stockLabels: Record<Availability, string> = {
  in_stock: "In stock",
  out_of_stock: "Out of stock",
  unknown: "Unknown",
};

const conditionLabels: Record<Condition, string> = {
  new: "New",
  refurbished: "Refurbished",
  used: "Used",
  unknown: "Unknown",
};

const identifierLabels: Record<IdentifierMatch, string> = {
  gtin: "GTIN match",
  mpn: "model match",
  none: "no match",
};

function formatFetchedAt(date: Date): string {
  return new Intl.DateTimeFormat("en-AU", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: SYDNEY,
  }).format(date);
}

/** "2026-05-14": the calendar date in Sydney, as an ISO date string. */
function isoDateInSydney(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: SYDNEY,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** "14 May 2026" for an ISO date string, read as a calendar date. */
function formatIsoDate(isoDate: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(`${isoDate}T12:00:00Z`));
}

function shiftIsoDate(isoDate: string, days: number): string {
  const shifted = new Date(Date.parse(`${isoDate}T12:00:00Z`) + days * 86_400_000);
  return shifted.toISOString().slice(0, 10);
}

/** Whole dollars for an axis tick: "$2,700". */
function formatDollars(cents: number): string {
  return formatAud(Math.round(cents / 100) * 100).replace(/\.00$/, "");
}

/** "100%", "80%", "40%" for a confidence between 0 and 1. */
function formatConfidence(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

/** "Free", "$59.00" or "unknown" for a delivery cost. */
function formatDelivery(shippingCents: number | null): string {
  if (shippingCents === null) return "unknown";
  return shippingCents === 0 ? "Free" : formatAud(shippingCents);
}

function toVariantView(variant: QuoteReport["variant"]): VariantView {
  return {
    slug: variant.slug,
    displayName: variant.displayName,
    mpn: variant.mpn,
    gtin: variant.gtin,
    rrp: formatAud(variant.rrpCents),
    rrpCents: variant.rrpCents,
  };
}

/** Retailer names for one tracked variant, keyed by slug. */
function trackedRetailerNames(variantSlug: string): Map<string, string> {
  const variant = trackedVariants.find((candidate) => candidate.slug === variantSlug);
  return new Map((variant?.pages ?? []).map((page) => [page.retailerSlug, page.retailerName]));
}

function toOutcomeView(outcome: QuoteOutcome, rrpCents: number): QuoteOutcomeView {
  const base = {
    retailerSlug: outcome.retailerSlug,
    retailerName: outcome.retailerName,
    url: outcome.url,
  };
  switch (outcome.status) {
    case "ok": {
      const { quote } = outcome;
      return {
        ...base,
        status: "ok",
        title: quote.title,
        price: formatAud(quote.priceCents),
        priceCents: quote.priceCents,
        currency: quote.currency,
        was: quote.strikethroughCents === null ? null : formatAud(quote.strikethroughCents),
        wasCents: quote.strikethroughCents,
        shippingCents: quote.shippingCents,
        delivery: formatDelivery(quote.shippingCents),
        isCheapest: outcome.isCheapest,
        // A candidate is not a price, so it is not compared with one.
        vsCheapest: outcome.needsReview
          ? "candidate"
          : formatVsCheapest(outcome.deltaFromCheapestCents),
        deltaFromCheapestCents: outcome.deltaFromCheapestCents,
        vsRrp: formatVsRrp(outcome.deltaFromRrpCents, rrpCents),
        deltaFromRrpCents: outcome.deltaFromRrpCents,
        availability: quote.availability,
        stock: stockLabels[quote.availability],
        identifierMatch: outcome.identifierMatch,
        identifierLabel: identifierLabels[outcome.identifierMatch],
        gtin: quote.identifiers.gtin,
        mpn: quote.identifiers.mpn,
        retailerSku: quote.identifiers.retailerSku,
        method: quote.method,
        confidence: quote.confidence,
        confidenceLabel: formatConfidence(quote.confidence),
        readByModel: outcome.readByModel,
        needsReview: outcome.needsReview,
        filledBySearch: outcome.filledBySearch,
        gapReason: outcome.gapReason,
        evidence: quote.evidence,
        fetchedAt: quote.fetchedAt.toISOString(),
        raw: quote.raw,
      };
    }
    case "failed":
      return { ...base, status: "failed", kind: outcome.kind, message: outcome.message };
    case "skipped":
      return { ...base, status: "skipped", reason: outcome.reason };
  }
}

function retailers(count: number): string {
  return `${count} ${count === 1 ? "retailer" : "retailers"}`;
}

function gapFillNoteOf(gapFill: QuoteReport["gapFill"]): string | null {
  switch (gapFill.status) {
    case "not_needed":
      return null;
    case "no_key":
      return `${retailers(gapFill.gaps)} without a price. Store SERPAPI_API_KEY with scripts/keys.sh to fill the gap from Google Shopping.`;
    case "ok":
      return `Google Shopping filled ${gapFill.filled} of ${retailers(gapFill.gaps)} without a page price.`;
    case "failed":
      return `${retailers(gapFill.gaps)} without a price, and the Google Shopping search failed (${gapFill.kind}): ${gapFill.message}`;
  }
}

export function toQuoteView(report: QuoteReport): QuoteViewOk {
  const outcomes = report.outcomes.map((outcome) =>
    toOutcomeView(outcome, report.variant.rrpCents),
  );
  const cheapestOutcome =
    report.cheapest === null
      ? null
      : report.outcomes.find(
          (outcome) =>
            outcome.status === "ok" && outcome.retailerSlug === report.cheapest?.retailerSlug,
        );
  return {
    ok: true,
    variant: toVariantView(report.variant),
    fetchedAt: report.fetchedAt.toISOString(),
    fetchedAtLabel: formatFetchedAt(report.fetchedAt),
    answered: report.outcomes.filter((outcome) => outcome.status === "ok" && !outcome.needsReview)
      .length,
    total: report.outcomes.length,
    cheapest:
      report.cheapest === null
        ? null
        : {
            retailerSlug: report.cheapest.retailerSlug,
            retailerName: cheapestOutcome?.retailerName ?? report.cheapest.retailerSlug,
            price: formatAud(report.cheapest.priceCents),
            priceCents: report.cheapest.priceCents,
          },
    gapFillNote: gapFillNoteOf(report.gapFill),
    outcomes,
  };
}

// ---------- Google Shopping search ----------

export interface SearchQuoteView {
  /** Unique within one report; the seller slug is not, a seller can list twice. */
  key: string;
  retailerSlug: string;
  sellerName: string;
  trackedRetailerSlug: string | null;
  /** "tracked: JB Hi-Fi" or "new seller". */
  trackedLabel: string;
  title: string | null;
  price: string;
  priceCents: number;
  currency: string;
  was: string | null;
  wasCents: number | null;
  shippingCents: number | null;
  /** "Free", "$59.00" or "unknown". */
  delivery: string;
  /** Price plus delivery, or null when delivery is unknown. */
  totalCents: number | null;
  /** "$2,854.00" or "unknown". */
  total: string;
  isCheapest: boolean;
  /** Below the review threshold: a candidate, never highlighted. */
  needsReview: boolean;
  vsCheapest: string;
  deltaFromCheapestCents: number;
  vsRrp: string;
  deltaFromRrpCents: number;
  condition: Condition;
  conditionLabel: string;
  identifierMatch: IdentifierMatch;
  identifierLabel: string;
  gtin: string | null;
  mpn: string | null;
  retailerSku: string | null;
  confidence: number;
  confidenceLabel: string;
  evidence: string | null;
  /** The seller's own page. */
  url: string;
  /** The aggregator's product page, when it gave one. */
  productUrl: string | null;
  raw: unknown;
}

export type SearchOutcomeView =
  | {
      status: "ok";
      sellers: number;
      cheapest: {
        retailerSlug: string;
        sellerName: string;
        price: string;
        priceCents: number;
      } | null;
      /** Cheapest to dearest, as the service orders them. */
      quotes: SearchQuoteView[];
    }
  | { status: "failed"; kind: FailureKind; message: string };

export interface SearchView {
  ok: true;
  variant: VariantView;
  fetchedAt: string;
  fetchedAtLabel: string;
  method: string;
  query: string;
  outcome: SearchOutcomeView;
}

export type SearchViewResult = SearchView | ViewError;

function toSearchQuoteView(
  entry: SearchQuote,
  index: number,
  rrpCents: number,
  retailerNames: Map<string, string>,
): SearchQuoteView {
  const { quote } = entry;
  const sellerName = quote.retailerName ?? quote.retailerSlug;
  const trackedName =
    entry.trackedRetailerSlug === null
      ? null
      : (retailerNames.get(entry.trackedRetailerSlug) ?? entry.trackedRetailerSlug);
  const totalCents = quote.shippingCents === null ? null : quote.priceCents + quote.shippingCents;
  return {
    key: `${quote.retailerSlug}-${index}`,
    retailerSlug: quote.retailerSlug,
    sellerName,
    trackedRetailerSlug: entry.trackedRetailerSlug,
    trackedLabel: trackedName === null ? "new seller" : `tracked: ${trackedName}`,
    title: quote.title,
    price: formatAud(quote.priceCents),
    priceCents: quote.priceCents,
    currency: quote.currency,
    was: quote.strikethroughCents === null ? null : formatAud(quote.strikethroughCents),
    wasCents: quote.strikethroughCents,
    shippingCents: quote.shippingCents,
    delivery: formatDelivery(quote.shippingCents),
    totalCents,
    total: totalCents === null ? "unknown" : formatAud(totalCents),
    isCheapest: entry.isCheapest,
    needsReview: entry.needsReview,
    vsCheapest: formatVsCheapest(entry.deltaFromCheapestCents),
    deltaFromCheapestCents: entry.deltaFromCheapestCents,
    vsRrp: formatVsRrp(entry.deltaFromRrpCents, rrpCents),
    deltaFromRrpCents: entry.deltaFromRrpCents,
    condition: quote.condition,
    conditionLabel: conditionLabels[quote.condition],
    identifierMatch: entry.identifierMatch,
    identifierLabel: identifierLabels[entry.identifierMatch],
    gtin: quote.identifiers.gtin,
    mpn: quote.identifiers.mpn,
    retailerSku: quote.identifiers.retailerSku,
    confidence: quote.confidence,
    confidenceLabel: formatConfidence(quote.confidence),
    evidence: quote.evidence,
    url: quote.url,
    productUrl: quote.provenance.via,
    raw: quote.raw,
  };
}

export function toSearchView(report: SearchReport): SearchView {
  const retailerNames = trackedRetailerNames(report.variant.slug);
  let outcome: SearchOutcomeView;
  if (report.outcome.status === "failed") {
    outcome = {
      status: "failed",
      kind: report.outcome.kind,
      message: report.outcome.message,
    };
  } else {
    const quotes = report.outcome.quotes.map((entry, index) =>
      toSearchQuoteView(entry, index, report.variant.rrpCents, retailerNames),
    );
    const cheapestQuote = quotes.find((quote) => quote.isCheapest) ?? null;
    const { cheapest } = report.outcome;
    outcome = {
      status: "ok",
      sellers: quotes.length,
      cheapest:
        cheapest === null
          ? null
          : {
              retailerSlug: cheapest.retailerSlug,
              sellerName: cheapestQuote?.sellerName ?? cheapest.retailerSlug,
              price: formatAud(cheapest.priceCents),
              priceCents: cheapest.priceCents,
            },
      quotes,
    };
  }
  return {
    ok: true,
    variant: toVariantView(report.variant),
    fetchedAt: report.fetchedAt.toISOString(),
    fetchedAtLabel: formatFetchedAt(report.fetchedAt),
    method: report.method,
    query: report.query,
    outcome,
  };
}

// ---------- Wayback Machine history ----------

export interface HistoryPointView {
  /** ISO date in Sydney, "2026-05-14". */
  date: string;
  /** "14 May 2026". */
  label: string;
  observedAt: string;
  price: string;
  priceCents: number;
  was: string | null;
  wasCents: number | null;
  condition: Condition;
  conditionLabel: string;
  snapshotUrl: string;
}

interface HistoryPageViewBase {
  retailerSlug: string;
  retailerName: string;
  url: string;
}

export interface HistorySkippedSnapshotView {
  /** "14 May 2026", the capture date in Sydney. */
  dateLabel: string;
  snapshotUrl: string;
  kind: FailureKind;
  message: string;
}

export interface HistoryPageViewOk extends HistoryPageViewBase {
  status: "ok";
  /** Oldest first. Empty when the archive holds no readable snapshot. */
  points: HistoryPointView[];
  /** Captures the archive listed in the window. Zero means never captured. */
  snapshotsFound: number;
  /** Captures that did not become points, with the reason each. */
  skipped: HistorySkippedSnapshotView[];
}

export interface HistoryPageViewFailed extends HistoryPageViewBase {
  status: "failed";
  kind: FailureKind;
  message: string;
}

export type HistoryPageView = HistoryPageViewOk | HistoryPageViewFailed;

export interface HistorySeriesPointView {
  /** ISO date, the x coordinate before scaling. */
  x: string;
  /** Integer cents, the y coordinate before scaling. */
  y: number;
  /** Tooltip: "JB Hi-Fi, 14 May 2026, $3,295.00". */
  title: string;
}

export interface HistorySeriesView {
  retailerSlug: string;
  retailerName: string;
  /** Index into the panel's palette. */
  colourIndex: number;
  points: HistorySeriesPointView[];
}

export interface HistoryChartView {
  /** Only ok pages with at least one point. */
  series: HistorySeriesView[];
  /** Cents. yMax > yMin always. */
  yMin: number;
  yMax: number;
  /** Four ticks from yMin to yMax, labelled in whole dollars. */
  yTicks: { y: number; label: string }[];
  /** ISO dates. xMax > xMin always. */
  xMin: string;
  xMax: string;
  xMinLabel: string;
  xMaxLabel: string;
  /** One sentence per series for the chart's aria-label. */
  ariaLabel: string;
}

export interface HistoryView {
  ok: true;
  variant: VariantView;
  fetchedAt: string;
  fetchedAtLabel: string;
  from: string;
  fromLabel: string;
  to: string;
  toLabel: string;
  pages: HistoryPageView[];
  lowest: {
    retailerSlug: string;
    retailerName: string;
    price: string;
    priceCents: number;
    date: string;
    label: string;
  } | null;
  /** Null when no page returned a point. */
  chart: HistoryChartView | null;
}

export type HistoryViewResult = HistoryView | ViewError;

/** Cents per axis step: $100. */
const Y_STEP = 10_000;
const Y_TICKS = 4;

function toHistoryPointView(point: HistoryPoint): HistoryPointView {
  const date = isoDateInSydney(point.observedAt);
  return {
    date,
    label: formatIsoDate(date),
    observedAt: point.observedAt.toISOString(),
    price: formatAud(point.priceCents),
    priceCents: point.priceCents,
    was: point.strikethroughCents === null ? null : formatAud(point.strikethroughCents),
    wasCents: point.strikethroughCents,
    condition: point.condition,
    conditionLabel: conditionLabels[point.condition],
    snapshotUrl: point.snapshotUrl,
  };
}

function toSkippedSnapshotView(snapshot: HistorySkippedSnapshot): HistorySkippedSnapshotView {
  return {
    dateLabel: formatIsoDate(isoDateInSydney(snapshot.observedAt)),
    snapshotUrl: snapshot.snapshotUrl,
    kind: snapshot.kind,
    message: snapshot.message,
  };
}

function toHistoryPageView(page: HistoryPage): HistoryPageView {
  const base = { retailerSlug: page.retailerSlug, retailerName: page.retailerName, url: page.url };
  if (page.status === "failed") {
    return { ...base, status: "failed", kind: page.kind, message: page.message };
  }
  return {
    ...base,
    status: "ok",
    points: page.points.map(toHistoryPointView),
    snapshotsFound: page.snapshotsFound,
    skipped: page.skipped.map(toSkippedSnapshotView),
  };
}

/**
 * Axis bounds on $100 steps with a half-step of padding, widened so the
 * range splits evenly into Y_TICKS - 1 steps and is never zero.
 */
function yBounds(values: number[]): { yMin: number; yMax: number } {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const yMin = Math.max(0, Math.floor((lo - Y_STEP / 2) / Y_STEP) * Y_STEP);
  let yMax = Math.ceil((hi + Y_STEP / 2) / Y_STEP) * Y_STEP;
  const span = Y_STEP * (Y_TICKS - 1);
  while ((yMax - yMin) % span !== 0) yMax += Y_STEP;
  return { yMin, yMax };
}

function toChartView(pages: HistoryPageView[]): HistoryChartView | null {
  const series: HistorySeriesView[] = pages
    .filter((page): page is HistoryPageViewOk => page.status === "ok" && page.points.length > 0)
    .map((page, index) => ({
      retailerSlug: page.retailerSlug,
      retailerName: page.retailerName,
      colourIndex: index,
      points: page.points.map((point) => ({
        x: point.date,
        y: point.priceCents,
        title: `${page.retailerName}, ${point.label}, ${point.price}`,
      })),
    }));
  if (series.length === 0) return null;

  const points = series.flatMap((entry) => entry.points);
  const { yMin, yMax } = yBounds(points.map((point) => point.y));
  const yTicks = Array.from({ length: Y_TICKS }, (_, index) => {
    const y = yMin + ((yMax - yMin) * index) / (Y_TICKS - 1);
    return { y, label: formatDollars(y) };
  });

  const dates = points.map((point) => point.x).sort();
  let xMin = dates[0];
  let xMax = dates[dates.length - 1];
  if (xMin === xMax) {
    xMin = shiftIsoDate(xMin, -1);
    xMax = shiftIsoDate(xMax, 1);
  }

  const ariaLabel = series
    .map((entry) => {
      const prices = entry.points.map((point) => point.y);
      const first = entry.points[0];
      const last = entry.points[entry.points.length - 1];
      return `${entry.retailerName}: ${entry.points.length} archived ${
        entry.points.length === 1 ? "price" : "prices"
      } from ${formatIsoDate(first.x)} to ${formatIsoDate(last.x)}, lowest ${formatAud(
        Math.min(...prices),
      )}`;
    })
    .join(". ");

  return {
    series,
    yMin,
    yMax,
    yTicks,
    xMin,
    xMax,
    xMinLabel: formatIsoDate(xMin),
    xMaxLabel: formatIsoDate(xMax),
    ariaLabel: `Price history chart. ${ariaLabel}.`,
  };
}

export function toHistoryView(report: HistoryReport): HistoryView {
  const pages = report.pages.map(toHistoryPageView);
  const from = isoDateInSydney(report.from);
  const to = isoDateInSydney(report.to);
  const lowestPage =
    report.lowest === null
      ? null
      : (report.pages.find((page) => page.retailerSlug === report.lowest?.retailerSlug) ?? null);
  const lowestDate = report.lowest === null ? null : isoDateInSydney(report.lowest.observedAt);
  return {
    ok: true,
    variant: toVariantView(report.variant),
    fetchedAt: report.fetchedAt.toISOString(),
    fetchedAtLabel: formatFetchedAt(report.fetchedAt),
    from,
    fromLabel: formatIsoDate(from),
    to,
    toLabel: formatIsoDate(to),
    pages,
    lowest:
      report.lowest === null || lowestDate === null
        ? null
        : {
            retailerSlug: report.lowest.retailerSlug,
            retailerName: lowestPage?.retailerName ?? report.lowest.retailerSlug,
            price: formatAud(report.lowest.priceCents),
            priceCents: report.lowest.priceCents,
            date: lowestDate,
            label: formatIsoDate(lowestDate),
          },
    chart: toChartView(pages),
  };
}

// ---------- Extract: one page of any store, read by the model (ADR-0013) ----------

export interface ExtractQuoteView {
  retailerSlug: string;
  title: string | null;
  price: string;
  priceCents: number;
  currency: string;
  was: string | null;
  wasCents: number | null;
  shippingCents: number | null;
  /** "Free", "$59.00" or "unknown". */
  delivery: string;
  availability: Availability;
  stock: string;
  condition: Condition;
  conditionLabel: string;
  identifierMatch: IdentifierMatch;
  identifierLabel: string;
  gtin: string | null;
  mpn: string | null;
  retailerSku: string | null;
  confidence: number;
  /** "100%", "80%", "40%". */
  confidenceLabel: string;
  /** Why the confidence is what it is, one line per rule that fired. */
  reasons: string[];
  /** The text fragment the model read the price from. */
  evidence: string | null;
  /** Below the review threshold: a candidate, never a price. */
  needsReview: boolean;
  matchedVariantSlug: string | null;
  /** "matches tracked variant: <name>" or "no tracked variant matched". */
  matchLabel: string;
  url: string;
  fetchedAt: string;
  raw: unknown;
}

export type ExtractOutcomeView =
  | { status: "ok"; quote: ExtractQuoteView }
  | { status: "failed"; kind: FailureKind; message: string };

export interface ExtractView {
  ok: true;
  url: string;
  fetchedAt: string;
  fetchedAtLabel: string;
  method: string;
  outcome: ExtractOutcomeView;
}

export type ExtractViewResult = ExtractView | ViewError;

/** Display name of a tracked variant, or its slug when the slug is not tracked. */
function trackedVariantName(slug: string): string {
  return trackedVariants.find((candidate) => candidate.slug === slug)?.displayName ?? slug;
}

export function toExtractView(report: ExtractReport): ExtractView {
  let outcome: ExtractOutcomeView;
  if (report.outcome.status === "failed") {
    outcome = { status: "failed", kind: report.outcome.kind, message: report.outcome.message };
  } else {
    const { quote, needsReview, reasons, matchedVariantSlug, identifierMatch } = report.outcome;
    outcome = {
      status: "ok",
      quote: {
        retailerSlug: quote.retailerSlug,
        title: quote.title,
        price: formatAud(quote.priceCents),
        priceCents: quote.priceCents,
        currency: quote.currency,
        was: quote.strikethroughCents === null ? null : formatAud(quote.strikethroughCents),
        wasCents: quote.strikethroughCents,
        shippingCents: quote.shippingCents,
        delivery: formatDelivery(quote.shippingCents),
        availability: quote.availability,
        stock: stockLabels[quote.availability],
        condition: quote.condition,
        conditionLabel: conditionLabels[quote.condition],
        identifierMatch,
        identifierLabel: identifierLabels[identifierMatch],
        gtin: quote.identifiers.gtin,
        mpn: quote.identifiers.mpn,
        retailerSku: quote.identifiers.retailerSku,
        confidence: quote.confidence,
        confidenceLabel: formatConfidence(quote.confidence),
        reasons,
        evidence: quote.evidence,
        needsReview,
        matchedVariantSlug,
        matchLabel:
          matchedVariantSlug === null
            ? "no tracked variant matched"
            : `matches tracked variant: ${trackedVariantName(matchedVariantSlug)}`,
        url: quote.url,
        fetchedAt: quote.fetchedAt.toISOString(),
        raw: quote.raw,
      },
    };
  }
  return {
    ok: true,
    url: report.url,
    fetchedAt: report.fetchedAt.toISOString(),
    fetchedAtLabel: formatFetchedAt(report.fetchedAt),
    method: report.method,
    outcome,
  };
}
