// Serialisable views of the quotes service reports for the lab page.
// Everything the client shows is pre-formatted here so the panels render
// strings and style sign. No Dates cross the boundary: timestamps are ISO
// strings and chart coordinates are ISO dates and integer cents.

import { SYDNEY } from "@/lib/day-ranges";
import { formatAud, formatVsCheapest, formatVsRrp } from "@/lib/money";
import { isHiddenByDefault } from "@/lib/relevance";
import type {
  IndexSearchReport,
  IndexStatus,
  IndexedOffer,
  IndexedProduct,
  OfferVia,
  RefreshIndexReport,
} from "@/services/catalogue-index";
import type {
  DiscoverReport,
  InspectReport,
  MatchedBy,
  QueryKind,
  RankedCandidate,
  RelevanceTier,
  SerpApiBudget,
  StoreOutcome,
} from "@/services/discovery";
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

// ---------- Discovery: storefront search for a product to add (ADR-0016) ----------

export interface DiscoveryRowView {
  /** Unique within one report. */
  key: string;
  retailerSlug: string;
  retailerName: string;
  title: string;
  brand: string | null;
  storeType: string | null;
  /** "LG · VISUAL", one of them, or "" when the store said neither. */
  subtitle: string;
  imageUrl: string | null;
  /** "$3,266.00" or "no price". */
  price: string;
  priceCents: number | null;
  /** "$3,995.00" or null when the store shows none. */
  was: string | null;
  availability: Availability;
  stock: string;
  /** The code read from the title, or "not in title". */
  modelCode: string;
  /** True when the title carried a model code; false when modelCode is the placeholder. */
  mpnFromTitle: boolean;
  /** "not read yet" until the product JSON is inspected. */
  gtin: string;
  sku: string;
  trackedVariantSlug: string | null;
  matchedBy: MatchedBy | null;
  /** "held: <display name>" or "new". */
  heldLabel: string;
  /** "matched by URL", or null for a new product. */
  matchedLabel: string | null;
  tier: RelevanceTier;
  /** "match", "accessory", "partial", "unrelated". */
  tierLabel: string;
  /** "every word in the title", "missing: 65", "no query word in the title". */
  relevanceReason: string;
  /** Higher is better; the order within a tier. */
  relevanceScore: number;
  /** True for a partial or unrelated row, shown under "Other results". */
  hidden: boolean;
  /** Where the row came from: a storefront's own search, or a seller Google Shopping listed. */
  via: OfferVia;
  /** True when "Read identifiers" can read this row's product JSON: a storefront row only. */
  inspectable: boolean;
  url: string;
  raw: unknown;
}

export interface DiscoveryStoreView {
  retailerSlug: string;
  retailerName: string;
  origin: string;
  status: "ok" | "failed";
  /** Candidates the store returned; 0 when it failed. */
  count: number;
  kind: FailureKind | null;
  message: string | null;
}

const NOT_READ_YET = "not read yet";
const NOT_IN_TITLE = "not in title";
const NOT_ON_PAGE = "not on page";

const matchedLabels: Record<MatchedBy, string> = {
  gtin: "matched by GTIN",
  mpn: "matched by model code",
  url: "matched by URL",
};

const tierLabels: Record<RelevanceTier, string> = {
  match: "match",
  accessory: "accessory",
  partial: "partial",
  unrelated: "unrelated",
};

function heldLabelOf(trackedVariantSlug: string | null): string {
  return trackedVariantSlug === null ? "new" : `held: ${trackedVariantName(trackedVariantSlug)}`;
}

function subtitleOf(brand: string | null, storeType: string | null): string {
  return [brand, storeType].filter((part) => part !== null && part !== "").join(" · ");
}

function toDiscoveryRowView(entry: RankedCandidate): DiscoveryRowView {
  const { candidate, via } = entry;
  return {
    key: `${via === "google_shopping" ? "google:" : ""}${entry.retailerSlug}-${entry.position}`,
    retailerSlug: entry.retailerSlug,
    retailerName: entry.retailerName,
    title: candidate.title,
    brand: candidate.brand,
    storeType: candidate.storeType,
    subtitle: subtitleOf(candidate.brand, candidate.storeType),
    imageUrl: candidate.imageUrl,
    price: candidate.priceCents === null ? "no price" : formatAud(candidate.priceCents),
    priceCents: candidate.priceCents,
    was: candidate.strikethroughCents === null ? null : formatAud(candidate.strikethroughCents),
    availability: candidate.availability,
    stock: stockLabels[candidate.availability],
    modelCode: candidate.identifiers.mpn ?? NOT_IN_TITLE,
    mpnFromTitle: candidate.identifiers.mpn !== null,
    gtin: NOT_READ_YET,
    sku: NOT_READ_YET,
    trackedVariantSlug: entry.trackedVariantSlug,
    matchedBy: entry.matchedBy,
    heldLabel: heldLabelOf(entry.trackedVariantSlug),
    matchedLabel: entry.matchedBy === null ? null : matchedLabels[entry.matchedBy],
    tier: entry.relevance.tier,
    tierLabel: tierLabels[entry.relevance.tier],
    relevanceReason: entry.relevance.reason,
    relevanceScore: entry.relevance.score,
    hidden: isHiddenByDefault(entry.relevance.tier),
    via,
    inspectable: via === "storefront",
    url: candidate.url,
    raw: candidate.raw,
  };
}

function toDiscoveryStoreView(store: StoreOutcome): DiscoveryStoreView {
  const base = {
    retailerSlug: store.retailerSlug,
    retailerName: store.retailerName,
    origin: store.origin,
  };
  if (store.status === "failed") {
    return { ...base, status: "failed", count: 0, kind: store.kind, message: store.message };
  }
  return { ...base, status: "ok", count: store.candidates.length, kind: null, message: null };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** What the product JSON said about one candidate, for the row's identifier cells. */
export interface InspectOutcomeViewOk {
  status: "ok";
  title: string | null;
  price: string;
  /** The retailer's SKU when it is the model code, else "not on page". */
  modelCode: string;
  /** True when the page carried a model code; false when modelCode is the placeholder. */
  modelCodeRead: boolean;
  /** 14 digits, or "not on page". */
  gtin: string;
  /** True when the page carried a GTIN; false when gtin is the placeholder. */
  gtinRead: boolean;
  sku: string;
  trackedVariantSlug: string | null;
  heldLabel: string;
  matchedLabel: string | null;
  raw: unknown;
}

export type InspectOutcomeView =
  InspectOutcomeViewOk | { status: "failed"; kind: FailureKind; message: string };

export interface InspectView {
  ok: true;
  retailerSlug: string;
  url: string;
  fetchedAt: string;
  fetchedAtLabel: string;
  outcome: InspectOutcomeView;
}

export type InspectViewResult = InspectView | ViewError;

export function toInspectView(report: InspectReport): InspectView {
  let outcome: InspectOutcomeView;
  if (report.outcome.status === "failed") {
    outcome = { status: "failed", kind: report.outcome.kind, message: report.outcome.message };
  } else {
    const { quote, trackedVariantSlug, matchedBy } = report.outcome;
    outcome = {
      status: "ok",
      title: quote.title,
      price: formatAud(quote.priceCents),
      modelCode: quote.identifiers.mpn ?? NOT_ON_PAGE,
      modelCodeRead: quote.identifiers.mpn !== null,
      gtin: quote.identifiers.gtin ?? NOT_ON_PAGE,
      gtinRead: quote.identifiers.gtin !== null,
      sku: quote.identifiers.retailerSku ?? NOT_ON_PAGE,
      trackedVariantSlug,
      heldLabel: heldLabelOf(trackedVariantSlug),
      matchedLabel: matchedBy === null ? null : matchedLabels[matchedBy],
      raw: quote.raw,
    };
  }
  return {
    ok: true,
    retailerSlug: report.retailerSlug,
    url: report.url,
    fetchedAt: report.fetchedAt.toISOString(),
    fetchedAtLabel: formatFetchedAt(report.fetchedAt),
    outcome,
  };
}

// ---------- Catalogue index: the dropdown, the status line and the refresh (ADR-0017) ----------

/** One product in the as-you-type dropdown, every store's offer folded into one line. */
export interface SuggestRowView {
  /** Unique within one answer. */
  key: string;
  title: string;
  /** "" when the store named none. */
  brand: string;
  /** "" when no row carried one. */
  modelCode: string;
  /** "Samsung · QA65QN80HAWXXY", one of them, or "". */
  subtitle: string;
  storeCount: number;
  /** "1 store", "2 stores". */
  storesLabel: string;
  /** "from $1,819.00 at Powerland" across stores, "$1,819.00 at Powerland" for one, or "no price". */
  priceLine: string;
  imageUrl: string | null;
  trackedVariantSlug: string | null;
  /** "held: <display name>" or "new". */
  heldLabel: string;
  /** The cheapest offer's product page, else the first offer's. */
  url: string;
}

export interface SuggestView {
  ok: true;
  query: string;
  queryKind: QueryKind;
  /** Products matched before the limit. */
  total: number;
  rows: SuggestRowView[];
  /** True when the list should end with a row offering to ask the stores live. */
  offerLiveSearch: boolean;
}

export type SuggestViewResult = SuggestView | ViewError;

function priceLineOf(product: IndexedProduct): string {
  if (product.cheapest === null) return "no price";
  const offer = product.offers.find((o) => o.retailerSlug === product.cheapest?.retailerSlug);
  const at = `${formatAud(product.cheapest.priceCents)} at ${offer?.retailerName ?? product.cheapest.retailerSlug}`;
  return product.offers.length > 1 ? `from ${at}` : at;
}

function toSuggestRowView(product: IndexedProduct): SuggestRowView {
  const cheapest = product.offers.find((o) => o.retailerSlug === product.cheapest?.retailerSlug);
  return {
    key: product.key,
    title: product.title,
    brand: product.brand ?? "",
    modelCode: product.mpn ?? "",
    subtitle: subtitleOf(product.brand, product.mpn),
    storeCount: product.offers.length,
    storesLabel: plural(product.offers.length, "store", "stores"),
    priceLine: priceLineOf(product),
    imageUrl: product.imageUrl,
    trackedVariantSlug: product.trackedVariantSlug,
    heldLabel: heldLabelOf(product.trackedVariantSlug),
    url: cheapest?.canonicalUrl ?? product.offers[0]?.canonicalUrl ?? "",
  };
}

/** Below this many index products, with a query this long, the dropdown offers a live store search. */
const LIVE_SEARCH_BELOW_ROWS = 3;
const LIVE_SEARCH_MIN_LENGTH = 3;

export function toSuggestView(report: IndexSearchReport): SuggestView {
  const rows = report.products.map(toSuggestRowView);
  return {
    ok: true,
    query: report.query,
    queryKind: report.queryKind,
    total: report.total,
    rows,
    offerLiveSearch:
      rows.length < LIVE_SEARCH_BELOW_ROWS && report.query.length >= LIVE_SEARCH_MIN_LENGTH,
  };
}

/** The line under the search box. `ok` false when the index could not be read. */
export interface IndexStatusView {
  ok: boolean;
  /** "Index: 129 products from 1 store, Powerland refreshed 6 Oct 2026, 11:02 am". */
  line: string;
}

/** "6 Oct 2026, 11:02 am" in Sydney. */
function formatRefreshedAt(date: Date): string {
  return new Intl.DateTimeFormat("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: SYDNEY,
  }).format(date);
}

export function toIndexStatusView(status: IndexStatus): IndexStatusView {
  if (status.total === 0) {
    return { ok: true, line: "Index: empty. Refresh it to pull the seeded collections." };
  }
  // Stores the tracked tables name are listed with their last refresh; sellers learned from Google Shopping are counted.
  const known = status.stores.filter((store) => store.known);
  const sellers = status.stores.length - known.length;
  const from = [
    plural(known.length, "store", "stores"),
    sellers > 0 ? `${plural(sellers, "seller", "sellers")} via Google Shopping` : null,
  ]
    .filter((part) => part !== null)
    .join(" and ");
  const refreshed = known
    .map((store) => `${store.retailerName} refreshed ${formatRefreshedAt(store.lastSeenAt)}`)
    .join(", ");
  return {
    ok: true,
    line: `Index: ${plural(status.total, "product", "products")} from ${from}${refreshed === "" ? "" : `, ${refreshed}`}`,
  };
}

/** The status line when the index could not be read. `message` is already redacted. */
export function indexUnavailableView(message: string): IndexStatusView {
  return { ok: false, line: `Index unavailable: ${message}` };
}

export interface RefreshView {
  ok: true;
  refreshedAt: string;
  refreshedAtLabel: string;
  /** One per seeded collection: "Powerland televisions: 129 found, 129 written, 1 removed" or "Powerland televisions: failed (blocked): ...". */
  lines: string[];
  /** "2 requests, 2 recorded". */
  usageLine: string;
}

export type RefreshViewResult = RefreshView | ViewError;

export function toRefreshView(report: RefreshIndexReport): RefreshView {
  return {
    ok: true,
    refreshedAt: report.refreshedAt.toISOString(),
    refreshedAtLabel: formatRefreshedAt(report.refreshedAt),
    lines: report.collections.map((outcome) => {
      const name = `${outcome.retailerName} ${outcome.collection}`;
      return outcome.status === "ok"
        ? `${name}: ${outcome.found} found, ${outcome.written} written, ${outcome.removed} removed`
        : `${name}: failed (${outcome.kind}): ${outcome.message}`;
    }),
    usageLine: `${plural(report.usage.calls, "request", "requests")}, ${report.usage.recorded} recorded`,
  };
}

// ---------- SerpApi budget: the day's paid searches against the cap ----------

/** The line under the search box. `ok` false when the ledger could not be read. */
export interface SerpApiBudgetView {
  ok: boolean;
  /**
   * "SerpApi: 3 of 20 today" or "SerpApi: daily cap of 20 reached (20 today)",
   * with "(SERPAPI_DAILY_CAP ignored: not a number)" when the setting was malformed.
   * The day only; the plan's remaining searches would cost a metered call per page load.
   */
  line: string;
  /** False at the cap: the next search will not ask Google Shopping. */
  allowed: boolean;
}

/** The note when the cap came from the default because the setting was malformed; "" otherwise. */
function capIgnoredNoteOf(capSource: SerpApiBudget["capSource"]): string {
  return capSource === "invalid" ? " (SERPAPI_DAILY_CAP ignored: not a number)" : "";
}

export function toSerpApiBudgetView(budget: SerpApiBudget): SerpApiBudgetView {
  return {
    ok: true,
    line: budget.allowed
      ? `SerpApi: ${budget.usedToday} of ${budget.cap} today${capIgnoredNoteOf(budget.capSource)}`
      : `SerpApi: daily cap of ${budget.cap} reached (${budget.usedToday} today)${capIgnoredNoteOf(budget.capSource)}`,
    allowed: budget.allowed,
  };
}

/** The line when the ledger could not be read. `message` is already redacted. Not allowed: nothing is spent blind. */
export function serpApiBudgetUnavailableView(message: string): SerpApiBudgetView {
  return { ok: false, line: `SerpApi budget unavailable: ${message}`, allowed: false };
}

// ---------- Discover: the index first, then the stores and Google Shopping (ADR-0017 miss path) ----------

export interface DiscoverOfferView {
  /** Unique within one product. */
  key: string;
  retailerSlug: string;
  retailerName: string;
  /** "$2,795.00" or "no price". */
  price: string;
  priceCents: number | null;
  /** "$3,295.00" or null when the seller shows none. */
  was: string | null;
  /** "In stock", "Out of stock" or "Unknown". */
  stock: string;
  url: string;
  via: OfferVia;
  /** "Google Shopping" for a seller Google listed, else the store's own name. */
  sourceLabel: string;
  /** "6 Oct 2026, 11:02 am" in Sydney: when the index last saw this offer. */
  lastSeenLabel: string;
  isCheapest: boolean;
}

export interface DiscoverProductView {
  /** Unique within one report. */
  key: string;
  title: string;
  /** "" when no row named one. */
  brand: string;
  /** "" when no row carried one. */
  modelCode: string;
  /** 14 digits, or "" when no row carried one. */
  gtin: string;
  /** "Samsung · QA65QN80HAWXXY", one of them, or "". */
  subtitle: string;
  imageUrl: string | null;
  /** "from $1,819.00 at Powerland" across sellers, "$1,819.00 at Powerland" for one, or "no price". */
  fromLine: string;
  sellerCount: number;
  /** "1 seller", "2 sellers". */
  sellersLabel: string;
  trackedVariantSlug: string | null;
  /** "held: <display name>" or "new". */
  heldLabel: string;
  tier: RelevanceTier;
  tierLabel: string;
  relevanceReason: string;
  /** True for a partial product, shown under "Partial matches". */
  hidden: boolean;
  /** Cheapest first; sellers without a price last. */
  offers: DiscoverOfferView[];
}

export interface DiscoverView {
  ok: true;
  query: string;
  queryKind: QueryKind;
  /** "a GTIN" or "a title". */
  queryKindLabel: string;
  gtin: string | null;
  fetchedAt: string;
  fetchedAtLabel: string;
  source: DiscoverReport["source"];
  /** "From the index: 14 offers across 6 products." or "Searched Google Shopping and 2 stores: 14 offers across 6 products; JB Hi-Fi failed: blocked." */
  countLine: string;
  /** "SerpApi today: 3 of 20." Null when the budget was not read: the index answered alone, or the ledger was down. */
  budgetLine: string | null;
  /** Why Google Shopping did not answer, or null when it did or the index answered alone. */
  googleLine: string | null;
  /** The cards: match and accessory products, best first. */
  products: DiscoverProductView[];
  /** Partial products, under a details. */
  hiddenProducts: DiscoverProductView[];
  /** The storefronts asked; empty when the index answered alone. */
  stores: DiscoveryStoreView[];
  /** Every row the sources returned, best first, for the flat table; empty when the index answered alone. */
  rows: DiscoveryRowView[];
  /** "3 requests, 3 recorded; 12 of 12 rows remembered", or null when nothing was asked. */
  usageLine: string | null;
}

export type DiscoverViewResult = DiscoverView | ViewError;

const GOOGLE_SHOPPING_LABEL = "Google Shopping";

function toDiscoverOfferView(
  offer: IndexedOffer,
  product: IndexedProduct,
  index: number,
): DiscoverOfferView {
  const stock =
    offer.available === null
      ? stockLabels.unknown
      : offer.available
        ? stockLabels.in_stock
        : stockLabels.out_of_stock;
  return {
    key: `${offer.retailerSlug}-${index}`,
    retailerSlug: offer.retailerSlug,
    retailerName: offer.retailerName,
    price: offer.priceCents === null ? "no price" : formatAud(offer.priceCents),
    priceCents: offer.priceCents,
    was: offer.compareAtCents === null ? null : formatAud(offer.compareAtCents),
    stock,
    url: offer.canonicalUrl,
    via: offer.via,
    sourceLabel: offer.via === "google_shopping" ? GOOGLE_SHOPPING_LABEL : offer.retailerName,
    lastSeenLabel: formatRefreshedAt(offer.lastSeenAt),
    isCheapest:
      product.cheapest !== null &&
      offer.priceCents !== null &&
      product.cheapest.retailerSlug === offer.retailerSlug &&
      product.cheapest.priceCents === offer.priceCents,
  };
}

function toDiscoverProductView(product: IndexedProduct): DiscoverProductView {
  return {
    key: product.key,
    title: product.title,
    brand: product.brand ?? "",
    modelCode: product.mpn ?? "",
    gtin: product.gtin ?? "",
    subtitle: subtitleOf(product.brand, product.mpn),
    imageUrl: product.imageUrl,
    fromLine: priceLineOf(product),
    sellerCount: product.offers.length,
    sellersLabel: plural(product.offers.length, "seller", "sellers"),
    trackedVariantSlug: product.trackedVariantSlug,
    heldLabel: heldLabelOf(product.trackedVariantSlug),
    tier: product.relevance.tier,
    tierLabel: tierLabels[product.relevance.tier],
    relevanceReason: product.relevance.reason,
    hidden: isHiddenByDefault(product.relevance.tier),
    offers: product.offers.map((offer, index) => toDiscoverOfferView(offer, product, index)),
  };
}

function discoverCountLineOf(report: DiscoverReport): string {
  const offers = report.products.reduce((sum, product) => sum + product.offers.length, 0);
  const counts = `${plural(offers, "offer", "offers")} across ${plural(report.products.length, "product", "products")}`;
  if (report.source === "index") return `From the index: ${counts}.`;
  const storefronts = report.storefronts ?? [];
  const stores = plural(storefronts.length, "store", "stores");
  const parts = [
    `Searched ${report.googleShopping.status === "ok" ? `${GOOGLE_SHOPPING_LABEL} and ${stores}` : stores}: ${counts}`,
  ];
  for (const store of storefronts) {
    if (store.status === "failed") parts.push(`${store.retailerName} failed: ${store.kind}`);
  }
  if (report.remembered < report.found) {
    parts.push(
      `only ${report.remembered} of ${report.found} rows could be remembered, so the index may not show them yet`,
    );
  }
  return `${parts.join("; ")}.`;
}

function googleLineOf(report: DiscoverReport): string | null {
  const google = report.googleShopping;
  switch (google.status) {
    case "ok":
      return null;
    case "failed":
      return `${GOOGLE_SHOPPING_LABEL} failed (${google.kind}): ${google.message}`;
    case "skipped":
      switch (google.reason) {
        case "index_sufficient":
          return null;
        case "cap_reached":
          // The cap was read, or Google could not have been judged against it.
          return `${GOOGLE_SHOPPING_LABEL} skipped: daily cap${report.budget === null ? "" : ` of ${report.budget.cap}`} reached.`;
        case "no_key":
          return `${GOOGLE_SHOPPING_LABEL} skipped: no SerpApi key. Store SERPAPI_API_KEY with scripts/keys.sh and restart the dev server.`;
        case "budget_unknown":
          return `${GOOGLE_SHOPPING_LABEL} skipped: the day's SerpApi budget could not be read from the usage ledger, so nothing was spent.`;
      }
  }
}

/** "SerpApi today: 3 of 20." with the ignored-setting note when it applies; null when the budget was not read. */
function budgetLineOf(budget: DiscoverReport["budget"]): string | null {
  if (budget === null) return null;
  return `SerpApi today: ${budget.usedToday} of ${budget.cap}${capIgnoredNoteOf(budget.capSource)}.`;
}

/** Every row the sources returned, as the service ranked them, keyed by the search so a new one remounts them. */
function discoverRowsOf(report: DiscoverReport): DiscoveryRowView[] {
  return report.candidates.map((entry) => {
    const row = toDiscoveryRowView(entry);
    return { ...row, key: `${report.fetchedAt.toISOString()}:${row.key}` };
  });
}

export function toDiscoverView(report: DiscoverReport): DiscoverView {
  const products = report.products.map(toDiscoverProductView);
  return {
    ok: true,
    query: report.query,
    queryKind: report.queryKind,
    queryKindLabel: report.queryKind === "gtin" ? "a GTIN" : "a title",
    gtin: report.gtin,
    fetchedAt: report.fetchedAt.toISOString(),
    fetchedAtLabel: formatFetchedAt(report.fetchedAt),
    source: report.source,
    countLine: discoverCountLineOf(report),
    budgetLine: budgetLineOf(report.budget),
    googleLine: googleLineOf(report),
    products: products.filter((product) => !product.hidden),
    hiddenProducts: products.filter((product) => product.hidden),
    stores: (report.storefronts ?? []).map(toDiscoveryStoreView),
    rows: discoverRowsOf(report),
    usageLine:
      report.source === "index"
        ? null
        : `${plural(report.usage.calls, "request", "requests")}, ${report.usage.recorded} recorded; ${report.remembered} of ${report.found} rows remembered`,
  };
}
