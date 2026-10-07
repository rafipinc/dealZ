# Status

Where DealZ is right now. Rewritten at the end of every session and read at the start of the next.

**Updated:** 2026-10-08. **Phase:** 1, working database and backend layer. **Step:** catalogue discovery and the local search index, going to a pull request from branch `p1/catalog-discovery-adr`. Built on 2026-10-06: storefront discovery, the relevance rule, the local index with the as-you-type dropdown, and Google Shopping as the cost-capped miss path. Reviewed and cleaned up on 2026-10-08 (below). Rafi accepted [ADR-0016](adr/0016-catalogue-discovery-through-storefront-search.md) and [ADR-0017](adr/0017-local-search-index.md) on 2026-10-08, Claude's proposed items included; he had decided ADR-0016 items 1 to 3 and ADR-0017 items 1 to 3 and 10 on 2026-10-06.

## What exists

- On `main`: the docs, the schema with migrations `0000` to `0003`, the Next.js scaffold, the conventions of ADR-0011, the price-fetch spike (pull request #3), the usage ledger and status dashboard (pull request #4, [ADR-0014](adr/0014-usage-ledger-and-status-dashboard.md)), the public build log (pull request #5, [ADR-0015](adr/0015-public-build-log.md)) and the pre-commit registry hook (pull request #6). Thirteen accepted ADRs. [ADR-0012](adr/0012-sources-layer-live-fetch-spike.md) and [ADR-0013](adr/0013-llm-extraction-boundaries.md) are proposed. ADR-0016 and ADR-0017 are accepted on this branch, with migrations `0004` and `0005`; `main` will have fifteen accepted ADRs once it merges.
- The spike: `src/sources`, the `quotes` service with the live-price ladder (ARCHITECTURE.md section 3.1), one tracked variant in `src/services/tracked-products.ts`, the lab at `/lab`. API keys live in the macOS Keychain (SETUP.md section 2).
- The usage ledger and status dashboard, per ADR-0014: table `api_usage`, append-only, migrations `0002_api-usage` and `0003_api-usage-triggers`, `src/db/sql/api-usage-triggers.sql`, query helpers in `src/db/queries/`, the PGlite harness `src/db/test-db.ts`; an injected `meter` in every source; `usage`, `status`, `usage-ledger` and `default-db` services; `/lab/status`, served only when `NODE_ENV` is `development`. J-014 and J-015 stay planned.
- The public build log: the `site/` project, a static Next.js export generated from the ADRs, [BUILD_MAP.md](BUILD_MAP.md) (32 components), [PUBLIC.md](PUBLIC.md) (17 ADRs, 17 sessions, 18 journeys, the blocklist), the journey registry and the commit history. CI: a `build-log` job and a `metrics` job. Runs locally with `npm --prefix site run dev` on port 3100. Not deployed. `.githooks/pre-commit` runs the registry checks before every commit.
- The local stack: Colima and the Supabase CLI stack. Six migrations applied to the local database on 2026-10-06; `pg_trgm` and the five indexes confirmed. `src/db/invariants.test.ts` covers `api_usage`, `catalogue_candidate` and the migrations.
- Catalogue discovery, per ADR-0016, on this branch, all with tests:

| Layer | What |
|---|---|
| lib | `model-code` (the last qualifying token of a title wins, a deny list for spec tokens, its false positives and false negative named and tested), `query-routing` (a valid GTIN in 14-digit form, else text), `relevance` (four tiers, a score, a comparator under the `en` collation, its misses named and tested). `url` strips the Shopify search parameters |
| sources | `storefront_search`: one query to one Shopify storefront, many `ProductCandidate`s, no key, metered as operation `search`. `fetchCandidateIdentifiers` reads one product JSON. Twelve recorded responses |
| services | `discovery`. `findProducts` routes the query, searches every storefront in parallel, reports each store's outcome, marks a candidate held when its GTIN, MPN or URL matches a tracked variant, judges relevance (a GTIN query bypasses the rule), sorts by tier then score, and remembers what it saw in the index. `inspectCandidate` reads one candidate's identifiers, refuses a host outside the storefronts or a path outside `/products/`, and remembers the product. Both remember best effort, bounded at 2 seconds, and report `remembered`. `searchableStorefronts`: JB Hi-Fi and Powerland; Bing Lee is bot-protected |
| app | The "Find a product" panel at the top of `/lab`: the search box, a results table (store, product, price, was, stock, model code, GTIN, held, links), a per-row "Read identifiers" button. Match rows, then accessory rows with a badge; partial and unrelated rows under "Other results the stores returned (N)" |

- The local search index, per ADR-0017, on this branch, all with tests:

| Layer | What |
|---|---|
| db | Table `catalogue_candidate`, the staging table of ADR-0010 brought forward. Migrations `0004_catalogue-candidate` (generated) and `0005_catalogue-candidate-search` (custom: `pg_trgm`, a trigram GIN index on `title`, the `updated_at` trigger; its pair is `src/db/sql/catalogue-candidate-search.sql`). `pg_trgm` in the PGlite harness. Query helpers in `src/db/queries/catalogue-candidates.ts`: `upsertCatalogueCandidates` (an identifier once read is never erased), `searchCatalogueCandidates` (trigram similarity, ILIKE with wildcards escaped, exact identifier; limit capped at 200), `countCatalogueCandidates`, `deleteUnseenListingRows`, `databaseNow` (the database clock, the one that stamps `last_seen_at`). Ten new invariant tests |
| sources | `storefront_listing`: one Shopify collection, 250 products a page, 500 ms between pages, metered as operation `listing`. The model code from the title, else from a SKU that is one. `seededCollections` in `tracked-products.ts`: Powerland's `televisions` only |
| services | `catalogue-index`: `remember`, `rememberInspect`, `refreshIndex` (pulls the seeded collections, then drops the `listing` rows the store no longer lists, cut off by the database clock; once per store after all of its collections; a collection that fails or returns no products drops nothing of its store), `searchIndex` (routes the query, judges relevance, drops unrelated rows, groups one product per GTIN, model code or title with every store's offer and the cheapest), `indexStatus` |
| app | A combobox at the top of `/lab`: a listbox of up to eight products as you type, debounced 150 ms, the latest request wins, arrow keys, Enter and Escape. An index status line and a "Refresh index" button. The page renders with "Index unavailable" when the database is down. `index-loaders.ts` is a thin adapter over the calls, with failures unwrapped by `rootCause` in `src/lib/errors` and redacted by `safeFailureMessage` in the `status` service; its unit test file was removed, and its UI mapping is left to J-017 and J-018 |

- Google Shopping as the miss path, per ADR-0017 items 10 to 12, on this branch, all with tests:

| Layer | What |
|---|---|
| sources | `google_shopping` discovery: `discoverGoogleShopping` in the SerpApi source. One request, the product-entity hop only, every result a `ProductCandidate`, the model code by the general rule, the key never in a report |
| services | `discoverProducts`: the index first; on fewer than three matches, or one for a GTIN, a parallel fan-out to Google Shopping and the storefronts, every result remembered, then the index searched again so rows merge. It returns `candidates`, storefront and Google rows in one list ranked by `lib/relevance` (which now also owns `HIDDEN_TIERS`), so `view.ts` only maps. `serpApiBudget`: the cap from `SERPAPI_DAILY_CAP`, default 20, a malformed value falling back and reported; used today counted from the ledger's successful `google_shopping` and `google_immersive_product` calls that Sydney day. A budget read failure skips Google and reports it; it never blocks the index |
| db | `countOkCallsByOperation` in `src/db/queries/api-usage.ts` |
| app | Enter and the dropdown's last row render grouped product cards with expandable offers; a count line saying whether the answer came from the index or the fan-out; a Google line when skipped or failed; a status line "SerpApi: N of 20 today". `.env.example` and SETUP.md carry the cap |

- Cleanups of 2026-10-08, all with tests, after a full-branch reviewer run found no merge blocker: the empty-collection guard and the database-clock cut-off in `refreshIndex`; `indexStatus`'s `ValidationError` tested; `MAX_QUERY_LENGTH` defined once in `catalogue-index`; `matchTrackedVariant` validated with Zod and tested in `tracked-products.test.ts`; the relevance rules out of the adapter; `src/app/lab/index-loaders.test.ts` deleted under the placement rule. Then: `refreshIndex` drops a store's unseen rows once, after all of that store's collections succeed, with the seeded collections injectable for tests; `discoverProducts` reads the budget, makes the Google Shopping call and writes its ledger row one search at a time in the process, so two searches at the cap minus one cannot both spend; the pure `rootCause` in `src/lib/errors` replaced `safeFailureReason`; `catalog-search-panel.tsx` renamed `catalogue-search-panel.tsx`.
- The gate was green on 2026-10-08: typecheck, lint, 1246 tests in 47 files, about 98.7 percent statements and 94.4 percent branches, `db:check`, the e2e coverage check and the build log check. Verified live in the browser on 2026-10-06 at 16:53 Sydney against the local database: the index held 162 products from 2 stores and 12 Google Shopping sellers after one SerpApi search earlier that afternoon, the status line reading "SerpApi: 1 of 20 today"; Enter on "Xbox Series X" answered from the index with 48 offers across 46 products (consoles from xbox.com, JB Hi-Fi with two sellers grouped, EB Games, Cash Converters, Kogan and eBay, then the accessories) without a second paid call.

## What does not exist yet

| Missing | Note |
|---|---|
| Services `catalog`, `retailers`, `listings`, `observations`, `deals` | Steps (b) onward of ADR-0016. No price is persisted as history; the tracked variant is a TypeScript table |
| "Add to catalogue" | A product card or dropdown row opens the store page and persists nothing beyond the index |
| The eBay Browse source | The planned free second engine, ADR-0017 item 12. Needs developer keys |
| Affiliate feeds | The planned bulk source, ADR-0017 item 12. Rafi to apply to Commission Factory as a publisher. Not verified, not built |
| DataForSEO | The cheaper swap at volume, ADR-0017 item 12 |
| A scheduled refresh | The index is refreshed by the button only, until phase 4 |
| A JB Hi-Fi listing pull | Its terms are unread; the store is learned from searches and identifier reads only (ADR-0017 item 2) |
| A month-quota line on `/lab` | The day's count only; the month stays on `/lab/status` (ADR-0017 item 11) |
| The dashboard's data insights section; the extractor's labelled set | Deferred earlier |
| For the build log | The Vercel deploy, pages that show the metrics (to be redesigned around the stack and the implementation, Rafi, 2026-10-01), lint for `site/`, a Playwright spec for J-016 |

## Next

One per session unless small:

1. Rafi's actions: the Commission Factory publisher application; eBay developer keys.
2. Step (b) of ADR-0016: the `catalog` and `retailers` services with `searchCatalog` over real rows and the index, seeding the tracked TV, and "Add to catalogue" from a product card with the candidate's fields editable (ADR-0016 item 8).
3. The remaining invariant matrix rows in TESTING.md, for `product`, `variant` and `identifier`.
4. `listings`, and the listing row on add; then `/lab` reading rows with the tracked table deleted.
5. The eBay Browse engine, the free second engine of ADR-0017 item 12.
6. Rafi reads and approves the public summaries in PUBLIC.md, which are Claude's drafts. Check that the first `metrics` run created the `build-log-data` branch.
7. Rafi reviews the lab, ADR-0012 and ADR-0013, and the earlier decisions under Open.
8. Services `observations` and `deals`, so quotes and model-read candidates become rows, staged below the threshold per ADR-0010.
9. The dashboard's data insights section. The build log: redesign of the pages, then lint, the J-016 spec and the Vercel deploy.

## Open

From the catalogue discovery work, for Rafi:

- The daily cap is enforced within one Node process: searches take turns over the budget read and the paid call. Two instances of the app could each pass at cap minus one. Revisit before discovery runs anywhere but the local dev server.
- Migration `0005` runs `CREATE EXTENSION pg_trgm` with no schema. On Supabase it lands in `public`, which the security advisor flags. Choose a schema before the first production migration ([RUNBOOK.md](RUNBOOK.md), Migrate production).
- Google Shopping rows carry no GTIN, so they merge with store rows only by model code or identical title. A console listed by Google and by a storefront under different titles shows as two products.
- The price panel's gap fill counts against the daily cap but is not gated by it (SETUP.md settings table). Only Google Shopping discovery is skipped at the cap.
- The ledger write is best effort, so a paid call whose record fails is not counted against the cap. The error is towards one extra call, never fewer.
- JB Hi-Fi's terms must be read before any listing pull of it. The storefront search endpoint and the pages are under the same question.
- Powerland's collection page states about 900 products; `products.json` returns 129. Which is right, and what the other 770 are, is unverified.
- A price in the index is the price last seen, from a listing pull, a search, an identifier read or a Google result. The dropdown and the cards show it without saying how old it is beyond `last_seen_at`; a refresh or a live search updates it.
- The model-code rule's false positives flow into the index as `mpn` and into grouping. On add they would become a stored MPN unless confirmed, so the add form of ADR-0016 item 8 must show the model code editable.
- The `search` and `listing` operations are priced free by provider (`retailer`, in `src/lib/api-prices.ts`), the same as `page`. No view tells the three apart.
- The JB Hi-Fi search index matches a GTIN but not a model code; the local index matches both. A second page through predictive search is not available: ten per store per query. The store's `product_type` as a category filter is unverified.
- The gate figures above are from the last local run on 2026-10-08; CI runs on the pull request.

From earlier sessions:

- The public summaries in PUBLIC.md await Rafi's approval, ADR-0014 to 0017 and sessions S-14 to S-17 among them.
- The GitHub repository is public, so the full documents are readable there whatever the build log shows. Whether it stays public is Rafi's decision.
- The build log generator only warns on a shallow clone or a missing data branch. It should fail when deploying; to settle with the Vercel deploy. The `metrics` job keeps one pending run, so three pushes to `main` in quick succession can skip the middle one.
- A row written for a model missing from the price table stores cost 0 and reads as priced once the model is added (ADR-0014 item 14). Fixing it needs a stored `priced` flag or a nullable cost: a schema change, Rafi's decision.
- Nothing automated asserts that `/lab`, `/lab/status` and the server actions return 404 in a production build. The dev-only gate is `NODE_ENV` alone; a dev server bound to all interfaces would be reachable on the local network.
- ADR-0012 and the SerpApi research note still say the free tier is about 100 calls a month; the account endpoint reports 250. Research notes are not edited, so both stand uncorrected.
- Deferred reviewer nits from 2026-10-02: the day-bucket expression is duplicated between `api-usage.ts` and `api-usage-models.ts`; `safeFailureMessage` redacts the whole connection string, not a password quoted on its own; a connection dropped after the ping reads as `unmigrated`; `isFreeProvider` ignores an injected price table.

For Rafi to ratify or reverse:

- The open decisions table in ARCHITECTURE.md section 11. Each becomes an ADR in its phase.
- Sources, 2026-09-28: (1) the `json_ld` source reports Samsung's `sku` as `retailerSku` and leaves `mpn` null, and `quotes` counts a retailer SKU equal to the tracked MPN as a model-code match; (2) page sources assume AUD when the page states no currency, as the listing source does; (3) the SerpApi source records AUD for region `au` and the upper-cased region code elsewhere; (4) a seller link that is not an http URL is kept as given; (5) the availability fallback throws only when every month fails.
- Model reader, 2026-09-28: (6) `gemini-3.5-flash-lite` as the extraction tier, `gemini-3.8-flash` as the escalation; (7) the confidence rule table in ADR-0013 item 3; (8) empty `verifyTokens` rejects every entity in the search source; (9) a hop-1 fallback quote carries confidence 0.5; (10) `extractQuote` keeps the `www` prefix in `retailerName`; (11) a candidate's delta from cheapest can be negative; (12) a null currency from the model counts as not AUD.
- Gap fill, 2026-10-01: (13) any failed or skipped tracked retailer triggers the search; (14) when the search lists a seller more than once, a price before a candidate, then the lowest; (15) a search fill for a listing that is not new is a candidate, never a price.

Other:

- A labelled set for the extractor: Rafi's confirmations in the lab, target fifty pages. None recorded yet.
- Terms of use are unread: SerpApi's against the lab's use, the seven tracked retailers' (pages, search and now listings), and any page the extraction panel reads. Required before scheduled fetching (phase 4).
- Research questions: first five retailers; a non-Samsung model-code check. The S85H model code ends in `AE`, not `AW`, so the per-brand parser must not assume the `W` suffix.
- Whether `.claude/settings.json` hooks (typecheck on edit, tests on stop) are worth their latency.
- Four moderate `npm audit` findings in drizzle-kit's bundled esbuild loader, dev-only, no fix available.
