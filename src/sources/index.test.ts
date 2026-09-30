import { describe, expect, it } from "vitest";
import { archiveSources, pageSources, searchSources, SourceError } from "./index";
import { fetchLlmExtractQuote } from "./llm-extract";
import { fetchJsonLdQuote } from "./json-ld";
import { searchGoogleShopping } from "./serpapi";
import { fetchShopifyQuote } from "./shopify";
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

  it("re-exports SourceError", () => {
    expect(new SourceError("http", "x", "m")).toBeInstanceOf(Error);
  });
});
