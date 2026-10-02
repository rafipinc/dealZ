# Testing

How DealZ is tested, where each kind of test lives, and what "covered" means. This is the policy. ARCHITECTURE.md section 8 is the summary and the root CLAUDE.md's definition of done applies it per change.

## Levels

| Level | Tool | Lives in | Covers | Runs |
|---|---|---|---|---|
| Unit | Vitest | `src/lib/*.test.ts`, `src/services/*.test.ts`, `src/sources/*.test.ts` | Pure helpers, the status page's view strings among them; service rules with the db layer stubbed; sources replaying recorded fixtures, fetch injected | Every push, under a second |
| Database | Vitest and PGlite | `src/db/invariants.test.ts`, `src/db/queries/*.test.ts` | Migrations apply cleanly; every constraint and trigger; query helpers against real Postgres semantics | Every push, seconds |
| Integration | Vitest and PGlite | `src/services/*.integration.test.ts` | Service functions against the real schema where a stub would hide a bug: uniqueness, supersession, status transitions | Every push |
| End-to-end | Playwright | `e2e/*.spec.ts` | User journeys through the real app and a real Postgres, registered in [`e2e/JOURNEYS.md`](../e2e/JOURNEYS.md) | Every pull request, minutes |

PGlite runs Postgres in-process, so database tests need no Docker in CI. The end-to-end job uses a Postgres service container.

## Rules

1. **Every invariant has a breaking test.** The invariants table in DATA_MODEL.md and the matrix below match one to one. Each test tries to break the rule and asserts the named error.
2. **Every service function has unit tests** for the happy path and each typed error it can throw. A state machine (deal status) has a test per allowed transition and one proving a disallowed transition throws.
3. **Every user-facing journey is registered before it is built** and has a spec once it ships. Coverage is the registry, checked by `scripts/check-e2e-coverage.mjs`, not a percentage. Playwright line coverage is not measured.
4. **A bug fix starts with a failing test**, committed in the same change as the fix.
5. **Tests are deterministic.** No wall-clock dependence, no network, no shared mutable state between files. Time is injected where it matters (`observedAt`, `publishedAt`).
6. **Coverage thresholds** on `src/lib`, `src/services` and `src/sources`: 90 percent lines and branches, enforced by Vitest in CI. `src/app`, `src/db/schema.ts` and `src/sources/fixtures/` are excluded from the threshold. Adapters are covered by end-to-end tests, the schema by the invariant tests.
7. **Tests never weaken a constraint to pass.** If a test cannot be written without an UPDATE on `price_observation`, the test is wrong.

## Invariant to test matrix

Phase 1 writes these. The `api_usage` rows and the migrations row are written (2026-10-01); the rest are planned. Test names are the sentences the `it()` blocks use.

| Invariant | Enforced by | Tests |
|---|---|---|
| Observations are never updated or deleted | trigger `price_observation_append_only` | rejects UPDATE on price_observation; rejects DELETE on price_observation |
| A correction supersedes an observation on the same listing | trigger `price_observation_supersedes_same_listing` | rejects a correction that points at another listing's observation |
| A GTIN or MPN belongs to at most one variant | unique `identifier_type_value_retailer_uq` | rejects a second variant claiming the same GTIN; rejects the same MPN twice with a null retailer |
| GTINs are 14 digits | check `identifier_gtin_is_14_digits` | rejects a 13-digit GTIN |
| Retailer SKUs carry a retailer, global identifiers do not | check `identifier_retailer_only_for_sku` | rejects a GTIN with a retailer_id; rejects a retailer_sku without one |
| One listing per retailer page | unique `listing_retailer_url_uq` | rejects a duplicate canonical_url at one retailer |
| Product families are unique by brand, series, year | unique `product_brand_series_year_uq` | rejects two products with the same brand and series and a null year |
| Variant slugs are unique within a product | unique `variant_product_slug_uq` | rejects a duplicate variant slug in one product; allows the same slug in another product |
| Slugs are URL-safe; regions and currencies are ISO codes | check constraints | rejects a slug with spaces; rejects a lowercase region; rejects a two-letter currency |
| Confidence values lie in 0..1; prices and RRPs are non-negative | check constraints | rejects confidence 1.5; rejects a negative price; rejects a negative RRP |
| A published deal has a `published_at` | check `deal_published_has_timestamp` | rejects status published with a null published_at |
| `updated_at` is always current | trigger `set_updated_at` | moves updated_at when a product name changes |
| History cannot be orphaned | `ON DELETE RESTRICT` from listing down to deal | rejects deleting a listing that has observations; rejects deleting an observation that has a deal |
| Usage ledger rows are never updated or deleted | trigger `api_usage_append_only` | rejects UPDATE on api_usage; rejects DELETE on api_usage |
| A usage provider is a slug | check `api_usage_provider_format` | rejects a provider that is not a slug |
| A call outcome is `ok` or `failed` | enum `api_call_outcome` | rejects an outcome outside the enum |
| A failed call names its error kind, an ok call has none | check `api_usage_error_kind_only_when_failed` | rejects a failed call with no error_kind; rejects an ok call with an error_kind |
| Call durations, token counts and costs are non-negative | checks `api_usage_duration_non_negative`, `api_usage_input_tokens_non_negative`, `api_usage_output_tokens_non_negative`, `api_usage_cost_non_negative` | rejects a negative duration; rejects negative input tokens; rejects negative output tokens; rejects a negative cost |
| Migrations apply cleanly | drizzle migrator | applies drizzle/migrations to an empty PGlite without error |

## Service tests, phase 1

| Module | Must cover |
|---|---|
| `catalog` | slug derivation and collision; GTIN normalisation to 14 digits and check-digit rejection; `resolveVariant` reports the tier used and never merges below tier 2 |
| `listings` | tracking parameters stripped before the uniqueness check; `match_method` recorded; `markSeen` moves `last_seen_at` only |
| `observations` | `record` inserts; `correct` sets `supersedes_id` and rejects a cross-listing target; `current` excludes superseded rows; `history` is newest first |
| `deals` | each allowed transition; each disallowed transition throws `ConflictError`; `publish` sets `published_at`; `retract` leaves observations untouched |
| `lib` | `gtin`, `url`, `money`, `slug`, `json-ld`, `page-text`, and for the usage ledger (ADR-0014, proposed) `api-prices`, `day-ranges`, `usage-format`, `usage-chart`, `status-view`, `usage-view`, `redact`, `timeout`, `local-only`: pure, table-driven, one row per input and expected output. `api-prices`: an unknown model or provider is unpriced at zero; a missing, negative or non-finite token count is zero; the result is a whole number; a call is priced by the entry in force when it started, whatever the order of the table; a SerpApi search is charged only when it succeeds, the Account API and failed calls never; a failed Gemini call is still priced by the tokens it reported. `usage-view`: an unpriced call is shown as unpriced, never as zero or free, and a total that includes one is a lower bound; times are printed in the dashboard's zone. `redact`: every occurrence of every secret is replaced, the longer of two overlapping secrets whole, a secret treated as text and not a pattern. `day-ranges`: Sydney's day and month to date, not UTC's; a 23 hour and a 25 hour day at the daylight-saving changes; the last days of a zone, oldest first. `timeout`: the bound rejects with `TimeoutError`, the timer is cleared, a late settlement is ignored. `local-only`: true for `development` and for nothing else. `page-text`: entities decoded, script and style dropped, the trim keeps the head of the page and a window around every price mark, including a price written with an entity |
| `quotes` (spike, ADR-0012 and ADR-0013) | `fetchQuotes`: each retailer outcome reported separately; a `SourceError` of each kind becomes a failed outcome, never a throw; a page with `source: null` is reported as skipped; cheapest and delta arithmetic; an unparseable page with a Gemini key set is read by the model and reported `readByModel`, without a key the failure stands; a quote below `REVIEW_THRESHOLD` is `needsReview` and never wins cheapest. Gap fill (ARCHITECTURE.md section 3.1): one search fills the retailers whose pages were not fetched or failed, and the outcome says why the page was not read; no search when every page answers; no search and the gaps left when no key is set; the key read from `SERPAPI_API_KEY` when the argument is absent; a retailer the search does not list stays as it was; a failed search leaves the gaps and is reported; a below-threshold fill never wins cheapest. `extractQuote`: a bad URL and a missing key throw `ValidationError`; a source failure becomes a failed outcome, never a throw; the variant is matched by GTIN, then MPN, otherwise none. `searchQuotes`: a missing key throws `ValidationError`; a source failure becomes a failed outcome, never a throw; a seller is matched to a tracked retailer by slug or alias, otherwise reported as new. `fetchHistory`: points oldest first; captures found but none fetchable becomes a failed page, never an empty history; skipped captures listed with their kind. Usage recording (ADR-0014, proposed), for all four functions: one ledger record per request, with the variant slug; a ledger that cannot be written leaves the report unchanged and `usage.recorded` below `usage.calls`; the wait for the ledger is 2 seconds and no longer; `usage.record` is the default recorder |
| `usage` (ADR-0014, proposed) | Unit: a malformed call, a period with `from` not before `to` and a `recentCalls` limit out of range each throw `ValidationError`. Integration against PGlite (`usage.integration.test.ts`): `record` stores the estimated cost and reports an unknown model as unpriced at zero; a failed call keeps its error kind and status; a `SourceCall` is accepted as the meter reports it; a database failure propagates. `summary` totals per provider and overall, includes `from`, excludes `to`. `daily` buckets by the days of the zone it is given, oldest first, and rejects an unknown zone. Unpriced calls are counted per provider and per day, decided from the price table at read time. `dashboard` returns today, month to date, the daily window, recent calls and last ok in one zone. `recentCalls` is newest first. `lastOk` leaves out a pair that never answered. An UPDATE of a recorded call is still rejected |
| `status` (ADR-0014, proposed) | `checkServices`: everything healthy; a key's value is never returned; a blank key is not set and SerpApi is not asked; a database behind the journal is not up to date; an unreachable database is reported with the connection string redacted; a database that never answers is unreachable after 3 seconds; one that answers but was never migrated is `unmigrated`; a SerpApi refusal or network failure is a status without the key; every check failing at once is reported field by field; the Account call is recorded in the ledger, and skipped as not recorded when the database is unreachable |
| `usage-ledger` (ADR-0014, proposed) | Nothing is written until `flush`, then every collected call with the variant; only confirmed writes are counted, whether the recorder rejects or throws; the wait is 2 seconds and no longer; `abandon` counts the calls and writes none |
| `sources` (spike, ADR-0012 and ADR-0013) | each strategy against its recorded fixture; blocked (challenge page and 403), non-2xx, unparseable and network failures each throw `SourceError` with the right kind; GTIN normalised to 14 digits; URL canonicalised. `serpapi`: both hops against recorded, redacted fixtures; the key never appears in a URL or message; items without a price are skipped. `gemini`: the key travels in a request header only, never in a URL, an error message or `raw`; each HTTP failure kind throws `SourceError`. `llm_extract`: one test per confidence rule; evidence not found in the trimmed text caps the score; a response with no price throws `unparseable`. `wayback`: CDX index first, availability endpoint as fallback; snapshots fetched with the `id_` flag; at most three requests in flight; skipped captures reported with their kind. Metering (ADR-0014, proposed): `meter` reports one `SourceCall` per request with start, duration, outcome, error kind and status, and does nothing without a meter; every source returns its result when the meter throws; no call carries a URL or a key; a SerpApi error in a 200 body is a failed call; Gemini thinking tokens count as output; a snapshot skipped without a request reports nothing. `fetchSerpApiAccount`: reads the plan and what is left from a redacted fixture, keeps neither the key nor the account's email, and throws `SourceError` by kind |

## End-to-end

- The registry [`e2e/JOURNEYS.md`](../e2e/JOURNEYS.md) is the definition of coverage. A journey is added when its feature is designed, becomes `required` when the feature ships, and `covered` when its spec is green in CI.
- CI fails when a `required` or `covered` journey has no spec, when a spec has no registry row, when a `planned` journey has a spec, or when a spec fails.
- Specs seed through services (`e2e/fixtures/`), reset with `TRUNCATE ... CASCADE`, use role-based locators, and assert what a user sees. [`e2e/CLAUDE.md`](../e2e/CLAUDE.md) is the checklist.
- Locally: `npm run test:e2e` against the Supabase CLI stack, with `playwright.config.ts` starting `npm start` or reusing a running `next dev`. In CI: Postgres service container, migrations, `next build`, Playwright, HTML report uploaded as an artifact.
- Accessibility checks are not in scope for v1. When the public pages land (phase 3), `@axe-core/playwright` on J-007 and J-008 is the first candidate, recorded as an ADR if it becomes a general rule.

## Commands

| Command | What |
|---|---|
| `npm test` | Unit, database and integration tests, with coverage thresholds |
| `npm run test:db` | Database tests only |
| `npm run test:e2e` | Playwright |
| `node scripts/check-e2e-coverage.mjs` | Registry against spec files |
| `npm run typecheck && npm run lint && npm test && npm run db:check` | The CI gate |

## The build log, `site/`

A separate project with its own tests (ADR-0015). The root Vitest run does not include them.

- `npm --prefix site test`: unit tests for the parsers, the renderer and the assembler in `site/lib`. Every parser has its happy path and each `ParseError`. Every allowlist rule has a test that tries to publish something it should not.
- `npm --prefix site run check`: runs the generator against the real documents and writes nothing. It fails on a missing allowlist row, a build map that disagrees with the code, or a blocklisted term.
- CI runs both, then the typecheck and the static build, in the `build-log` job.
- `npm test` at the root also writes `coverage/test-results.json` and `coverage/coverage-summary.json`. On a push to `main` the `metrics` job reads them and appends one snapshot to `metrics.jsonl` on the `build-log-data` branch.
- Planned: lint for `site/`, and a Playwright spec for journey J-016.

## What CI runs

`.github/workflows/ci.yml`, on every pull request and on `main`:

1. `check`: install, typecheck, lint, tests with coverage thresholds, `drizzle-kit check`, the e2e coverage script.
2. `docs`: every relative Markdown link and fragment resolves.
3. `e2e`: Postgres service, migrations, build, Playwright. Skipped while `e2e/` has no spec files.

Vercel builds a preview per pull request independently of CI.
