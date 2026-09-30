# DealZ Architecture

**Status:** accepted 2026-09-17. **Owner:** Rafi. Revisited at the end of each phase.

This is the map. It says what the system is made of, where each kind of code lives, the rules that keep the layers clean, and the order things get built. The reasoning behind each decision is in the [decision records](adr/README.md). The database is explained in [DATA_MODEL.md](DATA_MODEL.md).

## 1. Purpose and constraints

DealZ answers one question: is this a good price for this product, right now? ([Mission](MISSION.md).)

| Constraint | What it does to the design |
|---|---|
| Data quality is the product | Facts are append-only, invariants live in the database, matching never merges on low confidence |
| Portfolio piece first | Every decision is written down; the code has to read well to a stranger |
| Built slowly, one thing per session | Small layers with hard boundaries, so a session can finish something whole |
| Web first, other clients later | Business rules sit behind a service layer; clients stay thin |
| One developer | Boring, well-documented tools; nothing that needs a team to operate |

Non-goals for v1: user accounts beyond one admin, scheduled scrapers (a manual live-fetch lab exists per [ADR-0012](adr/0012-sources-layer-live-fetch-spike.md)), affiliate feeds, currency conversion, bundles, categories beyond consumer tech.

## 2. System overview

```
                     ┌────────────────────────────────────────────────┐
 browser ──────────▶ │  Next.js on Vercel                             │
                     │                                                │
 iOS (later) ──────▶ │   src/app/         pages, server actions,      │
                     │                    REST route handlers /api/v1 │
                     │        │           adapters only               │
                     │        ▼                                       │
                     │   src/services/    business rules              │
                     │        │                                       │
                     │        ▼                                       │
                     │   src/db/          Drizzle schema + queries    │
                     └────────┼───────────────────────────────────────┘
                              ▼
                     Supabase Postgres   (Auth in phase 2, Storage in phase 3)
                              ▲
 ingestion (phase 4) ─────────┘   scheduled job → services, never the database
```

One deployable, one database. When ingestion arrives it is a scheduled job that calls the same services the web app uses.

The sources layer (`src/sources/`, proposed in ADR-0012) sits beside services and is not drawn above. Section 3 describes it.

## 3. Layers and the rules between them

| Layer | Path | Responsibility | May import |
|---|---|---|---|
| Database | `src/db/` | Drizzle schema (source of truth), client, thin typed queries | Drizzle only |
| Services | `src/services/` | Business rules and invariants, as plain functions | `src/db`, `src/lib`, `src/sources` |
| Sources | `src/sources/` | One retailer page, one aggregator query, one archived page or a page read by a model ([ADR-0013](adr/0013-llm-extraction-boundaries.md)) in; `PriceQuote`s out, each with provenance and confidence. HTTP requests and their parsing. Never the database | `src/lib` |
| Adapters | `src/app/` | Pages, server actions, route handlers: parse input, call one service, shape output | `src/services`, `src/lib` |
| Shared | `src/lib/` | Pure helpers: GTIN normalisation, URL canonicalisation, model-code parsing | Nothing internal |

The Sources row comes from [ADR-0012](adr/0012-sources-layer-live-fetch-spike.md), status Proposed, as a phase 1 spike. The model reader is [ADR-0013](adr/0013-llm-extraction-boundaries.md), status Proposed.

1. Nothing outside `src/db` imports Drizzle.
2. Adapters hold no business rules. A route handler and a server action that do the same thing call the same service function.
3. Server components call services directly. They never fetch the app's own REST routes.
4. Every service input is validated with a Zod schema at the boundary. Insert shapes are derived from the Drizzle tables with drizzle-zod, so each shape is defined once.
5. Services throw typed errors (`NotFoundError`, `ConflictError`, `ValidationError`). Adapters map them to HTTP status codes or UI state; nothing else catches them.
6. `src/sources` imports `src/lib` only. Adapters never call a source; they call a service. Every source takes `fetch` as a parameter so tests replay fixtures.

### 3.1 The live-price ladder

`fetchQuotes` reaches a live price by the cheapest route first. Decided by Rafi on 2026-10-01 and recorded in [ADR-0012](adr/0012-sources-layer-live-fetch-spike.md) item 8, status Proposed.

| Layer | Source | Cost | Confidence | When used |
|---|---|---|---|---|
| 1 | The retailer page's structured data: `shopify_json`, `json_ld` | Free | 1 | Always, for every page with a readable source |
| 2 | The model, `llm_extract` ([ADR-0013](adr/0013-llm-extraction-boundaries.md)) | About 0.1 cents a page | 0.3 to 0.7; a candidate below 0.7 | A fetched page carries no structured data |
| 3 | One Google Shopping search through SerpApi | Two calls a search as a rule, at most four; about 3 cents a product refresh on the paid tier | 0.8 entity verified; 0.5 hop-1 fallback, never cheapest | A tracked retailer is still without a price |

The rule: the paid search runs only when there is a gap. A gap is a tracked retailer whose page is not fetched (bot protection) or whose page read failed. The search fills those retailers only; a page that answered keeps its own quote. When every page answers, no search is made. Without a SerpApi key, or when the search fails, the gaps stay and the report says why.

The Wayback Machine is the history source (`fetchHistory`), not a rung of this ladder. Affiliate feeds are the planned long-term route to the chains that block scripted requests. Not verified, not built.

## 4. Services

Phase 1 builds the first five modules. `quotes` is a phase 1 spike per ADR-0012 and ADR-0013 (both proposed). `pricing` is planned for phase 3 and is listed so the mission's core question has a home.

| Module | Phase | Functions | Invariants it owns |
|---|---|---|---|
| `retailers` | 1 | `createRetailer`, `getRetailerBySlug` | Slug and domain are unique; a listing cannot exist without a retailer |
| `catalog` | 1 | `createProduct`, `createVariant`, `addIdentifier`, `resolveVariant` | Slugs are derived and unique; GTINs are normalised to 14 digits and check-digit validated; no merge below tier 2 |
| `listings` | 1 | `upsertListing`, `markSeen`, `deactivate` | Canonical URL has tracking parameters stripped; every listing records its match method |
| `observations` | 1 | `record`, `correct`, `current`, `history` | Append-only; a correction supersedes exactly one observation on the same listing |
| `deals` | 1 | `createDraft`, `publish`, `expire`, `retract`, `listPublished` | Transitions are draft → published → expired or retracted, nothing else; publishing sets `published_at` |
| `quotes` (spike, ADR-0012) | 1 | `fetchQuotes`, `searchQuotes`, `fetchHistory`, `extractQuote` | Never persists; every retailer's outcome reported separately; an outage is a failed outcome, never an empty one; a page with no structured data falls back to the model per ADR-0013, and a quote below the review threshold is a candidate that never wins cheapest; the paid search runs only for a retailer still without a price (section 3.1) |
| `pricing` (planned) | 3 | `verdict`, `summary` | Read-only. Computes position of the current price against the variant's own history and RRP: lowest ever, percentage under the recent median, days since last lower price. Arithmetic over `price_observation` only; never a model and never an external source |

Each module gets a Vitest file next to it. The database invariants those functions rely on are tested separately against PGlite (section 8).

## 5. Data

Four layers and one opinion table. Price history hangs off the variant, the physical SKU, never the family. Facts and opinions never share a row.

| Table | One row is |
|---|---|
| `product` | A family: Samsung S90H OLED, 2026 |
| `variant` | A physical SKU: the 65-inch AU S90H |
| `listing` | One retailer's page for one variant, with a confirmed match and a condition |
| `price_observation` | One price on one listing at one time. Append-only |
| `deal` | An editorial call about one observation |
| `identifier`, `retailer` | Lookup tables for matching and for shops |

[DATA_MODEL.md](DATA_MODEL.md) lists every invariant and the constraint or trigger that enforces it.

## 6. API conventions

Route handlers are added when a consumer needs them, not ahead of time. When they are:

- Versioned path, JSON only, kebab-case resources: `/api/v1/products/{slug}`, `/api/v1/variants/{id}/price-history`, `/api/v1/deals`.
- Reads are public. Writes require an authenticated admin (phase 2).
- Errors use one envelope, `{ "error": { "code": "not_found", "message": "..." } }`, with the matching HTTP status.
- Lists are cursor-paginated: `?cursor=&limit=`.
- OpenAPI is generated from the Zod schemas when the first non-web client appears. It is never maintained by hand.

## 7. Runtime and environment

| Concern | Choice |
|---|---|
| Hosting | Vercel. Preview deployment per pull request, production from `main` |
| Database | One Supabase project for production. Local development on the Supabase CLI stack (Postgres in Docker) |
| Connections | The app uses the transaction pooler with prepared statements off (`DATABASE_URL`). Migrations use the direct connection (`DIRECT_URL`) |
| Secrets | `.env.local` locally, ignored by git. Production values live in Vercel. Nothing is committed |
| Auth (phase 2) | Supabase Auth, one allow-listed admin. Drizzle references `auth.users` but never manages that schema |
| Images (phase 3) | Supabase Storage, public bucket, URL stored on the product |
| Scheduled jobs (phase 4) | A GitHub Actions scheduled workflow running a script that calls the services. Vercel Cron is the fallback if the job needs app context |

## 8. Quality

| Level | Tool | What it covers |
|---|---|---|
| Unit | Vitest | `src/lib` pure functions; service logic with a stubbed db layer; `src/sources` with recorded fixtures replayed through an injected `fetch` |
| Database | Vitest + PGlite | Migrations apply cleanly; every constraint and trigger has a test that tries to break it |
| End-to-end | Playwright (phase 3) | Post a deal, see it on the deals page; open a product, see its history |

- CI on every pull request: `typecheck`, `lint`, `test`, `drizzle-kit check`. Vercel builds a preview.
- Migrations are generated by drizzle-kit and reviewed as SQL. An applied migration is never edited; a mistake gets a new migration. Hand-written SQL (triggers) lives in `src/db/sql/` and is applied through a custom migration.
- Strict TypeScript, ESLint, Prettier. No `any` at layer boundaries.
- The full policy, including the invariant-to-test matrix and the end-to-end journey registry, is in [TESTING.md](TESTING.md). Coverage for end-to-end tests is the registry in [`e2e/JOURNEYS.md`](../e2e/JOURNEYS.md), checked in CI, not a percentage.

## 9. Security

- The database is reachable from server code only. The connection string never reaches the browser.
- Every query is parameterised through Drizzle. Raw SQL is limited to the migration files.
- Later hardening, when there is something to protect: a dedicated application role without DDL rights; row-level security only if browser-direct access is ever allowed.
- Ingestion (phase 4) respects `robots.txt` and rate limits, prefers structured endpoints over HTML, checks retailer terms before a retailer is added, and stores raw responses so a parser fix never needs a refetch.

## 10. Phases

| Phase | Deliverable | Done when |
|---|---|---|
| 0 | Documentation and schema | Docs organised, schema reviewed. This document |
| 1 | Working database and backend layer | App scaffolded, migrations applied locally, services in place, constraint tests green in CI |
| 2 | Admin deal posting | Auth, a server-action flow, a deal can go from draft to published |
| 3 | Public pages | Product page with history chart and price verdict, deals feed, search |
| 4 | Ingestion | One structured-data scraper (JB Hi-Fi's Shopify product JSON), staging table, match audit |
| Later | iOS client, price alerts and watchlists, more categories, more retailers |

Phase 1 also carries a live-fetch spike per [ADR-0012](adr/0012-sources-layer-live-fetch-spike.md) (proposed): a sources layer and a lab page for one tracked variant, persisting nothing. Scheduled fetching stays in phase 4.

## 11. Open decisions

Recorded here so they are not forgotten. Each becomes an ADR when it is made.

| Decision | Needed by | Current recommendation |
|---|---|---|
| Auth provider | Phase 2 | Supabase Auth |
| Component library and charts | Phase 3 | shadcn/ui on Tailwind, Recharts |
| Product search | Phase 3 | Postgres full-text search with a trigram index |
| Scraper runtime | Phase 4 | GitHub Actions scheduled workflow |
| Staging table shape for unmatched pages | Phase 4 | Designed with the first scraper (ADR-0010) |
| Database behind Vercel preview deployments | Phase 2 | The production project while data is hand-entered; a Supabase branch per preview before ingestion |
