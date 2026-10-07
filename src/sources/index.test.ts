import { describe, expect, it } from "vitest";
import {
  archiveSources,
  discoverySources,
  fetchCandidateIdentifiers,
  googleShoppingDiscovery,
  listingSources,
  pageSources,
  searchSources,
  SourceError,
} from "./index";
import { fetchLlmExtractQuote } from "./llm-extract";
import { fetchJsonLdQuote } from "./json-ld";
import { discoverGoogleShopping, searchGoogleShopping } from "./serpapi";
import { fetchShopifyQuote } from "./shopify";
import { listStorefrontCollection } from "./storefront-listing";
import { searchStorefront } from "./storefront-search";
import { fetchWaybackHistory } from "./wayback";

describe("sources index", () => {
  it("maps each page method to its source", () => {
    expect(pageSources).toEqual({
      shopify_json: fetchShopifyQuote,
      json_ld: fetchJsonLdQuote,
      llm_extract: fetchLlmExtractQuote,
    });
  });

  it("maps the search and archive methods to their sources", () => {
    expect(searchSources).toEqual({ serpapi_google_shopping: searchGoogleShopping });
    expect(archiveSources).toEqual({ wayback: fetchWaybackHistory });
  });

  it("maps the discovery method to its source and exposes the identifier fetch", () => {
    expect(discoverySources).toEqual({ storefront_search: searchStorefront });
    expect(typeof fetchCandidateIdentifiers).toBe("function");
  });

  it("exposes the Google Shopping discovery beside the registry", () => {
    expect(googleShoppingDiscovery).toBe(discoverGoogleShopping);
  });

  it("maps the listing method to its source", () => {
    expect(listingSources).toEqual({ storefront_listing: listStorefrontCollection });
  });

  it("re-exports SourceError", () => {
    expect(new SourceError("http", "x", "m")).toBeInstanceOf(Error);
  });
});
