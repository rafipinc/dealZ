# Status

Where DealZ is right now. Rewritten at the end of every session and read at the start of the next.

**Updated:** 2026-10-02. **Phase:** 1, working database and backend layer. **Step:** usage ledger and local status dashboard on branch `p1/usage-dashboard`, built ahead of the queue by Rafi's decision, reviewed and in a pull request. [ADR-0014](adr/0014-usage-ledger-and-status-dashboard.md) accepted by Rafi on 2026-10-02. The public build log on `p1/build-log` lands next as ADR-0015.

## What exists

- On `main`: the docs, the schema with migrations `0000_init` and `0001_triggers`, the Next.js scaffold, the conventions of ADR-0011, and the price-fetch spike (pull request #3, merged 2026-10-01). Twelve accepted ADRs with this branch. [ADR-0012](adr/0012-sources-layer-live-fetch-spike.md) and [ADR-0013](adr/0013-llm-extraction-boundaries.md) are still proposed.
- The spike: `src/sources`, the `quotes` service with the live-price ladder (ARCHITECTURE.md section 3.1), one tracked variant in `src/services/tracked-products.ts`, the lab at `/lab`. API keys live in the macOS Keychain (SETUP.md section 2).
- On this branch, per ADR-0014:

| Layer | What |
|---|---|
| db | Table `api_usage`, append-only, one row per outbound call. Migrations `0002_api-usage` and `0003_api-usage-triggers`, applied locally. `src/db/sql/api-usage-triggers.sql`. Query helpers in `src/db/queries/` (`api-usage`, `api-usage-models`, `health`). The PGlite harness `src/db/test-db.ts`. `src/db/invariants.test.ts`, covering `api_usage` and the migrations only |
| sources | An optional injected `meter`, one `SourceCall` per HTTP request, never a URL or a key. `fetchSerpApiAccount` |
| lib | `api-prices` (dated price table), `day-ranges`, `usage-format`, `usage-chart`, `status-view`, `usage-view`, `redact`, `timeout`, `local-only` |
| services | `usage` (`record`, `summary`, `daily`, `recentCalls`, `lastOk`, `dashboard`), `status` (`checkServices`), `usage-ledger`, `default-db`. `quotes` and `status` record every call, best effort, waiting at most 2 seconds |
| app | `/lab/status`: Services and Usage, all times in Australia/Sydney. It and `/lab` with its four server actions are served only when `NODE_ENV` is `development`. J-014 and J-015 stay planned (note in the registry) |

- Rafi delegated the open design decisions of the first build to Claude on 2026-10-01. They are applied and listed as "delegated" in ADR-0014 items 11 to 20, accepted with the record on 2026-10-02. ESLint now ignores `.claude/**`.
- The gate is green on 2026-10-02: typecheck, lint, 893 tests in 36 files, about 99.9 percent lines and 95 percent branches, `db:check`, the e2e coverage check.
- Verified in the browser on 2026-10-01 against the local database: the page renders, all times in Sydney, database reachable with 4 of 4 migrations, both keys set, SerpApi Free Plan with 6 of 250 searches used. The ledger holds 146 Wayback rows and 4 account rows. The Wayback rows show the CDX index failing (14 of 14 calls) and the availability fallback carrying the run.
- The reviewer ran twice on 2026-10-01 and once more, independently, on 2026-10-02: no blockers. Fixed on 2026-10-02, each with a failing test first: "last successful call" no longer counts the status check's own account call, and a ledger flushed twice writes each call once. Deferred nits: the day-bucket expression is duplicated between `api-usage.ts` and `api-usage-models.ts`; `safeFailureMessage` redacts the whole connection string, not a password quoted on its own; a connection dropped after the ping reads as `unmigrated`; `isFreeProvider` ignores an injected price table.

## What does not exist yet

Services `retailers`, `catalog`, `listings`, `observations` and `deals`. PGlite tests for the catalogue constraints and triggers (the matrix in TESTING.md beyond `api_usage`). No price is persisted; the tracked variant is a TypeScript table. The dashboard's data insights section. No budget cap, by Rafi's decision. The extractor's labelled set is empty. Affiliate feeds are not verified and not built.

## Next

One per session unless small:

1. Merge this pull request, then land the public build log (`p1/build-log`) as ADR-0015 and J-016, with its registry rows for this work.
2. Rafi reviews the lab, ADR-0012 and ADR-0013, and the earlier decisions under Open.
3. The rest of the invariant matrix in `src/db/invariants.test.ts`.
4. Persistence services `retailers`, `catalog`, `listings`, `observations`, so quotes and model-read candidates become rows, staged below the threshold per ADR-0010.
5. The dashboard's data insights section.

## Open

From this session:

- A row written for a model missing from the price table stores cost 0 and reads as priced once the model is added (ADR-0014 item 14 and its consequences). Fixing it needs a stored `priced` flag or a nullable cost: a schema change, Rafi's decision.
- Nothing automated asserts that `/lab`, `/lab/status` and the server actions return 404 in a production build. A Playwright spec could; none exists yet.
- The dev-only gate is `NODE_ENV` alone. A dev server bound to all interfaces would be reachable on the local network.
- No priced call is verified live: no SerpApi search or Gemini call was made after the ledger existed.
- ADR-0012 and the SerpApi research note still say the free tier is about 100 calls a month. The account endpoint reports 250. The research note on the model experiment still calls the Gemini prices introductory; they were confirmed on 2026-10-01 and are dated in `src/lib/api-prices.ts`. Research notes are not edited (docs/README.md), so both stand uncorrected.

From earlier sessions, for Rafi to ratify or reverse:

- The open decisions table in ARCHITECTURE.md section 11. Each becomes an ADR in its phase.
- Sources, 2026-09-28: (1) the `json_ld` source reports Samsung's `sku` as `retailerSku` and leaves `mpn` null, and `quotes` counts a retailer SKU equal to the tracked MPN as a model-code match; (2) page sources assume AUD when the page states no currency; (3) the SerpApi source records AUD for region `au` and the upper-cased region code elsewhere; (4) a seller link that is not an http URL is kept as given; (5) the availability fallback throws only when every month fails.
- Model reader, 2026-09-28: (6) `gemini-3.5-flash-lite` as the extraction tier, `gemini-3.8-flash` as the escalation; (7) the confidence rule table in ADR-0013 item 3; (8) empty `verifyTokens` rejects every entity in the search source; (9) a hop-1 fallback quote carries confidence 0.5; (10) `extractQuote` keeps the `www` prefix in `retailerName`; (11) a candidate's delta from cheapest can be negative; (12) a null currency from the model counts as not AUD.
- Gap fill, 2026-10-01: (13) any failed or skipped tracked retailer triggers the search; (14) when the search lists a seller more than once, a price before a candidate, then the lowest; (15) a search fill for a listing that is not new is a candidate, never a price.

Other:

- A labelled set for the extractor: Rafi's confirmations in the lab, target fifty pages. None recorded yet.
- Terms of use are unread: SerpApi's against the lab's use, the seven tracked retailers', and any page the extraction panel reads. Required before scheduled fetching (phase 4).
- Research questions: first five retailers; a non-Samsung model-code check. The S85H model code ends in `AE`, not `AW`, so the per-brand parser must not assume the `W` suffix.
- Whether `.claude/settings.json` hooks (typecheck on edit, tests on stop) are worth their latency.
- Four moderate `npm audit` findings in drizzle-kit's bundled esbuild loader, dev-only, no fix available.
