# ADR-0017: A local search index of storefront products, seeded cheaply and learned from use, behind an as-you-type search

**Status:** Proposed
**Date:** 2026-10-06, amended the same day for Google Shopping discovery
**Decider:** Rafi (proposed by Claude). Rafi decided items 1 to 3 and item 10 in chat on 2026-10-06. Items 4 to 9, 11 and 12 are Claude's proposal and await his acceptance.

## Context

After the relevance rule of [ADR-0016](0016-catalogue-discovery-through-storefront-search.md) item 12 landed, Rafi said the search still needed refinement. He asked for a lightweight search for most products, using our own database, appearing in a dropdown as you type without pressing Search, fast and relevant, and using the data sources cheaply. The search as built asks the stores on every submit and waits for them.

Claude measured what the stores can give on 2026-10-06, one plain GET each. The [third research note of 2026-10-06](../research/2026-10-06-storefront-listings-and-latency.md) holds the figures. In short: predictive search answers in 0.4 to 0.9 seconds, so a dropdown cannot call the stores per keystroke, and the search has to run on DealZ's own rows. Powerland's `televisions` collection is one request of 3.6 MB for 129 products with title, vendor, type, tags, images, SKU (the model code), price and availability. JB Hi-Fi's category collections return an empty products array as JSON; its whole listing is 15,000 to 30,000 products over about 100 requests and 100 MB, mostly movies, telco and IT, which is a crawl in all but name with its terms unread. No listing carries a barcode; that stays in the product JSON, one request per product. pg_trgm ships in both PGlite and Supabase Postgres.

The staging table that [ADR-0010](0010-listing-match-audit-and-staging.md) deferred to phase 4 is the natural home for these rows. This record brings it forward and settles the Product search open decision of ARCHITECTURE.md section 11. It amends ADR-0016 item 1: the dashboard lives on `/lab`, not `/lab/catalog`.

Once the index was seeded it held Powerland's TVs and nothing else. Rafi said one website cannot be the source. The product must rely on an API or an aggregated feed, mimic the Google Shopping experience with DealZ's own flavour, and he asked whether SerpApi is the best fit and whether paying is unavoidable.

Claude's assessment, with prices checked on 2026-10-06:

| Route | Cost | Finding |
|---|---|---|
| An official Google Shopping search API | None exists | Google offers no search API for Shopping results |
| SerpApi | 250 searches a month free, then USD 25 per 1,000, about 2.5 cents a search | The most reliable provider. Already the price search source of [ADR-0012](0012-sources-layer-live-fetch-spike.md) |
| DataForSEO | About 0.2 cents a query, live | Swappable behind the same source type |
| SearchApi | About 0.4 cents a query | Swappable behind the same source type |
| Affiliate network feeds (Commission Factory) | Free | The legal bulk source, once each retailer approves DealZ as a publisher |
| eBay Browse API | Free, 5,000 calls a day | Searches by GTIN. A second engine, not a first |

The index built this session changes the arithmetic: each unique query becomes at most one paid call, and is served free afterwards while its rows are fresh. DealZ's flavour is what Google does not offer: verified prices from live page reads, price history, and the price verdict. Rafi decided to build into that recommendation, to use SerpApi as a development tool, and not to let the cost drag out.

## Decision

Decided by Rafi:

1. **The index exists.** It is the staging table ADR-0010 deferred to phase 4, brought forward to phase 1.
2. **Seed scope.** Powerland's `televisions` collection is pulled. JB Hi-Fi is learned only, from live searches and identifier reads. No crawl of JB Hi-Fi until its terms are read.
3. **The dropdown lives at the top of `/lab`.** There is no `/lab/catalog` page.

Decided by Rafi in the amendment of 2026-10-06:

10. **Google Shopping through SerpApi is the discovery engine for products the index and the storefronts do not hold.** It is a development tool, cost-capped.

Proposed by Claude, stated so it can be checked against the code:

4. **A `catalogue_candidate` table.** One row per store product seen: retailer slug as text, handle, canonical URL, title, brand, store type, model code, GTIN when read (14 digits), SKU, price and compare-at price seen in cents, currency, availability, image, `source` of `listing`, `search` or `inspect`, raw, first seen and last seen. Unique on retailer and handle. A trigram index on the title through pg_trgm. It is a snapshot, never a `price_observation`, and nothing in the catalogue references it.
5. **How rows arrive.** From a listing pull (the `storefront_listing` source, one request per 250 products, 500 ms between pages), from every live search and from every identifier read. Each is an upsert on retailer and handle. An identifier once read is never erased by a later row without one.
6. **The search.** One indexed query on title similarity and exact identifier. The top hits are re-ranked by the relevance rule of ADR-0016 item 12 and grouped into one product per GTIN or model code, with every store's price. Eight rows in a dropdown as the developer types, debounced 150 ms. Enter opens the full table. Fewer than three local matches offers a live store search, whose results feed the index.
7. **A status line and a refresh.** A line under the box says how many products the index holds per store and when each was last refreshed. A "Refresh index" button pulls the seeded collections, metered in the usage ledger ([ADR-0014](0014-usage-ledger-and-status-dashboard.md)) with the new operation `listing`.
8. **Every row is a candidate.** The index never creates a product, variant or listing. Adding stays the confirmed action of ADR-0016 item 8.
9. **The index is disposable.** It is wiped and rebuilt freely. Nothing depends on its ids.

Proposed by Claude in the amendment of 2026-10-06, for item 10:

11. **The mechanism of item 10.** The dropdown never makes a paid call. A paid call happens only on an explicit search, Enter or the dropdown's last row, and only when the index holds fewer than three matching products. One SerpApi request per query: the product-entity hop only, never the per-product stores hop, which the price search still uses (ADR-0012 item 8). A daily cap, `SERPAPI_DAILY_CAP`, default 20, counted from the usage ledger's successful SerpApi searches that day in Australia/Sydney; once reached, Google Shopping is skipped and the report says so. Every Google result is remembered in the index as a candidate with source `search`, merged with storefront rows by GTIN, model code or title, so the same query never pays twice while the rows are fresh. The status line under the search box shows the day's count against the cap only; the month's quota stays on `/lab/status`, from the Account call. The count is the ledger's successful `google_shopping` and `google_immersive_product` calls that day, whichever panel made them; the free Account call is not counted. The ledger write is best effort, so a paid call whose record fails is not counted against the cap: the error is towards one extra call, never fewer. A malformed `SERPAPI_DAILY_CAP` falls back to the default and the status line says so. A budget read that fails skips Google Shopping for that search and reports it; it never blocks the index path.
12. **The provider is replaceable** behind the discovery source type. DataForSEO or SearchApi are the candidates when volume justifies a second provider. The eBay Browse API is the planned free second engine. Affiliate feeds are the planned bulk source. All of these are planned, none is built.

## Options rejected

- **Live typeahead against the stores.** 0.4 to 0.9 seconds a keystroke, every keystroke a retailer request, and the terms question on each.
- **A full pull of JB Hi-Fi now.** About 100 requests and 100 MB a sync, a crawl, with its terms unread. Revisit when the terms are read.
- **A search service such as Algolia or Meilisearch.** A second system for a few thousand rows that Postgres trigram handles.
- **Postgres full-text search alone.** It stems words, and a model code is not a word. Trigram handles both. Full-text can be added for descriptions later.
- **Client-side filtering of a downloaded index.** Ships every row to the browser.
- **A scheduled sync now.** Phase 4. The refresh is a button until then.
- **Google Shopping on every keystroke.** Cost and latency: a paid call and a round trip for each character typed.
- **The two-hop price search for discovery.** Two to four calls a query. Discovery needs the product entities only.
- **A monthly cap alone.** A bad loop could spend a month in an hour. The daily cap bounds it.
- **DataForSEO now.** A second provider module before the volume exists to justify it.

## Consequences

- A fifth migration pair, and pg_trgm in the PGlite harness.
- The `catalog` service's `searchCatalog` (ADR-0016 item 4) searches real rows and the index together.
- The staging shape for phase 4 is settled early and may be reshaped by the first scraper. ADR-0010 still governs matching.
- A `catalogue-index` service and the `storefront_listing` source, each with a row in ARCHITECTURE.md section 4 and BUILD_MAP.md.
- The Product search decision in ARCHITECTURE.md section 11 is settled: trigram now.
- `SERPAPI_DAILY_CAP` is listed in `.env.example` and in SETUP.md's settings table, default 20; 0 disables Google Shopping discovery.
- The discovery method `google_shopping` joins `storefront_search` and `storefront_listing` in the sources layer.
- The `discovery` row of ARCHITECTURE.md section 4 gains `discoverProducts` and `serpApiBudget`, with the invariant: a paid search only on an explicit query, only on an index miss, never above the daily cap. No new component in BUILD_MAP.md: the code lands in the existing `discovery` service and the sources layer.
- ARCHITECTURE.md section 3.1 is untouched. The price ladder of ADR-0012 item 8 stands, including its second hop.
- The blocklist gains `DataForSEO`, `SearchApi` and `Commission Factory`. No new retailer or technique.
- J-018, "Type in the product search and pick a product from the dropdown", is in the journey registry: developer, phase 1, planned, hidden in PUBLIC.md as a lab page.
- Revisit when JB Hi-Fi's terms are read, when the daily cap is reached on an ordinary day, and when volume justifies a second provider.
