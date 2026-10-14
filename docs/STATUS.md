# Status

Where DealZ is right now. Rewritten at the end of every session and read at the start of the next. What to do next lives on the [GitHub board](https://github.com/users/rafipinc/projects/1), not here (ADR-0018).

**Updated:** 2026-10-14. **Phase:** 1, working database and backend layer. **Step:** the model-assisted price history on branch `p1/history-search`, reviewed on 2026-10-14 and merged to `main` by its pull request the same day ([issue #22](https://github.com/rafipinc/dealZ/issues/22) closes with the merge). [ADR-0020](adr/0020-model-assisted-price-history.md) stays Proposed until Rafi accepts it. Next task, chosen by Rafi on 2026-10-14 for a new session, in this order: seller tiers and a condition reader so grey-import and refurbished points draw hollow and stay out of any verdict; the history chart for an untracked product searched by title; a buy signal (green, yellow, red) as a new ADR. Claude's proposal of the tiers and thresholds is in the [research note of 2026-10-14](research/2026-10-14-history-search-four-products.md) and the chat recap; none of it is decided.

## What exists

On `main`, including the `p1/history-search` merge of 2026-10-14, all with tests. Sixteen accepted ADRs; ADR-0012, ADR-0013, ADR-0019 and ADR-0020 are proposed.

| Area | What | Record |
|---|---|---|
| Database | The schema, migrations `0000` to `0006`, triggers, the PGlite harness and invariant tests for `api_usage`, `catalogue_candidate`, the checks on `identifier` and `product`, and the migrations. An index row carries DealZ's category, the route it came by, the seller's name and when its product JSON was read | DATA_MODEL.md, ADR-0019 |
| Shared | `history-evidence` (finds the quoted fragment in a page, dates a point from the page or its URL, assigns confidence by rules), `gtin`, `model-code`, `category`, `brand` (not yet wired), `relative-age`, and the earlier helpers | ADR-0019, ADR-0020 |
| Sources | `openai`, the only file that knows the Responses API; `history_search`, which asks the model for dated price pages on an allow-list of domains (StaticICE excluded by its terms) and verifies every claim on its page; `json_ld`, `shopify`, `wayback`, SerpApi search and Google Shopping, Gemini extraction, Shopify storefront search and listing. Every call metered. Three new fixtures recorded live: an OpenAI response, a JB Hi-Fi catalogue page, an OzBargain post | ADR-0012, ADR-0013, ADR-0016, ADR-0019, ADR-0020 |
| Services | `quotes`: the live-price ladder, and `fetchHistory` running the archive and the model search together under `OPENAI_DAILY_CAP` (default 10), the model skipped when there is no key, the cap is 0 or reached, or the ledger cannot be read; `daily-cap`, the cap reading shared by `discovery` and `quotes`; `discovery` with the miss-path ladder and `enrichIndex`; `catalogue-index` with `televisions` and `hifi-soundbars` seeded; `usage`, now pricing OpenAI (tokens, USD 10 per 1,000 searches, page opens free); `status`. One tracked variant in a TypeScript table, not yet a row | ADR-0016, ADR-0017, ADR-0019, ADR-0020 |
| Lab | `/lab`: product search with the as-you-type index dropdown, grouped product cards, the price panel, "Refresh index", "Enrich identifiers", and the history panel, which draws archive captures as circles and verified model-found points as squares, one link per point, and lists the other claims with their verdict and reason. `/lab/status`: spend per provider today and month to date, a 30-day calls chart, the last 20 calls, keys and the SerpApi quota. Development only | ADR-0014, ADR-0019, ADR-0020 |
| Build log | `site/`, a static export generated from the ADRs and registries. CI writes a metrics snapshot per green push to the `build-log-data` branch. Not deployed | ADR-0015 |
| Process | Six subagents in `.claude/agents/`, the pre-commit registry hook, the GitHub board | ADR-0011, ADR-0018 |

Gate on 2026-10-14: typecheck, lint, 1620 tests in 55 files, `db:check` and the e2e coverage check with J-020 registered, all green. Verified in the browser the same day: the archive drew 14 points across 5 retailers; the model made 2 searches and 2 page opens and returned 3 JB Hi-Fi catalogue points verified from their URLs (2,495 on 05-28, 2,795 on 07-02 and 09-03) and one unverified claim. A scratch run the same day across four products is in the [research note of 2026-10-14](research/2026-10-14-history-search-four-products.md): nine verified deal-post points for a phone, nothing for two TVs and a console, USD 0.12 in all.

## What does not exist yet

No price is persisted as history; a model-found point is verified, drawn and forgotten. The services `catalog`, `retailers`, `listings`, `observations` and `deals` are the four epics on the board. The index refreshes and enriches by button only. `lib/brand` is wired to nothing. Nothing is deployed.

## Parked

Noted here because they are not engine work and are off the board. Each becomes an issue when it is picked up.

- The model's recall varies run to run on the same product: 4 catalogue claims in the probe, 1 press claim on 2026-10-13, 0 then 3 catalogue claims within an hour on 2026-10-14. The archive varies too: 4 then 2 captures of the same page. Persistence under [issue #12](https://github.com/rafipinc/dealZ/issues/12) answers it, with a labelled set for the verifier (the research note's 18 manual points, the 4 probe points, the 9 phone points of 2026-10-14).
- From the 2026-10-14 run, Claude's proposals, undecided: steer the prompt to dated deal posts rather than the deal site's undated product listing page, which produced every non-verified claim; raise the 12-claim cap, which the phone hit, at the cost of one page fetch per claim.
- Retailer terms gate any scheduled history run ([issue #13](https://github.com/rafipinc/dealZ/issues/13)): the JB Hi-Fi catalogue terms are unread; StaticICE is out by its disclaimer.
- The build log: page redesign around the stack and the implementation, lint for `site/`, the J-016 spec, the Vercel deploy. The generator should fail, not warn, on a shallow clone once deployed.
- Before the first production migration, both in RUNBOOK.md under "Migrate production": a schema for `pg_trgm` (migration `0005` lands it in `public`), and the Supabase Data API, which exposes every `public` table to the anon key with no row level security. The SerpApi and OpenAI daily caps hold within one Node process only.
- Lighter process, Claude's proposal of 2026-10-08, not yet decided: PUBLIC.md session rows generated from the usage log, ADRs for design choices only, `model: sonnet` on docs-writer, test-engineer, e2e-engineer and routine ts-dev work, and a column for Claude Code spend in the usage log. Stale wording about a single `triggers.sql` in `db-dev.md` and `reviewer.md`.
- The public summaries in PUBLIC.md for ADR-0014 to 0020 and sessions S-14 to S-21 are Claude's drafts awaiting Rafi.
- From the review session (ADR-0019), each waiting on an epic: listing prices as `price_observation` rows for confirmed listings once issue #12 lands, zero extra requests; a `retailer_collection` table once issue #10 lands, so a new product type is a row, not code; `normaliseBrand` wired by issue #10 when it writes rows.
- `vacuums` was seeded, then dropped on 2026-10-12 by Rafi: the goal at this stage is a data collection model that works well, not breadth (ADR-0019 item 6). A re-seed is one entry in `seededCollections`. `tvs-audio` overlaps `televisions` and is not seeded (research note 2026-10-08).
- Known limits, each stated in the code or its ADR: Google Shopping rows carry no GTIN so they merge by model code or title only; the model-code rule's false positives reach the index as `mpn`; `categoryOf` reads "TV wall mount" and "Nintendo Switch OLED Model" as `tv`; `relativeAge` counts elapsed days, not Sydney calendar days; the ledger write is best effort so a failed write undercounts by one call; the price panel's gap fill is counted against the cap but not gated by it; `search`, `listing` and `page` are all priced free under provider `retailer`.
- Reviewer nits from 2026-10-02: the day-bucket expression duplicated in two query files; `safeFailureMessage` redacts the whole connection string; a connection dropped after the ping reads as `unmigrated`; `isFreeProvider` ignores an injected price table.
- Four moderate `npm audit` findings in drizzle-kit's bundled esbuild, dev only, no fix available.
- Whether `.claude/settings.json` hooks are worth their latency. The repo has none today.
