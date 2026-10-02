# Status

Where DealZ is right now. Rewritten at the end of every session and read at the start of the next.

**Updated:** 2026-10-02. **Phase:** 1, working database and backend layer. **Step:** two changes reviewed and landed on 2026-10-02: the usage ledger with its local status dashboard (pull request #4, [ADR-0014](adr/0014-usage-ledger-and-status-dashboard.md)) and the public build log (pull request #5, [ADR-0015](adr/0015-public-build-log.md)). Rafi accepted both ADRs on 2026-10-02.

## What exists

- On `main`: the docs, the schema with migrations `0000_init` and `0001_triggers`, the Next.js scaffold, the conventions of ADR-0011, and the price-fetch spike (pull request #3, merged 2026-10-01). Thirteen accepted ADRs. [ADR-0012](adr/0012-sources-layer-live-fetch-spike.md) and [ADR-0013](adr/0013-llm-extraction-boundaries.md) are still proposed.
- The spike: `src/sources`, the `quotes` service with the live-price ladder (ARCHITECTURE.md section 3.1), one tracked variant in `src/services/tracked-products.ts`, the lab at `/lab`. API keys live in the macOS Keychain (SETUP.md section 2).
- The usage ledger and status dashboard, per ADR-0014:

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

- The public build log, per ADR-0015: the `site/` project, a static Next.js export generated from the ADRs, [BUILD_MAP.md](BUILD_MAP.md) (26 components with their stage), [PUBLIC.md](PUBLIC.md) (the default-deny allowlist: 15 ADRs, 15 sessions, 16 journeys, the blocklist), the journey registry and the commit history. The generator fails the build on a missing allowlist row, a build map that disagrees with the code, or a blocklisted term. CI: a `build-log` job (tests, typecheck, build) and a `metrics` job that appends one snapshot per green push to `main` to `metrics.jsonl` on the `build-log-data` branch. Runs locally with `npm --prefix site run dev` on port 3100. Not deployed. 79 site tests.

- `.githooks/pre-commit` (pull request #6, 2026-10-02), installed by the `prepare` script, runs the journey registry check and the build log check before every commit. It checks rows and never writes them. Proposed by Claude on Rafi's request for a recommendation.

## What does not exist yet

For the build log: the Vercel deploy, pages that show the metrics (the presentation is to be redesigned around the stack and the implementation, Rafi, 2026-10-01), lint for `site/`, a Playwright spec for J-016.

Services `retailers`, `catalog`, `listings`, `observations` and `deals`. PGlite tests for the catalogue constraints and triggers (the matrix in TESTING.md beyond `api_usage`). No price is persisted; the tracked variant is a TypeScript table. The dashboard's data insights section. No budget cap, by Rafi's decision. The extractor's labelled set is empty. Affiliate feeds are not verified and not built.

## Next

One per session unless small:

1. Rafi reads and approves the public summaries in PUBLIC.md, which are Claude's drafts. Check that the first `metrics` run created the `build-log-data` branch.
2. Rafi reviews the lab, ADR-0012 and ADR-0013, and the earlier decisions under Open.
3. The rest of the invariant matrix in `src/db/invariants.test.ts`.
4. Persistence services `retailers`, `catalog`, `listings`, `observations`, so quotes and model-read candidates become rows, staged below the threshold per ADR-0010.
5. The dashboard's data insights section.
6. The build log: redesign of the pages, then lint, the J-016 spec and the Vercel deploy with full commit history.

## Open

From this session:

- The public summaries in PUBLIC.md await Rafi's approval, the two written on 2026-10-02 (ADR-0014, sessions S-14 and S-15) among them.
- The GitHub repository is public, so the full documents are readable there whatever the build log shows. Whether it stays public is Rafi's decision.
- The build log generator only warns on a shallow clone or a missing data branch. It should fail when deploying; to settle with the Vercel deploy.
- The `metrics` job keeps one pending run, so three pushes to `main` in quick succession can skip the middle one.

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
