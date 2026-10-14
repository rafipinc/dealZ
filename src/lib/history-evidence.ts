// Evidence rules for model-found price history (ADR-0020). A model with web
// search returns claims: a price, a page, a quoted fragment. Nothing here
// trusts the model. The page is fetched elsewhere; this module says whether
// the fragment is on the page, dates the point from the URL or the page's own
// markup, and assigns confidence by fixed rules. Pure string work, no I/O.

export type FragmentMatch = "strong" | "weak" | "absent";

export interface ClaimIdentifiers {
  modelCode: string | null;
  gtin: string | null;
}

export interface HistoryClaim {
  priceCents: number;
  sourceUrl: string;
  quote: string;
}

export type FetchedPage =
  { status: "fetched"; html: string; text: string } | { status: "unreachable"; kind: string };

export type ClaimVerdict = "verified" | "candidate" | "rejected" | "unverified";

export interface ClaimAssessment {
  verdict: ClaimVerdict;
  confidence: number;
  /** ISO date the point is charted at; null when the page carries no date. */
  observedDate: string | null;
  fragment: FragmentMatch | null;
  dateSource: "url" | "page" | null;
  reasons: string[];
}

export interface AssessClaimInput {
  claim: HistoryClaim;
  identifiers: ClaimIdentifiers;
  page: FetchedPage;
}

/** A point as the model stated it. `claimedDate` is for display only; the chart never uses it. */
export interface ModelClaim {
  retailer: string;
  priceCents: number;
  sourceUrl: string;
  quote: string;
  claimedDate: string | null;
}

/**
 * The confidence each outcome earns, in one place. A verified point is at or
 * above the review threshold (0.7, `REVIEW_THRESHOLD` in src/sources/types.ts)
 * and every other outcome is below it, so only verified points chart solid.
 */
export const HISTORY_EVIDENCE_CONFIDENCE = {
  /** Fragment found verbatim; page or URL dated. */
  verified: 0.8,
  /** Price and identifier near each other, fragment not verbatim; dated. */
  candidateDated: 0.6,
  /** Fragment found, strong or weak, but no date anywhere. */
  candidateUndated: 0.5,
  /** The page could not be fetched, so nothing was checked. */
  unverified: 0.4,
  /** The page was read and the fragment is not on it. */
  rejected: 0.3,
} as const;

/** A quote shorter than this can match by accident, so it never counts as strong. */
export const MIN_STRONG_QUOTE_LENGTH = 8;

/** How far apart, in characters, a price and an identifier may sit for a weak match. */
export const WEAK_MATCH_WINDOW = 400;

// --- text -------------------------------------------------------------------

const INVISIBLE_RE = /[­​‌‍⁠﻿]/g;
const SINGLE_QUOTES_RE = /[‘’‚‛′]/g;
const DOUBLE_QUOTES_RE = /[“”„‟″]/g;

/**
 * One form for comparing page text with a quoted fragment: whitespace runs
 * become a single space, curly quotes and apostrophes become straight ones,
 * soft hyphens and zero-width characters go, ends are trimmed. Case is kept.
 */
export function normaliseText(text: string): string {
  return text
    .replace(INVISIBLE_RE, "")
    .replace(SINGLE_QUOTES_RE, "'")
    .replace(DOUBLE_QUOTES_RE, '"')
    .replace(/\s+/g, " ")
    .trim();
}

const LEADING_ELLIPSIS_RE = /^(?:\.{2,}|…)\s*/;
const TRAILING_ELLIPSIS_RE = /\s*(?:\.{2,}|…)$/;

/** The quote without the ellipsis a model adds when it clips a fragment. */
function stripEllipsis(quote: string): string {
  return quote.replace(LEADING_ELLIPSIS_RE, "").replace(TRAILING_ELLIPSIS_RE, "");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A pattern for the ways a page prints `priceCents`: "$2,795", "$2795",
 * "$2,795.00", "2795.00", with an optional space after the symbol as the
 * page-text helper emits when the symbol sits in its own tag. A bare "2795"
 * is not a price; it needs the symbol or the cents.
 */
function priceRegExp(priceCents: number): RegExp {
  const dollars = Math.floor(priceCents / 100);
  const cents = String(priceCents % 100).padStart(2, "0");
  const grouped = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const amount = grouped === String(dollars) ? grouped : `${grouped}|${dollars}`;
  const body =
    cents === "00"
      ? `\\$\\s?(?:${amount})(?:\\.00)?|(?:${amount})\\.00`
      : `(?:\\$\\s?)?(?:${amount})\\.${cents}`;
  return new RegExp(`(?<![\\d,.])(?:${body})(?![\\d]|\\.\\d)`, "g");
}

function indicesOf(haystack: string, needle: string): number[] {
  const indices: number[] = [];
  if (needle.length === 0) return indices;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    indices.push(at);
    at = haystack.indexOf(needle, at + needle.length);
  }
  return indices;
}

/** The forms an identifier may take on a page: as given, and a GTIN without its leading zeros. */
function identifierForms(identifiers: ClaimIdentifiers): string[] {
  const forms: string[] = [];
  if (identifiers.modelCode !== null && identifiers.modelCode.trim() !== "") {
    forms.push(identifiers.modelCode.trim().toLowerCase());
  }
  if (identifiers.gtin !== null && identifiers.gtin.trim() !== "") {
    const gtin = identifiers.gtin.trim();
    forms.push(gtin);
    const unpadded = gtin.replace(/^0+/, "");
    if (unpadded !== gtin && unpadded !== "") forms.push(unpadded);
  }
  return forms;
}

/**
 * Whether the model's quote is on the page. Strong: the quote, ellipsis
 * dropped, is a substring of the page, case-insensitively, and at least
 * MIN_STRONG_QUOTE_LENGTH long. Weak: the price and one identifier both
 * appear, their starts within WEAK_MATCH_WINDOW characters of each other.
 * Absent otherwise.
 */
export function findFragment(
  pageText: string,
  quote: string,
  identifiers: ClaimIdentifiers,
  priceCents: number,
): FragmentMatch {
  const page = normaliseText(pageText).toLowerCase();
  const needle = normaliseText(stripEllipsis(quote)).toLowerCase();
  // Strong needs the claimed price inside the fragment itself. A fragment that
  // is on the page but names no price (a product title, say) proves nothing
  // about the number, and the model must never be the one to state it.
  if (
    needle.length >= MIN_STRONG_QUOTE_LENGTH &&
    priceRegExp(priceCents).test(needle) &&
    page.includes(needle)
  ) {
    return "strong";
  }

  const priceAt = [...page.matchAll(priceRegExp(priceCents))].map((m) => m.index);
  if (priceAt.length === 0) return "absent";
  const identifierAt = identifierForms(identifiers).flatMap((form) => indicesOf(page, form));
  for (const p of priceAt) {
    for (const i of identifierAt) {
      if (Math.abs(p - i) <= WEAK_MATCH_WINDOW) return "weak";
    }
  }
  return "absent";
}

// --- dates ------------------------------------------------------------------

/** "2026-05-28" when year, month and day make a real calendar date; null otherwise. */
function isoDate(year: string, month: string, day: string): string | null {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1000 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return null;
  }
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const JBHIFI_CATALOGUE_RE = /\/(\d{4})\/(\d{2})\/(\d{2})-(\d{2})-[^/]+(?:\/|$)/;
const YMD_PATH_RE = /\/(\d{4})\/(\d{2})\/(\d{2})(?:\/|$)/;
const ISO_DATE_RE = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/;

/** The path and query of a URL, with or without a scheme. The host is never returned. */
function pathAndQuery(url: string): { path: string; query: string } | null {
  const trimmed = url.trim();
  if (trimmed === "") return null;
  const withScheme = SCHEME_RE.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    return { path: parsed.pathname, query: parsed.search };
  } catch {
    return null;
  }
}

/**
 * The date a URL states, as an ISO date, or null. In order: a JB Hi-Fi
 * catalogue path `/YYYY/MM/DD-MM-slug/`, where the DD-MM segment must agree
 * with the month folder; a `/YYYY/MM/DD/` path; an ISO date anywhere in the
 * path or query. The domain is never read.
 */
export function dateFromUrl(url: string): string | null {
  const parts = pathAndQuery(url);
  if (parts === null) return null;

  const catalogue = JBHIFI_CATALOGUE_RE.exec(parts.path);
  if (catalogue !== null) {
    const [, year, month, day, dayMonth] = catalogue;
    return dayMonth === month ? isoDate(year, month, day) : null;
  }

  const ymd = YMD_PATH_RE.exec(parts.path);
  if (ymd !== null) {
    const [, year, month, day] = ymd;
    return isoDate(year, month, day);
  }

  const iso = ISO_DATE_RE.exec(parts.path + parts.query);
  if (iso !== null) {
    const [, year, month, day] = iso;
    return isoDate(year, month, day);
  }
  return null;
}

const LD_JSON_SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const LD_JSON_TYPE_RE = /\btype\s*=\s*["']?\s*application\/ld\+json\s*["']?/i;
const DATE_PUBLISHED_RE = /"datePublished"\s*:\s*"([^"]*)"/;
const META_TAG_RE = /<meta\b[^>]*>/gi;
const TIME_TAG_RE = /<time\b[^>]*>/gi;
const ISO_DATE_PREFIX_RE = /^\s*(\d{4})-(\d{2})-(\d{2})/;

/** One attribute's value from a tag's text, whichever quote style it uses. */
function attribute(tag: string, name: string): string | null {
  const match = new RegExp(
    `\\b${escapeRegExp(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  ).exec(tag);
  if (match === null) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

/** The date part of an ISO date-time, validated; null for anything else. */
function datePart(value: string | null): string | null {
  if (value === null) return null;
  const match = ISO_DATE_PREFIX_RE.exec(value);
  if (match === null) return null;
  const [, year, month, day] = match;
  return isoDate(year, month, day);
}

function* publishedDateCandidates(html: string): Generator<string | null> {
  for (const match of html.matchAll(LD_JSON_SCRIPT_RE)) {
    const [, attributes, body] = match;
    if (!LD_JSON_TYPE_RE.test(attributes)) continue;
    const published = DATE_PUBLISHED_RE.exec(body);
    if (published !== null) yield published[1];
  }
  const metas = [...html.matchAll(META_TAG_RE)].map((m) => m[0]);
  for (const tag of metas) {
    if (attribute(tag, "property")?.toLowerCase() === "article:published_time") {
      yield attribute(tag, "content");
    }
  }
  for (const tag of metas) {
    if (attribute(tag, "itemprop")?.toLowerCase() === "datepublished") {
      yield attribute(tag, "content");
    }
  }
  for (const match of html.matchAll(TIME_TAG_RE)) {
    yield attribute(match[0], "datetime");
  }
}

/**
 * The page's own published date, as an ISO date, or null. Sources in order:
 * JSON-LD `datePublished`, `<meta property="article:published_time">`,
 * `<meta itemprop="datePublished">`, `<time datetime>`. The first candidate
 * that carries a valid date wins. Visible text is never scanned: a catalogue
 * page carries a "Started dd/mm/yyyy" label for every offer on it.
 */
export function dateFromHtml(html: string): string | null {
  for (const candidate of publishedDateCandidates(html)) {
    const date = datePart(candidate);
    if (date !== null) return date;
  }
  return null;
}

// --- assessment -------------------------------------------------------------

/**
 * One claim judged against the page it cites. Each rule has its own test.
 * The model's own date plays no part: the point is dated from the URL first,
 * then from the page's markup, or not at all.
 */
export function assessClaim(input: AssessClaimInput): ClaimAssessment {
  const { claim, identifiers, page } = input;
  if (page.status === "unreachable") {
    return {
      verdict: "unverified",
      confidence: HISTORY_EVIDENCE_CONFIDENCE.unverified,
      observedDate: null,
      fragment: null,
      dateSource: null,
      reasons: [`page unreachable: ${page.kind}`],
    };
  }

  const fragment = findFragment(page.text, claim.quote, identifiers, claim.priceCents);
  if (fragment === "absent") {
    return {
      verdict: "rejected",
      confidence: HISTORY_EVIDENCE_CONFIDENCE.rejected,
      observedDate: null,
      fragment,
      dateSource: null,
      reasons: ["quoted fragment not on page"],
    };
  }

  const fromUrl = dateFromUrl(claim.sourceUrl);
  const observedDate = fromUrl ?? dateFromHtml(page.html);
  const dateSource = fromUrl !== null ? "url" : observedDate !== null ? "page" : null;
  const reasons: string[] =
    fragment === "strong"
      ? ["quoted fragment found on page"]
      : ["price and identifier near each other, fragment not found verbatim"];

  if (observedDate === null) {
    return {
      verdict: "candidate",
      confidence: HISTORY_EVIDENCE_CONFIDENCE.candidateUndated,
      observedDate: null,
      fragment,
      dateSource: null,
      reasons: [...reasons, "page carries no date"],
    };
  }

  reasons.push(dateSource === "url" ? "dated from URL" : "dated from page");
  if (fragment === "strong") {
    return {
      verdict: "verified",
      confidence: HISTORY_EVIDENCE_CONFIDENCE.verified,
      observedDate,
      fragment,
      dateSource,
      reasons,
    };
  }
  return {
    verdict: "candidate",
    confidence: HISTORY_EVIDENCE_CONFIDENCE.candidateDated,
    observedDate,
    fragment,
    dateSource,
    reasons,
  };
}

// --- the model's answer -----------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Integer cents from a decimal amount, rounding half up on the third decimal.
 * Works on the decimal text so 1.005 gives 101 and not 100. Accepts a number
 * or a string with a symbol, commas and whitespace around the digits. Null
 * for anything that is not a non-negative decimal.
 */
function centsFromAmount(value: unknown): number | null {
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    text = String(value);
  } else if (typeof value === "string") {
    text = value.replace(/[^0-9.\-eE]/g, "");
  } else {
    return null;
  }
  const match = /^(\d*)(?:\.(\d*))?$/.exec(text);
  if (match === null) return null;
  const [, whole, fraction = ""] = match;
  if (whole === "" && fraction === "") return null;
  const dollars = whole === "" ? 0 : Number(whole);
  const padded = `${fraction}000`.slice(0, 3);
  const cents = Number(padded.slice(0, 2));
  const halfUp = Number(padded[2]) >= 5 ? 1 : 0;
  return dollars * 100 + cents + halfUp;
}

const FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/i;

/** The text from a `[` at `start` to the `]` that balances it, respecting strings; null when unbalanced. */
function balancedArray(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (char === "\\") i += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === "[" || char === "{") {
      depth += 1;
    } else if (char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Every slice of the text that might be the JSON array, most specific first. */
function* jsonCandidates(text: string): Generator<string> {
  const fenced = FENCE_RE.exec(text);
  if (fenced !== null) yield fenced[1];
  yield text;
  let start = text.indexOf("[");
  while (start !== -1) {
    const slice = balancedArray(text, start);
    if (slice !== null) yield slice;
    start = text.indexOf("[", start + 1);
  }
}

function parseArray(text: string): unknown[] | null {
  for (const candidate of jsonCandidates(text)) {
    try {
      const parsed: unknown = JSON.parse(candidate.trim());
      if (Array.isArray(parsed)) return parsed;
      if (isRecord(parsed)) {
        const inner = parsed.points ?? parsed.results ?? parsed.items;
        if (Array.isArray(inner)) return inner;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The model's answer as claims. The answer should be a JSON array of
 * `{date, retailer, price_aud, source_url, quote}` but may sit in a code
 * fence or prose. Rows without a URL or a numeric price are dropped. An
 * answer that holds no array yields an empty list; nothing throws.
 */
export function pointsFromModelText(text: string): ModelClaim[] {
  const rows = parseArray(text);
  if (rows === null) return [];
  const claims: ModelClaim[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const sourceUrl = stringOrEmpty(row.source_url);
    const priceCents = centsFromAmount(row.price_aud);
    if (sourceUrl === "" || priceCents === null) continue;
    const claimedDate = stringOrEmpty(row.date);
    claims.push({
      retailer: stringOrEmpty(row.retailer),
      priceCents,
      sourceUrl,
      quote: stringOrEmpty(row.quote),
      claimedDate: claimedDate === "" ? null : claimedDate,
    });
  }
  return claims;
}
