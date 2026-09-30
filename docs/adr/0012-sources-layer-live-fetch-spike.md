# ADR-0012: A sources layer for retailer prices, started as a phase 1 spike

**Status:** Proposed
**Date:** 2026-09-28, amended the same day for the search and archive sources, and on 2026-10-01 for the layered ladder
**Decider:** Rafi (proposed by Claude; the search and archive routes chosen by Rafi; the layered ladder decided by Rafi on 2026-10-01)

## Context

ADR-0003 keeps scrapers out of v1 and puts ingestion in phase 4. On 2026-09-28 Rafi asked to start on the price-fetching model now, with a local page that fetches live prices for one tracked TV, so the data model is shaped by real retailer data rather than guessed. The [research note](../research/2026-09-28-s85h-live-fetch.md) found that three of five AU retailer pages expose the price as structured data readable with one plain request, and two sit behind bot protection.

The architecture had no place for code that talks to a retailer. Services own business rules and the database; `src/lib` is pure; adapters are the app. Fetching a page is none of these.

The first run showed two limits. Two of the five chains block scripted requests, and the two that answered belong to one group, so the lab had one independent price. And a page read today says nothing about last month, while the product exists to draw price history. Rafi asked for options and chose two low-cost ones the same afternoon: Google Shopping through SerpApi for breadth, and the Wayback Machine for history. The [second research note](../research/2026-09-28-serpapi-and-wayback.md) has the findings.

By 2026-10-01 the lab had three ways to a live price, each behind its own button: the page's structured data, the model reader of [ADR-0013](0013-llm-extraction-boundaries.md), and the Google Shopping search. They differ in cost by orders of magnitude. The pages are free, the model costs about 0.1 cents a page, and the search is billed per call against a small quota. Nothing said which route a refresh takes first or when the paid one is justified. Rafi decided the order that day.

## Decision

1. A fourth code layer, **sources**, at `src/sources/`. A source turns one retailer page into one `PriceQuote`: price, currency, struck-through price, availability, the identifiers the page exposed, the raw parsed input, and when it was fetched. It performs one HTTP request and parses the response. It never touches the database and never decides whether the quote becomes a `price_observation`.
2. Layer rules: `src/sources` may import `src/lib` only. Services may import `src/sources`. Adapters may not; they reach a source through a service.
3. `fetch` is injected into every source so tests replay recorded fixtures and never touch the network. Failures throw `SourceError` with a `kind` (`blocked`, `http`, `unparseable`, `network`). The `quotes` service runs sources in parallel and reports each retailer's outcome separately, so one failure never hides the others.
4. Three kinds of source, all returning the same `PriceQuote`, each quote carrying `observedAt` (when the price was true), `condition` and a `provenance` of `live`, `search` or `archive`:
   - **Page sources**, one page now to one quote: `shopify_json` for Shopify stores that allow `/products/<handle>.json`, and `json_ld` for pages carrying a schema.org `Product`. Both prefer structured data over HTML scraping, as ARCHITECTURE.md section 9 already requires.
   - **Search sources**, one query to every seller an aggregator lists: `serpapi_google_shopping`. SerpApi is a paid third party with a free tier; its key lives in `SERPAPI_API_KEY` and never in the repository. A search quote's retailer is the seller name Google prints, matched to a tracked retailer by slug or alias, otherwise reported as a new seller. It carries no GTIN, so it never matches above the model-code tier.
   - **Archive sources**, one page to one quote per dated capture: `wayback`. An archived page is parsed by the same JSON-LD reader as a live one. Archived quotes are backfill: lower confidence, `source = 'api'` when they are persisted, and drawn differently on a chart.
5. Bot protection is respected, not evaded. A retailer whose site answers with a challenge page is recorded as not fetchable, with the reason, and is not requested again until a permitted source exists.
6. Nothing is persisted by this spike. The tracked variant and its retailer pages live in a hand-maintained TypeScript table (`src/services/tracked-products.ts`) until the `catalog`, `retailers` and `listings` services exist, at which point that table becomes rows and the quote becomes an `observations.record` call with `source = 'scrape'`.
7. The lab page at `/lab` is a development tool, not a product journey. It is registered in the journey table as planned and gets no end-to-end spec until it is either promoted to an admin feature or removed.

8. **Live prices are fetched through a layered ladder, cheapest route first** (decided by Rafi on 2026-10-01). `fetchQuotes` in `src/services/quotes.ts` applies it per tracked retailer:

   | Layer | Source | Cost | Confidence | When used |
   |---|---|---|---|---|
   | 1 | The retailer page's structured data: `shopify_json`, `json_ld` | Free | 1 | Always, for every page with a readable source |
   | 2 | The model, `llm_extract` (Gemini Flash-Lite, ADR-0013) | About 0.1 cents a page | 0.3 to 0.7; a candidate below 0.7 | A fetched page carries no structured data, and a Gemini key is set |
   | 3 | One Google Shopping search, `serpapi_google_shopping` | Two SerpApi calls when the first product entity is accepted, at most four | 0.8 entity verified; 0.5 hop-1 fallback, needs review, never cheapest | At least one tracked retailer is still without a price: its page is not fetched because of bot protection, or its page read failed |

   The paid search runs only when there is a gap. When every page answers, no search is made. The search fills the retailers in the gap and no others; a page that answered keeps its own quote. A filled outcome says it came from the search and why the page gave no price. With no `SERPAPI_API_KEY` the gaps stay as skipped or failed and the report says so. If the search fails, the gaps stay and the failure is reported. The report's `gapFill` field carries which of these happened.

   The Wayback Machine is not a rung of this ladder. It stays the history source.

ADR-0003 stands: launch data is still hand-entered. This record changes when the fetching code is written, not when it is run on a schedule. Scheduled fetching remains phase 4 and needs the terms-of-use check in the research note first.

## Options rejected

- **Put fetching inside services.** Services would then import network code, and their unit tests would need HTTP stubs. A separate layer keeps services testable with plain function stubs and keeps the retailer-specific mess in one place.
- **Put parsing and fetching together in `src/lib`.** `src/lib` is pure by rule. The parsers (JSON-LD, money, GTIN, URL) do belong there and are pure; only the request lives in the source.
- **A route handler under `/api/v1` for the lab page.** Nothing outside the app consumes it. A server action calling the service is the same code path with less surface.
- **Persist quotes now as `price_observation` rows.** Needs `retailers`, `catalog` and `listings` first. Doing it by hand would bypass the invariants those services own.
- **Fetch Harvey Norman and Bing Lee through a headless browser or a scraping proxy.** That is evading bot protection. Out. Google Shopping lists both chains from their own feeds, which is the permitted route to their prices.
- **An LLM with web search as a price source.** Cheap enough, but it returns index snippets with no provenance, and one was a day stale in today's test. Models find pages and match titles in phase 4; they never state a price.
- **Gemini with Google Search grounding as the price source for the blocked retailers** (2026-10-01). The same defect as the line above, already rejected in ADR-0013: index snippets, stale, no provenance.
- **Gemini reading the blocked retailers' pages** (2026-10-01). The block is on the download, not on the reading. A model cannot read a page that was never fetched.
- **The Wayback Machine as a live-price layer** (2026-10-01). A capture is a past price. It stays the history source.
- **Buying history from a price-comparison site.** None offers an API, and their charts are their data.

## Consequences

- ARCHITECTURE.md section 3 gains a row; `src/CLAUDE.md` gains a placement row and a boundary rule; the reviewer checks that `src/sources` imports only `src/lib`.
- Phase 1 order changes: `src/lib` helpers arrive now, ahead of the PGlite invariant tests, because the sources need them. The invariant tests are still next.
- The LLM-boundaries record previously pencilled in as ADR-0012 in STATUS.md becomes ADR-0013.
- The search source depends on a paid third party. If SerpApi's terms, price or output change, the strategy is swapped behind the same `SearchSource` type; nothing above the sources layer notices.
- Cost follows the gaps, not the number of refreshes. A refresh where every page answers costs nothing beyond the model's 0.1 cents for a page without structured data. A refresh with a gap costs one search, and every SerpApi call counts against the quota: at two calls a search, the free tier of about 100 calls is about 50 product refreshes a month, and the $75 for 5,000 calls tier is about 3 cents a product refresh. While two tracked chains block scripted requests, every refresh of a product they stock has a gap.
- Affiliate feeds remain the planned long-term route to the blocked chains' prices. Not verified and not built. When a feed exists for a retailer it closes that retailer's gap for free and the search is needed less.
- Archived and searched prices are lower-trust than a live page. The trust order for a `price_observation` becomes: live page, then search, then archive. The `pricing` service (phase 3) weights them accordingly.
- Revisit when the first scheduled job is designed (phase 4): the staging table from ADR-0010 receives quotes whose identifiers do not resolve, and `raw` on the quote becomes `price_observation.raw`.
