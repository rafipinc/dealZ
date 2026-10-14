// history-search: the model-assisted price history source (ADR-0020). A
// model with web search is asked for dated price points for one product in
// a window, fenced to an allow-list of domains. Everything it answers is a
// claim: a price, a page, a quoted fragment, and a date this source ignores.
// The cited page is fetched here, its visible text searched for the
// fragment, and the point dated from the URL or the page's own markup by the
// rules in lib/history-evidence. The model never states a price or a date
// that reaches a chart; the page does (ADR-0013, amended by ADR-0020 for
// this one case).
//
// openai.ts is the only file that knows the provider's API. This file knows
// the prompt, the allow-list, the caps, and how a claim becomes a quote.
//
// Politeness. Every claim page, whichever retailer it is on, passes through
// one module-level gate that admits CLAIM_PAGE_CONCURRENCY requests at a
// time, as wayback.ts does for the archive. The gate is process-wide on
// purpose and holds no business state. A page cited by two claims is
// fetched once per search.

import { isoDateIn, startOfDayIn, SYDNEY } from "../lib/day-ranges";
import {
  assessClaim,
  HISTORY_EVIDENCE_CONFIDENCE,
  pointsFromModelText,
  type ClaimAssessment,
  type ClaimVerdict,
  type FetchedPage,
  type FragmentMatch,
  type ModelClaim,
} from "../lib/history-evidence";
import { visibleText } from "../lib/page-text";
import { slugify } from "../lib/slug";
import { canonicaliseUrl } from "../lib/url";
import { fetchText } from "./http";
import { createLimiter } from "./limiter";
import { DEFAULT_HISTORY_MODEL, searchHistory, type OpenAiToolCall } from "./openai";
import { SourceError, type FetchLike, type Meter, type PriceQuote } from "./types";

export { DEFAULT_HISTORY_MODEL } from "./openai";

/** One domain the model may search, with why its pages may be read and shown. */
export interface AllowedDomain {
  domain: string;
  /** One line on the terms. The decision to read the domain is ADR-0020 item 4. */
  note: string;
}

/**
 * The domains the web search tool may open, and no others (ADR-0020 item 4).
 * A subdomain of a listed domain counts. staticice.com.au is absent on
 * purpose: its terms forbid redisplay of its data, so a point found there
 * could never be charted, whichever machine fetched it (ADR-0020 item 4).
 * A source whose terms forbid redisplay is never added to this list.
 */
export const HISTORY_ALLOWED_DOMAINS: readonly AllowedDomain[] = [
  {
    domain: "jbhifi.com.au",
    note: "JB Hi-Fi's own product pages, already read live by the lab; terms to read under issue 13.",
  },
  {
    domain: "catalogue.jbhifi.com.au",
    note: "JB Hi-Fi's dated catalogues, the best off-RRP evidence found; terms to read under issue 13.",
  },
  {
    domain: "thegoodguys.com.au",
    note: "Retailer product pages, already read live by the lab.",
  },
  {
    domain: "harveynorman.com.au",
    note: "Retailer product pages, already read live by the lab.",
  },
  { domain: "binglee.com.au", note: "Retailer product pages, already read live by the lab." },
  {
    domain: "samsung.com",
    note: "The brand's own store, the RRP source, already read live by the lab.",
  },
  { domain: "powerland.com.au", note: "Retailer product pages, already read live by the lab." },
  { domain: "toptek.com.au", note: "Retailer product pages, already read live by the lab." },
  {
    domain: "appliancecentral.com.au",
    note: "Retailer product pages, already read live by the lab.",
  },
  { domain: "videopro.com.au", note: "Retailer product pages, already read live by the lab." },
  {
    domain: "ozbargain.com.au",
    note: "Public deal posts, dated by the post; the community's record of off-RRP prices.",
  },
  {
    domain: "press-start.com.au",
    note: "Australian RRP and launch-price announcements, dated by the article.",
  },
];

/** The allow-list as the provider's tool filter wants it: domain strings only. */
export function allowedDomainsOnly(): string[] {
  return HISTORY_ALLOWED_DOMAINS.map(({ domain }) => domain);
}

/** Searches and page opens the model may make in one request (ADR-0020 item 5). Each search is billed. */
export const HISTORY_MAX_TOOL_CALLS = 6;
/** Claims kept from one answer, in the model's order. Each kept claim may cost one page fetch. */
export const HISTORY_MAX_CLAIMS = 12;
/** Claim pages in flight across the whole process, whichever retailer they are on. */
export const CLAIM_PAGE_CONCURRENCY = 3;

/** Process-wide politeness gate for claim pages; see the note at the top. */
const claimGate = createLimiter(CLAIM_PAGE_CONCURRENCY);

/** The product the model is asked about, as the caller identifies it. */
export interface HistorySearchProduct {
  /** The product's display name, as the prompt names it. */
  title: string;
  /** The manufacturer's model code, or null when the caller has none. */
  modelCode: string | null;
  /** The GTIN as the caller holds it, or null. Sent to the model as given. */
  gtin: string | null;
}

export interface HistoryPromptInput extends HistorySearchProduct {
  from: Date;
  to: Date;
}

/**
 * The prompt, strict on purpose: a point is reported only when the model read
 * the price and the date on the page, with the page's full URL and the exact
 * fragment, as JSON and nothing else. The date rule is for the model's own
 * discipline; this source dates every point from the page itself and never
 * from the model's answer. Dates are ISO, in the project's one zone.
 */
export function buildHistoryPrompt(input: HistoryPromptInput): string {
  const identity = [
    input.title.trim(),
    input.modelCode === null || input.modelCode.trim() === ""
      ? null
      : `model code ${input.modelCode.trim()}`,
    input.gtin === null || input.gtin.trim() === "" ? null : `GTIN ${input.gtin.trim()}`,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");
  const from = isoDateIn(input.from, SYDNEY);
  const to = isoDateIn(input.to, SYDNEY);
  return [
    `Use web search. I need the dated Australian retail price history of ${identity}, for the period ${from} to ${to}.`,
    "Rules:",
    "1. Include a point only if you read that exact price, with that date, on that page. Do not infer a date from today or from a sale end date.",
    "2. The date is the date the price was observed or posted, ISO format (YYYY-MM-DD).",
    "3. source_url must be the full URL of the page you read, not a domain.",
    "4. quote must be the exact text fragment on the page that states the price.",
    "5. If you find nothing that meets the rules, return an empty array.",
    "Return JSON only, no commentary: an array of objects with fields date, retailer, price_aud (number), source_url, quote.",
  ].join("\n");
}

export interface HistorySearchInput {
  product: HistorySearchProduct;
  from: Date;
  to: Date;
  apiKey: string;
  /** Defaults to DEFAULT_HISTORY_MODEL. */
  model?: string;
  /** Defaults to HISTORY_ALLOWED_DOMAINS. A claim on any other domain is rejected unread. */
  allowedDomains?: string[];
  /** Defaults to HISTORY_MAX_TOOL_CALLS. */
  maxToolCalls?: number;
  fetch?: FetchLike;
  now?: () => Date;
  /** Told about the model request, each search and page open it made, and each claim page fetched. */
  meter?: Meter;
}

/**
 * One claim the model made, judged against the page it cites. The chart uses
 * `observedAt`, set only when the page or its URL carried a date; the model's
 * own `claimedDate` is carried for display and never used for anything else.
 */
export interface AssessedClaim {
  /** The retailer as the model named it; "" when it named none. */
  retailer: string;
  /** `retailer` slugified, or the page's host slugified when the model named no retailer. */
  retailerSlug: string;
  priceCents: number;
  /** The page as the model cited it. */
  sourceUrl: string;
  /** The fragment the model said states the price; "" when it gave none. */
  quote: string;
  /** The date the model stated, ISO or whatever it wrote; null when it gave none. Display only. */
  claimedDate: string | null;
  verdict: ClaimVerdict;
  /** By the rules in lib/history-evidence: 0.8 verified, 0.6 or 0.5 candidate, 0.4 unverified, 0.3 rejected. */
  confidence: number;
  /** ISO date read from the URL or the page; null when neither carried one or the page was not read. */
  observedDate: string | null;
  /** `observedDate` at 00:00 in Australia/Sydney, the project's one zone; null when there is no date. */
  observedAt: Date | null;
  /** How the quote matched the page; null when the page was not read. */
  fragment: FragmentMatch | null;
  dateSource: "url" | "page" | null;
  /** Why the verdict is what it is, one line each, in the order the rules fired. */
  reasons: string[];
}

export interface HistorySearchResult {
  /** The product as asked, carried so a claim can become a quote with its identifiers. */
  product: HistorySearchProduct;
  /** When this source ran, from the injected clock. */
  fetchedAt: Date;
  /** The prompt sent, for the lab's "what was asked" view. Never the key. */
  prompt: string;
  /** Every claim kept, at most HISTORY_MAX_CLAIMS, in the model's order. */
  claims: AssessedClaim[];
  /** The model the service reports, or the one requested when it reports none. */
  model: string;
  /** Searches are billed; page opens (and any action this source does not know) are not. */
  toolCalls: { searches: number; pageOpens: number };
  inputTokens: number;
  outputTokens: number;
  /** The provider's response body, key removed, for the lab's raw view. */
  raw: unknown;
}

/** The reason a claim on a domain outside the allow-list is rejected unread. */
export const DOMAIN_NOT_ALLOWED_REASON = "domain not on the allow-list";
/** The reason a claim whose source_url is not an http(s) URL is rejected unread. */
export const SOURCE_URL_INVALID_REASON = "source_url is not a URL";

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

interface SourcePage {
  /** The URL with a scheme, as it will be fetched. */
  href: string;
  /** Lower-case host, for the allow-list. */
  host: string;
}

/** The claim's URL as a page to fetch, or null when it is not an http(s) URL. A bare host gets https. */
function sourcePageOf(url: string): SourcePage | null {
  const trimmed = url.trim();
  if (trimmed === "") return null;
  const withScheme = SCHEME_RE.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return { href: parsed.href, host: parsed.hostname.toLowerCase() };
  } catch {
    return null;
  }
}

/** True when the host is one of the domains or a subdomain of one. */
export function isAllowedHost(host: string, domains: readonly string[]): boolean {
  const lower = host.toLowerCase();
  return domains.some((domain) => {
    const d = domain.toLowerCase();
    return lower === d || lower.endsWith(`.${d}`);
  });
}

function rejectedUnread(reason: string): ClaimAssessment {
  return {
    verdict: "rejected",
    confidence: HISTORY_EVIDENCE_CONFIDENCE.rejected,
    observedDate: null,
    fragment: null,
    dateSource: null,
    reasons: [reason],
  };
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The instant an ISO date starts in Sydney; null for anything that is not an ISO date. */
function sydneyMidnightOf(isoDate: string | null): Date | null {
  if (isoDate === null) return null;
  const match = ISO_DATE_RE.exec(isoDate);
  if (match === null) return null;
  const [, year, month, day] = match;
  return startOfDayIn({ year: Number(year), month: Number(month), day: Number(day) }, SYDNEY);
}

function assessedClaimOf(
  claim: ModelClaim,
  retailerSlug: string,
  assessment: ClaimAssessment,
): AssessedClaim {
  return {
    retailer: claim.retailer,
    retailerSlug,
    priceCents: claim.priceCents,
    sourceUrl: claim.sourceUrl,
    quote: claim.quote,
    claimedDate: claim.claimedDate,
    verdict: assessment.verdict,
    confidence: assessment.confidence,
    observedDate: assessment.observedDate,
    observedAt: sydneyMidnightOf(assessment.observedDate),
    fragment: assessment.fragment,
    dateSource: assessment.dateSource,
    reasons: assessment.reasons,
  };
}

/** The ledger's retailer for a claim page: the model's retailer name, else the host. */
function retailerSlugOf(claim: ModelClaim, page: SourcePage | null): string {
  const fromName = slugify(claim.retailer);
  if (fromName !== "") return fromName;
  return page === null ? "unknown" : slugify(page.host) || "unknown";
}

/** The kind an unreachable page reports when an allowed host redirected it to a host outside the allow-list. */
export const REDIRECTED_OFF_ALLOW_LIST = "redirected off the allow-list";

/**
 * One claim page, fetched behind the gate. A failure is a page, never a
 * throw: the claim is judged on it. The allow-list is checked again on the
 * response's final URL, because an allowed host may redirect anywhere and
 * the page verified must be one the list permits.
 */
async function fetchClaimPage(
  input: HistorySearchInput,
  page: SourcePage,
  retailerSlug: string,
  allowedDomains: readonly string[],
): Promise<FetchedPage> {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  let redirectedTo: string | null = null;
  const guardedFetch: FetchLike = async (url, init) => {
    const response = await fetchImpl(url, init);
    const finalHost = hostOf(response.url);
    if (finalHost !== null && !isAllowedHost(finalHost, allowedDomains)) {
      redirectedTo = response.url;
      throw new SourceError("blocked", retailerSlug, `${page.href} redirected to ${response.url}`);
    }
    return response;
  };
  try {
    const html = await claimGate.run(() =>
      fetchText(
        { retailerSlug, url: page.href, fetch: guardedFetch, now: input.now, meter: input.meter },
        page.href,
        { headers: { accept: "text/html" } },
      ),
    );
    return { status: "fetched", html, text: visibleText(html) };
  } catch (error) {
    if (redirectedTo !== null) return { status: "unreachable", kind: REDIRECTED_OFF_ALLOW_LIST };
    return { status: "unreachable", kind: error instanceof SourceError ? error.kind : "network" };
  }
}

/** The lower-case host of a response URL, or null when the runtime reports none. */
function hostOf(url: string): string | null {
  if (url === "") return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function countToolCalls(toolCalls: readonly OpenAiToolCall[]): HistorySearchResult["toolCalls"] {
  let searches = 0;
  let pageOpens = 0;
  for (const call of toolCalls) {
    if (call.type === "search") searches += 1;
    else pageOpens += 1;
  }
  return { searches, pageOpens };
}

/**
 * Asks the model, then checks every claim it made against the page it
 * cites. Throws SourceError only when the model request itself fails; a
 * claim page that cannot be fetched is an unverified claim, not a failure.
 * The model's own dates are never used.
 */
export async function searchHistoryClaims(input: HistorySearchInput): Promise<HistorySearchResult> {
  const now = input.now ?? (() => new Date());
  const fetchedAt = now();
  const model = input.model ?? DEFAULT_HISTORY_MODEL;
  const allowedDomains = input.allowedDomains ?? allowedDomainsOnly();
  const prompt = buildHistoryPrompt({ ...input.product, from: input.from, to: input.to });

  const answer = await searchHistory({
    model,
    apiKey: input.apiKey,
    prompt,
    allowedDomains,
    maxToolCalls: input.maxToolCalls ?? HISTORY_MAX_TOOL_CALLS,
    fetch: input.fetch,
    now: input.now,
    meter: input.meter,
    retailerSlug: null,
  });

  const identifiers = { modelCode: input.product.modelCode, gtin: input.product.gtin };
  const modelClaims = pointsFromModelText(answer.text).slice(0, HISTORY_MAX_CLAIMS);

  // One fetch per distinct page in this search, however many claims cite it.
  const pages = new Map<string, Promise<FetchedPage>>();
  const claims = await Promise.all(
    modelClaims.map(async (claim): Promise<AssessedClaim> => {
      const page = sourcePageOf(claim.sourceUrl);
      const retailerSlug = retailerSlugOf(claim, page);
      if (page === null) {
        return assessedClaimOf(claim, retailerSlug, rejectedUnread(SOURCE_URL_INVALID_REASON));
      }
      if (!isAllowedHost(page.host, allowedDomains)) {
        return assessedClaimOf(claim, retailerSlug, rejectedUnread(DOMAIN_NOT_ALLOWED_REASON));
      }
      let fetched = pages.get(page.href);
      if (fetched === undefined) {
        fetched = fetchClaimPage(input, page, retailerSlug, allowedDomains);
        pages.set(page.href, fetched);
      }
      const assessment = assessClaim({ claim, identifiers, page: await fetched });
      return assessedClaimOf(claim, retailerSlug, assessment);
    }),
  );

  return {
    product: input.product,
    fetchedAt,
    prompt,
    claims,
    model: answer.model,
    toolCalls: countToolCalls(answer.toolCalls),
    inputTokens: answer.inputTokens,
    outputTokens: answer.outputTokens,
    raw: answer.raw,
  };
}

/** The claim's URL with tracking stripped, or as cited when it does not canonicalise. */
function quoteUrlOf(sourceUrl: string): string {
  try {
    return canonicaliseUrl(sourceUrl);
  } catch {
    return sourceUrl;
  }
}

/**
 * The verified claims as quotes: fragment found verbatim on the page, dated
 * from the page or its URL, confidence 0.8. Provenance "model_search" with
 * the cited page as `via`, so every charted point links to the page it was
 * verified on (ADR-0020 item 6). Condition is "new": the allow-list holds
 * retailers' own pages and new-stock deal posts. Identifiers are the
 * product's as asked, not read from the page.
 */
export function quotesOf(result: HistorySearchResult): PriceQuote[] {
  const { product, fetchedAt } = result;
  return result.claims.flatMap((claim): PriceQuote[] => {
    if (claim.verdict !== "verified" || claim.observedAt === null) return [];
    return [
      {
        retailerSlug: claim.retailerSlug,
        retailerName: claim.retailer === "" ? null : claim.retailer,
        url: quoteUrlOf(claim.sourceUrl),
        method: "history_search",
        fetchedAt,
        observedAt: claim.observedAt,
        title: product.title,
        priceCents: claim.priceCents,
        currency: "AUD",
        strikethroughCents: null,
        shippingCents: null,
        availability: "unknown",
        condition: "new",
        identifiers: { gtin: product.gtin, mpn: product.modelCode, retailerSku: null },
        provenance: { kind: "model_search", via: claim.sourceUrl },
        confidence: claim.confidence,
        evidence: claim.quote === "" ? null : claim.quote,
        raw: claim,
      },
    ];
  });
}
