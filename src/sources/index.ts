// Public surface of the sources layer. Services pick a strategy by
// SourceMethod; nothing else imports from here (src/CLAUDE.md rule 9).

import { fetchJsonLdQuote } from "./json-ld";
import { fetchLlmExtractQuote } from "./llm-extract";
import { discoverGoogleShopping, fetchSerpApiAccount, searchGoogleShopping } from "./serpapi";
import { fetchShopifyQuote } from "./shopify";
import { listStorefrontCollection } from "./storefront-listing";
import { searchStorefront } from "./storefront-search";
import type {
  ArchiveSource,
  DiscoverySource,
  GoogleShoppingDiscoverySource,
  ListingSource,
  SearchSource,
  Source,
} from "./types";
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

/** One query to one storefront, every product its search suggests (ADR-0016). Not a price source. */
export const discoverySources: Record<"storefront_search", DiscoverySource> = {
  storefront_search: searchStorefront,
};

/**
 * One query to Google Shopping, every result a candidate: the miss path of
 * the catalogue search (ADR-0017). Its input carries a key, so it is not a
 * DiscoverySource and sits beside the registry rather than in it.
 */
export const googleShoppingDiscovery: GoogleShoppingDiscoverySource = discoverGoogleShopping;

/** One storefront collection, every product in it, page by page (ADR-0016). Not a price source. */
export const listingSources: Record<"storefront_listing", ListingSource> = {
  storefront_listing: listStorefrontCollection,
};

/** SerpApi's plan and quota, for the status service. Not a price source. */
export const accountSources = { serpapi: fetchSerpApiAccount } as const;

export { SourceError, REVIEW_THRESHOLD } from "./types";
export { DEFAULT_LIMIT, fetchCandidateIdentifiers, MAX_LIMIT } from "./storefront-search";
export { DEFAULT_MAX_PAGES, MAX_PAGES, PAGE_SIZE } from "./storefront-listing";
export { DISCOVERY_DEFAULT_LIMIT, DISCOVERY_MAX_LIMIT } from "./serpapi";
export type { LlmExtractInput } from "./llm-extract";
export type { SerpApiAccount, SerpApiAccountInput } from "./serpapi";
export type {
  ArchiveResult,
  ArchiveSkippedSnapshot,
  ArchiveSource,
  ArchiveSourceInput,
  Availability,
  DiscoveryMethod,
  DiscoverySource,
  DiscoverySourceInput,
  FetchLike,
  GoogleShoppingDiscoveryInput,
  GoogleShoppingDiscoverySource,
  ListingSource,
  ListingSourceInput,
  Meter,
  PriceQuote,
  ProductCandidate,
  QuoteCondition,
  QuoteIdentifiers,
  QuoteProvenance,
  SearchSource,
  SearchSourceInput,
  Source,
  SourceCall,
  SourceErrorKind,
  SourceInput,
  SourceMethod,
  SourceOperation,
  SourceProvider,
} from "./types";
