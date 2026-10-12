# Status

Where DealZ is right now. Rewritten at the end of every session and read at the start of the next. What to do next lives on the [GitHub board](https://github.com/users/rafipinc/projects/1), not here (ADR-0018).

**Updated:** 2026-10-08. **Phase:** 1, working database and backend layer. **Step:** the review session's refinements on branch `p1/review-refinements`, uncommitted, awaiting Rafi's acceptance of [ADR-0019](adr/0019-free-sources-first-index-learns-category.md) and a pull request. Next task: the catalog and retailers services, [issue #10](https://github.com/rafipinc/dealZ/issues/10).

## What exists

On `main` up to pull request #7, then on `p1/review-refinements`, all with tests. Sixteen accepted ADRs; ADR-0012, ADR-0013 and ADR-0019 are proposed.

| Area | What | Record |
|---|---|---|
| Database | The schema, migrations `0000` to `0006`, triggers, the PGlite harness and invariant tests for `api_usage`, `catalogue_candidate`, the new checks on `identifier` and `product`, and the migrations. An index row carries DealZ's category, the route it came by, the seller's name and when its product JSON was read | DATA_MODEL.md, ADR-0019 |
| Shared | `gtin` (a placeholder is not a GTIN), `model-code` (one general rule, hyphenated codes read), `category` (`CATEGORIES`, `categoryOf`), `brand` (not yet wired), `relative-age`, and the earlier helpers | ADR-0019 |
| Sources | `json_ld`, `shopify`, `wayback`, SerpApi search and Google Shopping, Gemini extraction, Shopify storefront search and listing. Every call metered. The price search verifies a store by the general model-code rule | ADR-0012, ADR-0013, ADR-0016, ADR-0019 |
| Services | `quotes` with the live-price ladder; `discovery` with the miss-path ladder (index, storefronts, index again, Google Shopping only when still short) and `enrichIndex`, the bounded identifier pass; `catalogue-index` with two seeded collections, `televisions` and `hifi-soundbars`; `usage`; `status`. One tracked variant in a TypeScript table, not yet a row | ADR-0016, ADR-0017, ADR-0019 |
| Lab | `/lab`: product search with the as-you-type index dropdown (category badge, time since seen), grouped product cards with the category, the price panel, "Refresh index" and "Enrich identifiers". `/lab/status`: spend per provider today and month to date, a 30-day calls chart, the last 20 calls, keys and the SerpApi quota. Development only | ADR-0014, ADR-0019 |
| Build log | `site/`, a static export generated from the ADRs and registries. CI writes a metrics snapshot per green push to the `build-log-data` branch. Not deployed | ADR-0015 |
| Process | Six subagents in `.claude/agents/`, the pre-commit registry hook, the GitHub board | ADR-0011, ADR-0018 |

Gate on 2026-10-08: typecheck, lint, 1435 tests in 50 files, 98.55 percent statements and 94.69 percent branches, `db:check`, the e2e coverage check and the build log check, all green. Verified in the browser the same day: the three collections pulled in 3 requests, one enrich pass reading 25 products (24 with a GTIN), the index at 255 products from 2 stores and 31 Google Shopping sellers, no paid call made.

## What does not exist yet

No price is persisted as history. The services `catalog`, `retailers`, `listings`, `observations` and `deals` are the four epics on the board. The index refreshes and enriches by button only. `lib/brand` is wired to nothing. Nothing is deployed.

## Parked

Noted here because they are not engine work and are off the board. Each becomes an issue when it is picked up.

- The build log: page redesign around the stack and the implementation, lint for `site/`, the J-016 spec, the Vercel deploy. The generator should fail, not warn, on a shallow clone once deployed.
- Before the first production migration, both in RUNBOOK.md under "Migrate production": a schema for `pg_trgm` (migration `0005` lands it in `public`), and the Supabase Data API, which exposes every `public` table to the anon key with no row level security. The SerpApi daily cap holds within one Node process only.
- Lighter process, Claude's proposal of 2026-10-08, not yet decided: PUBLIC.md session rows generated from the usage log, ADRs for design choices only, `model: sonnet` on docs-writer, test-engineer, e2e-engineer and routine ts-dev work, and a column for Claude Code spend in the usage log. Stale wording about a single `triggers.sql` in `db-dev.md` and `reviewer.md`.
- The public summaries in PUBLIC.md for ADR-0014 to 0019 and sessions S-14 to S-19 are Claude's drafts awaiting Rafi.
- From the review session (ADR-0019), each waiting on an epic: listing prices as `price_observation` rows for confirmed listings once [issue #12](https://github.com/rafipinc/dealZ/issues/12) lands, zero extra requests; a `retailer_collection` table once issue #10 lands, so a new product type is a row, not code; `normaliseBrand` wired by issue #10 when it writes rows.
- `vacuums` was seeded, then dropped on 2026-10-12 by Rafi: the goal at this stage is a data collection model that works well, not breadth (ADR-0019 item 6). Index rows already pulled stay until the store's next listing refresh removes unseen ones; a re-seed is one entry in `seededCollections`. `tvs-audio` overlaps `televisions` and is not seeded (research note 2026-10-08).
- Known limits, each stated in the code or its ADR: Google Shopping rows carry no GTIN so they merge by model code or title only; the model-code rule's false positives reach the index as `mpn`; `categoryOf` reads "TV wall mount" and "Nintendo Switch OLED Model" as `tv`; `relativeAge` counts elapsed days, not Sydney calendar days; the ledger write is best effort so a failed write undercounts by one call; the price panel's gap fill is counted against the cap but not gated by it; `search`, `listing` and `page` are all priced free under provider `retailer`.
- Reviewer nits from 2026-10-02: the day-bucket expression duplicated in two query files; `safeFailureMessage` redacts the whole connection string; a connection dropped after the ping reads as `unmigrated`; `isFreeProvider` ignores an injected price table.
- Four moderate `npm audit` findings in drizzle-kit's bundled esbuild, dev only, no fix available.
- Whether `.claude/settings.json` hooks are worth their latency. The repo has none today.
