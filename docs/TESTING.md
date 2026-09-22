# Testing

How DealZ is tested, where each kind of test lives, and what "covered" means. This is the policy. ARCHITECTURE.md section 8 is the summary and the root CLAUDE.md's definition of done applies it per change.

## Levels

| Level | Tool | Lives in | Covers | Runs |
|---|---|---|---|---|
| Unit | Vitest | `src/lib/*.test.ts`, `src/services/*.test.ts` | Pure helpers; service rules with the db layer stubbed | Every push, under a second |
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
6. **Coverage thresholds** on `src/lib` and `src/services`: 90 percent lines and branches, enforced by Vitest in CI. `src/app` and `src/db/schema.ts` are excluded from the threshold. Adapters are covered by end-to-end tests, the schema by the invariant tests.
7. **Tests never weaken a constraint to pass.** If a test cannot be written without an UPDATE on `price_observation`, the test is wrong.

## Invariant to test matrix

Phase 1 writes these. Test names are the sentences the `it()` blocks use.

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
| Migrations apply cleanly | drizzle migrator | applies drizzle/migrations to an empty PGlite without error |

## Service tests, phase 1

| Module | Must cover |
|---|---|
| `catalog` | slug derivation and collision; GTIN normalisation to 14 digits and check-digit rejection; `resolveVariant` reports the tier used and never merges below tier 2 |
| `listings` | tracking parameters stripped before the uniqueness check; `match_method` recorded; `markSeen` moves `last_seen_at` only |
| `observations` | `record` inserts; `correct` sets `supersedes_id` and rejects a cross-listing target; `current` excludes superseded rows; `history` is newest first |
| `deals` | each allowed transition; each disallowed transition throws `ConflictError`; `publish` sets `published_at`; `retract` leaves observations untouched |

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

## What CI runs

`.github/workflows/ci.yml`, on every pull request and on `main`:

1. `check`: install, typecheck, lint, tests with coverage thresholds, `drizzle-kit check`, the e2e coverage script.
2. `docs`: every relative Markdown link and fragment resolves.
3. `e2e`: Postgres service, migrations, build, Playwright. Skipped while `e2e/` has no spec files.

Vercel builds a preview per pull request independently of CI.
