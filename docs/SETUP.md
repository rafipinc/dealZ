# Setup

How to get the database and backend layer running locally. This is phase 1 of [ARCHITECTURE.md](ARCHITECTURE.md).

Stack: Next.js (App Router, TypeScript), Supabase Postgres, Drizzle ORM, drizzle-kit for migrations.

## Prerequisites

- Node 22 LTS and npm
- Docker (Desktop or Colima; see section 2), for the local Supabase stack
- The Supabase CLI, run through `npx supabase`
- A Supabase account. Create the production project when it is first deployed, not before
- GitHub over SSH. The remote is `git@github.com:rafipinc/dealZ.git`. The GitHub CLI's HTTPS token lacks the `workflow` scope, so a push that touches `.github/workflows/` is refused over HTTPS. The CLI is also registered as git's HTTPS credential helper (`gh auth setup-git`, 2026-09-22), which is harmless while the remote is SSH

## Repo layout

```
src/
  db/
    schema.ts          # single source of truth for the database
    sql/triggers.sql   # hand-written Postgres behaviour, applied through a custom migration
    client.ts          # drizzle(postgres) instance, server-only
    queries/           # thin, typed read/write helpers
  services/            # business rules; the only callers of src/db
  sources/             # one retailer page, aggregator query or archived page in; PriceQuotes out (ADR-0012)
  lib/                 # pure helpers: gtin, url, model-code parsing
  app/                 # pages, server actions, api/v1 route handlers
drizzle/
  migrations/          # generated SQL and custom migrations, committed
supabase/              # local stack config from `supabase init`; its migrations folder stays empty
scripts/
  keys.sh              # API keys in and out of the macOS Keychain (section 2, "API keys")
  check-e2e-coverage.mjs
docs/
```

## 1. Git and scaffold

`create-next-app` refuses a directory that already has files in it, so scaffold into a temporary folder and copy the result over.

```bash
git init
npx create-next-app@latest /tmp/dealz-scaffold --yes --typescript --app --src-dir --eslint --tailwind --disable-git --use-npm --skip-install
rsync -a --exclude README.md --exclude CLAUDE.md --exclude AGENTS.md --exclude .gitignore /tmp/dealz-scaffold/ ./
cp /tmp/dealz-scaffold/AGENTS.md ./AGENTS.md
npm install
npm i -D @types/node@^22        # the scaffold pins 20; Vitest wants types matching the Node 22 runtime
npm i drizzle-orm postgres zod drizzle-zod
npm i -D drizzle-kit vitest @vitest/coverage-v8 @electric-sql/pglite prettier
# phase 3, with the first public page: npm i -D @playwright/test && npx playwright install chromium
```

Done on 2026-09-22. Notes from doing it:

- The scaffold writes its own `CLAUDE.md` (one line, `@AGENTS.md`) and `AGENTS.md`. Ours must not be overwritten, hence the excludes. `AGENTS.md` is kept: `next dev` upserts a managed block into it, and while it exists `CLAUDE.md` is left alone. The block tells an agent to read the docs bundled at `node_modules/next/dist/docs/` for this exact Next.js version.
- The scaffold's `.gitignore` entries were merged into the project one by hand.
- Tailwind comes with the scaffold because removing it later costs more than ignoring it until phase 3.
- `npm audit` reports four moderate findings, all one esbuild issue inside drizzle-kit's bundled loader. Dev-only, no fix without a major downgrade. Accepted until drizzle-kit ships a fix.

## 2. Local database

```bash
npx supabase init    # writes supabase/config.toml
npx supabase start   # Postgres on 54322, Studio on http://127.0.0.1:54323
```

Done on 2026-09-22. Notes from doing it:

- Docker on Rafi's machine is Colima, not Docker Desktop. `colima start` first. The stack's analytics log shipper mounts the Docker socket, which Colima cannot provide, so `[analytics] enabled = false` is set in `supabase/config.toml`. Nothing in DealZ reads analytics.
- `supabase/config.toml` and `supabase/.gitignore` are committed. `supabase/.temp` is not.
- Supabase's own `supabase/migrations/` and `seed.sql` stay empty on purpose; Drizzle owns the schema. So `npx supabase db reset` rebuilds an empty database, and `npx drizzle-kit migrate` must be run again afterwards.
- The database container is `supabase_db_DealZ`. For a quick query without installing psql: `docker exec -i supabase_db_DealZ psql -U postgres`.

Create `.env.local` (ignored by git):

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
DIRECT_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
```

In production the two differ. From the Supabase dashboard, Project Settings, Database: `DATABASE_URL` is the transaction pooler (port 6543) and `DIRECT_URL` is the session pooler or direct connection (port 5432). Set both in Vercel. The transaction pooler shares one server connection across many clients per statement, which breaks prepared statements and can break multi-statement migrations. The app runs through it with `prepare: false`; migrations go direct.

### API keys

Third-party API keys are not written to `.env.local` or to shell profiles. They live in the macOS login Keychain and are injected into one process at a time by `scripts/keys.sh`. The script knows the names the project uses; `.env.example` lists the same names with empty values so the set is documented.

| Command | What it does |
|---|---|
| `scripts/keys.sh set GEMINI_API_KEY` | Stores a key. Prompts with hidden input, or reads stdin when piped |
| `scripts/keys.sh list` | Shows which known keys are stored, never their values |
| `scripts/keys.sh run -- npm run dev` | Runs a command with every stored key exported into it |
| `npm run dev:keys` | The dev server with keys injected. `.claude/launch.json` uses this for the app's preview |
| `scripts/keys.sh unset NAME` | Removes a key |

Keys in use:

| Name | Service | Needed for | Where to get it |
|---|---|---|---|
| `GEMINI_API_KEY` | Google Gemini | Extraction now, in the lab's model panel and as the page fallback; matching in phase 4 ([ADR-0013](adr/0013-llm-extraction-boundaries.md), proposed) | aistudio.google.com |
| `SERPAPI_API_KEY` | SerpApi | The lab's Google Shopping panel, and the gap fill in the live prices panel ([ADR-0012](adr/0012-sources-layer-live-fetch-spike.md) item 8) | serpapi.com, free tier of about 100 calls a month; a search is two calls as a rule |

Each key is one Keychain item named `dealz/NAME` under the login account, visible in Keychain Access. `npm run dev` without keys still works; the panels that need one show a setup notice. In CI and on Vercel there is no Keychain: CI needs no keys, and production values are entered in Vercel's dashboard, never copied from a laptop.

## 3. Config

`drizzle.config.ts` at the repo root:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle/migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DIRECT_URL! },
  schemaFilter: ["public"], // never touch Supabase's auth and storage schemas
});
```

`src/db/client.ts`:

```ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const sql = postgres(process.env.DATABASE_URL!, { prepare: false }); // pooler-safe
export const db = drizzle(sql, { schema });
```

`vitest.config.mts` sets `environment: node`, `include: src/**/*.test.ts`, `passWithNoTests`, and v8 coverage over `src/lib`, `src/services` and `src/sources` (fixtures excluded) with the 90 percent thresholds from [TESTING.md](TESTING.md). It also maps the `@/` alias from `tsconfig.json` so runtime imports resolve under Vitest. `.claude/launch.json` names the `dev` server so the Claude desktop app can start `npm run dev` and open a preview. The `.mts` extension is deliberate: Vite loads a `.ts` config as CommonJS and warns.

Scripts in `package.json`:

```json
"typecheck":    "next typegen && tsc --noEmit",
"lint":         "eslint",
"format":       "prettier --write .",
"format:check": "prettier --check .",
"test":         "vitest run --coverage",
"test:db":      "vitest run src/db",
"test:e2e":     "playwright test",
"db:generate":  "drizzle-kit generate",
"db:migrate":   "drizzle-kit migrate",
"db:check":     "drizzle-kit check",
"db:studio":    "drizzle-kit studio"
```

`typecheck` runs `next typegen` first because Next generates the global `LayoutProps` and `PageProps` helpers into `.next/types`, which is ignored by git. Without it a fresh checkout fails to compile. Prettier ignores Markdown (`.prettierignore`): the documents keep their own table style. `.env.example` holds the two database variables with the local values, and the API key names empty; the keys themselves come from the Keychain (section 2, "API keys").

## 4. Migrations

```bash
set -a && source .env.local && set +a              # drizzle-kit does not read .env.local itself
npx drizzle-kit generate --name init              # SQL from schema.ts
npx drizzle-kit generate --custom --name triggers # creates an empty migration file
cp src/db/sql/triggers.sql drizzle/migrations/0001_triggers.sql   # then: cmp the two files
npx drizzle-kit migrate
npx drizzle-kit studio                            # optional: browse the tables
```

Done on 2026-09-22: `0000_init.sql` and `0001_triggers.sql` are in `drizzle/migrations/` and applied locally. `generate` needs `DIRECT_URL` set to any value to read the config; only `migrate` connects. The Drizzle migrator records applied migrations in `drizzle.__drizzle_migrations`.

Rules: migrations are reviewed as SQL before they are applied and never edited afterwards. `src/db/sql/triggers.sql` and the custom migration must stay identical; if a trigger changes, it changes in both, through a new custom migration.

## 5. Checks after the first migrate

Each of these must fail with the named error. They become the PGlite test suite in phase 1. All nine were run by hand against the local stack on 2026-09-22 and failed as expected.

| Try | Expect |
|---|---|
| `UPDATE` or `DELETE` a `price_observation` row | `price_observation is append-only` |
| Insert an observation whose `supersedes_id` is on a different listing | `a correction must stay on the same listing` |
| Insert an `identifier` with `type = 'gtin'` and a `retailer_id` | check `identifier_retailer_only_for_sku` |
| Insert a `gtin` identifier with 13 digits | check `identifier_gtin_is_14_digits` |
| Insert two `gtin` identifiers with the same value | unique `identifier_type_value_retailer_uq` |
| Insert two listings with the same `canonical_url` at one retailer | unique `listing_retailer_url_uq` |
| Insert two products with the same brand and series and a null year | unique `product_brand_series_year_uq` |
| Set a deal to `published` with no `published_at` | check `deal_published_has_timestamp` |
| `UPDATE` a product's name, then read `updated_at` | it moved |

## 6. Tests and CI

- Vitest. Database tests open a PGlite instance, apply `drizzle/migrations` with the Drizzle migrator in `beforeAll`, and run the table above as assertions.
- `.github/workflows/ci.yml` on every pull request: `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run db:check`, the end-to-end registry check, a Markdown link check, and Playwright once `e2e/` has specs. The workflow is committed already and goes live with the first push.
- The policy, the invariant-to-test matrix and the end-to-end rules are in [TESTING.md](TESTING.md).

## Not yet decided

See the open decisions table in [ARCHITECTURE.md](ARCHITECTURE.md#11-open-decisions).
