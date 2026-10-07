# Build map

The registry of what DealZ is made of and the stage each piece is at. The public build log ([ADR-0015](adr/0015-public-build-log.md)) renders this table. `site/scripts/generate.ts` compares it with the code and fails the build when they disagree.

One row per component. A row is added when the component is designed, before it is built. It is never deleted; a removed component is marked `retired`.

## Stages

| Stage | Meaning | Path must exist |
|---|---|---|
| `planned` | Designed and placed in a phase. No code | No |
| `spike` | Code written to learn from, under a proposed ADR or persisting nothing. May be reshaped or removed | Yes |
| `built` | Code on `main`. The definition of done is not yet met | Yes |
| `tested` | Meets the definition of done in the root CLAUDE.md | Yes |
| `shipped` | In use by its intended users | Yes |
| `retired` | Removed | No |

## Components

`Public` says whether the row appears on the build log. A public row's name and path must pass the blocklist in [PUBLIC.md](PUBLIC.md).

| ID | Component | Layer | Path | Phase | Stage | Decisions | Public |
|---|---|---|---|---|---|---|---|
| C-001 | Development conventions and subagents | Tooling | `.claude/agents/` | 0 | shipped | 0011 | yes |
| C-002 | CI gate | Tooling | `.github/workflows/ci.yml` | 0 | shipped | 0011 | yes |
| C-003 | End-to-end journey registry and its check | Tooling | `scripts/check-e2e-coverage.mjs` | 0 | shipped | 0011 | yes |
| C-004 | Schema and triggers | Database | `src/db/schema.ts` | 0 | built | 0004, 0005, 0006, 0007, 0009, 0010, 0017 | yes |
| C-005 | Migrations | Database | `drizzle/migrations/` | 1 | built | 0008 | yes |
| C-006 | Database client | Database | `src/db/client.ts` | 1 | built | 0008 | yes |
| C-007 | Database invariant tests | Database | `src/db/invariants.test.ts` | 1 | built | 0007, 0009, 0014, 0017 | yes |
| C-008 | App scaffold | Adapters | `src/app/layout.tsx` | 1 | built | 0001, 0008 | yes |
| C-009 | Shared pure helpers | Shared | `src/lib/` | 1 | tested | 0004, 0016 | yes |
| C-010 | Sources layer | Sources | `src/sources/` | 1 | spike | 0012, 0013, 0017 | yes |
| C-011 | `quotes` service | Services | `src/services/quotes.ts` | 1 | spike | 0012, 0013 | yes |
| C-012 | Lab page | Adapters | `src/app/lab/` | 1 | spike | 0012, 0016 | no |
| C-013 | `retailers` service | Services | `src/services/retailers.ts` | 1 | planned | 0008, 0016 | yes |
| C-014 | `catalog` service | Services | `src/services/catalog.ts` | 1 | planned | 0004, 0008, 0016 | yes |
| C-015 | `listings` service | Services | `src/services/listings.ts` | 1 | planned | 0005, 0010 | yes |
| C-016 | `observations` service | Services | `src/services/observations.ts` | 1 | planned | 0007, 0009 | yes |
| C-017 | `deals` service | Services | `src/services/deals.ts` | 1 | planned | 0003, 0006 | yes |
| C-018 | Public build log | Site | `site/` | 1 | spike | 0015 | yes |
| C-019 | Admin deal posting | Adapters | `src/app/admin/` | 2 | planned | 0003, 0006 | yes |
| C-020 | Public pages: product, deals feed, search | Adapters | `src/app/(public)/` | 3 | planned | 0001 | yes |
| C-021 | `pricing` service | Services | `src/services/pricing.ts` | 3 | planned | | yes |
| C-022 | Scheduled ingestion and staging | Services | `src/services/ingestion.ts` | 4 | planned | 0010 | yes |
| C-023 | Usage ledger: table, append-only trigger and query helpers | Database | `src/db/queries/` | 1 | tested | 0014 | yes |
| C-024 | `usage` service | Services | `src/services/usage.ts` | 1 | tested | 0014 | yes |
| C-025 | `status` service | Services | `src/services/status.ts` | 1 | tested | 0014 | yes |
| C-026 | Status dashboard | Adapters | `src/app/lab/status/` | 1 | built | 0014 | no |
| C-027 | `discovery` service | Services | `src/services/discovery.ts` | 1 | spike | 0016, 0017 | yes |
| C-028 | Storefront search source | Sources | `src/sources/storefront-search.ts` | 1 | spike | 0012, 0016 | yes |
| C-029 | Catalogue dashboard (folded into the lab page per ADR-0017) | Adapters | `src/app/lab/catalog-search-panel.tsx` | 1 | spike | 0016, 0017 | no |
| C-030 | `catalogue-index` service | Services | `src/services/catalogue-index.ts` | 1 | spike | 0017 | yes |
| C-031 | Storefront listing source | Sources | `src/sources/storefront-listing.ts` | 1 | spike | 0017 | yes |
| C-032 | Catalogue candidate table and search index | Database | `src/db/queries/catalogue-candidates.ts` | 1 | spike | 0010, 0017 | yes |

The paths of planned components are where the component is expected to land. They are corrected when it is built.
