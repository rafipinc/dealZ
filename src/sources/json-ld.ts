// json_ld: reads the schema.org Product a retailer embeds in its page.
// Parsing lives in src/lib/json-ld; this file only fetches and maps. The
// mapping is shared with the wayback source, which reads the same pages from
// the archive.

import { offerFromHtml } from "../lib/json-ld";
import { fetchText, pageUrlOf } from "./http";
import {
  SourceError,
  type PriceQuote,
  type QuoteProvenance,
  type Source,
  type SourceInput,
  type SourceMethod,
} from "./types";

/**
 * Confidence for a JSON-LD price read from the live page: the retailer's own
 * structured data, read directly, so 1. The wayback source passes its own,
 * lower figure for the same parse of an archived copy.
 */
export const LIVE_JSON_LD_CONFIDENCE = 1;

/** Everything a PriceQuote needs that the page itself does not say. */
export interface JsonLdQuoteContext {
  /** Canonicalised page URL: the quote's `url` and the subject of error messages. */
  pageUrl: string;
  method: SourceMethod;
  input: Pick<SourceInput, "retailerSlug" | "retailerName">;
  fetchedAt: Date;
  observedAt: Date;
  provenance: QuoteProvenance;
  /** Fixed by the calling source: LIVE_JSON_LD_CONFIDENCE live, ARCHIVE_CONFIDENCE from the archive. */
  confidence: number;
}

/**
 * Maps a page's HTML to a PriceQuote from its JSON-LD Product. Throws
 * SourceError "unparseable" when the page has no Product or no readable price.
 */
export function quoteFromJsonLdHtml(html: string, context: JsonLdQuoteContext): PriceQuote {
  const { pageUrl, input } = context;
  const found = offerFromHtml(html);
  if (found === null) {
    throw new SourceError("unparseable", input.retailerSlug, `${pageUrl} has no JSON-LD Product`);
  }
  const { product, offer } = found;
  if (offer.priceCents === null) {
    throw new SourceError("unparseable", input.retailerSlug, `${pageUrl} has no readable price`);
  }

  return {
    retailerSlug: input.retailerSlug,
    retailerName: input.retailerName ?? null,
    url: pageUrl,
    method: context.method,
    fetchedAt: context.fetchedAt,
    observedAt: context.observedAt,
    title: offer.name,
    priceCents: offer.priceCents,
    // An offer without priceCurrency on an Australian retailer's page is in
    // AUD. Revisit if a source outside Australia is added.
    currency: offer.currency ?? "AUD",
    strikethroughCents: offer.strikethroughCents,
    shippingCents: offer.shippingCents,
    availability: offer.availability,
    condition: offer.condition,
    identifiers: {
      gtin: offer.gtin,
      mpn: offer.mpn ?? offer.model ?? null,
      retailerSku: offer.sku,
    },
    provenance: context.provenance,
    confidence: context.confidence,
    // Structured data needs no choice of fragment; nothing to point at.
    evidence: null,
    raw: product,
  };
}

export const fetchJsonLdQuote: Source = async (input) => {
  const pageUrl = pageUrlOf(input);
  const now = input.now ?? (() => new Date());

  const html = await fetchText(input, pageUrl, { headers: { accept: "text/html" } });

  const fetchedAt = now();
  return quoteFromJsonLdHtml(html, {
    pageUrl,
    method: "json_ld",
    input,
    fetchedAt,
    observedAt: fetchedAt,
    provenance: { kind: "live", via: null },
    confidence: LIVE_JSON_LD_CONFIDENCE,
  });
};
