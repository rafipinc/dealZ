// Public surface of the sources layer. Services pick a strategy by
// SourceMethod; nothing else imports from here (src/CLAUDE.md rule 9).

import { fetchJsonLdQuote } from "./json-ld";
import { fetchLlmExtractQuote } from "./llm-extract";
import { searchGoogleShopping } from "./serpapi";
import { fetchShopifyQuote } from "./shopify";
import type { ArchiveSource, SearchSource, Source } from "./types";
import { fetchWaybackHistory } from "./wayback";

/** The SourceMethods that read one retailer page now. */
export type PageSourceMethod = "shopify_json" | "json_ld" | "llm_extract";

/** One retailer page now, one quote. llm_extract is the fallback when a page has no structured data (ADR-0013). */
export const pageSources: Record<PageSourceMethod, Source> = {
  shopify_json: fetchShopifyQuote,
  json_ld: fetchJsonLdQuote,
  llm_extract: fetchLlmExtractQuote,
};

/** One query to an aggregator, one quote per seller. */
export const searchSources: Record<"serpapi_google_shopping", SearchSource> = {
  serpapi_google_shopping: searchGoogleShopping,
};

/** One retailer page, one quote per archived snapshot. */
export const archiveSources: Record<"wayback", ArchiveSource> = {
  wayback: fetchWaybackHistory,
};

export { SourceError, REVIEW_THRESHOLD } from "./types";
export type { LlmExtractInput } from "./llm-extract";
export type {
  ArchiveResult,
  ArchiveSkippedSnapshot,
  ArchiveSource,
  ArchiveSourceInput,
  Availability,
  FetchLike,
  PriceQuote,
  QuoteCondition,
  QuoteIdentifiers,
  QuoteProvenance,
  SearchSource,
  SearchSourceInput,
  Source,
  SourceErrorKind,
  SourceInput,
  SourceMethod,
} from "./types";
