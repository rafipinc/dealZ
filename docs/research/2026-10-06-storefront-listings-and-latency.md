# Storefront listings and latency: what a store can give a search index, and how fast it answers

**Date:** 2026-10-06, evening. **Method:** one plain HTTPS GET per endpoint from a script with a DealZ research User-Agent, no cookies, no browser. **Endpoints:** `/search/suggest.json` (the predictive search of the [morning's note](2026-10-06-shopify-storefront-search.md)), `/collections.json`, `/collections/<handle>/products.json?limit=250`, `/products.json?limit=250&page=N` and `robots.txt`. **Stores:** JB Hi-Fi and Powerland, the two searchable storefronts.

This note is the field work behind [ADR-0017](../adr/0017-local-search-index.md). After the relevance rule of the [afternoon's note](2026-10-06-storefront-search-relevance.md), Rafi asked for a lightweight search over our own database, in a dropdown as you type, fast and relevant, using the data sources cheaply. The question was whether a dropdown can ask the stores per keystroke, and if not, what a store can give a local index and at what cost. It is a snapshot; storefronts change.

## Findings

| Fact | Measured |
|---|---|
| Predictive search latency | JB Hi-Fi 0.73 to 0.88 s per query. Powerland 0.37 to 0.60 s |
| Powerland `/collections/televisions/products.json?limit=250` | 200. 129 products, 3.6 MB, 1.07 s. Fields: title, vendor, product_type, tags, images, variants with sku (the model code), price, compare_at_price, available. No barcode |
| Powerland `/collections.json` | 151 collections with product counts. `televisions` 900 listed, `hifi-soundbars` 92 |
| JB Hi-Fi `/products.json?limit=250` | 250 products a page, about 1 MB and 1.6 s a page. Page 60 full, page 120 empty, so 15,000 to 30,000 products. Pages 1 and 20 were mostly MOVIES, TELCO SERVICES, IT and COMPUTERS. No barcode in the listing |
| JB Hi-Fi `/collections/tvs-65-70_.../products.json` | 200 with an empty products array. Its category collections do not expose products as JSON |
| JB Hi-Fi `/collections.json` | 250 collections, every product count 0 |
| `robots.txt` | JB Hi-Fi disallows some `/collections/*` sort and plus patterns, nothing on `/products.json`. Powerland allows |
| Barcode | Only in `/products/<handle>.json`, never in a listing |
| pg_trgm | Ships in PGlite (`@electric-sql/pglite/contrib/pg_trgm`) and in Supabase Postgres |

## Conclusions

- A dropdown cannot call the stores per keystroke. At 0.4 to 0.9 seconds a query the typing outruns the answers, and every keystroke would be a retailer request.
- So the search must run on DealZ's own rows. Postgres trigram similarity is enough for a few thousand titles and model codes, and the extension is already in both database engines.
- Powerland's TV collection is one cheap request: 129 products with the model code in the SKU.
- JB Hi-Fi's whole listing is about 100 requests and 100 MB per sync, mostly outside consumer tech. That is a crawl in all but name, with its terms unread. Its rows are learned from live searches and identifier reads instead.
- Identifiers stay on demand. No listing carries a barcode, so a GTIN costs one product JSON request per candidate, as ADR-0016 item 6 already says.

## Open questions

- JB Hi-Fi's terms of use for the listing endpoints, the same question as for the pages and the search (STATUS.md). A pull waits on the answer.
- Whether Powerland's 900 listed against 129 returned is pagination at 250 a page or unpublished products in the count. One page was requested.
- A second collection for soundbars (`hifi-soundbars`, 92) and for gaming, later.
- How stale a listed price may be before the index misleads. The listing price is a snapshot for search, never a price fact.
