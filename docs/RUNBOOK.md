# Runbook

Operating procedures for DealZ: environments, secrets, deploying, migrating, rolling back, correcting data. Written so a future session can act without asking. Nothing here is live until phase 1 ships; each section states what is decided and marks what is not yet set up.

## Environments

| Environment | App | Database | Status |
|---|---|---|---|
| Local | `next dev` on 3000 | Supabase CLI stack: Postgres on 54322, Studio on 54323 | Set up in phase 1 per SETUP.md |
| Preview | Vercel, one per pull request | Not decided: the production project, or a Supabase branch per preview. Open decision in ARCHITECTURE.md section 11 | Not yet created |
| Production | Vercel, from `main` | One Supabase project | Not yet created. Created at first deploy, not before |

## Secrets

| Name | Used by | Lives in |
|---|---|---|
| `DATABASE_URL` | The app, through the transaction pooler with `prepare: false` | `.env.local` locally; Vercel project settings |
| `DIRECT_URL` | drizzle-kit migrations | Same |
| Supabase service role key | Nothing in v1 | Supabase dashboard only |

Nothing is committed. `.env.local` is gitignored. If a value leaks: rotate it in Supabase, update Vercel, redeploy.

## Deploy

1. Open a pull request. CI runs the gate (typecheck, lint, tests, `db:check`, end-to-end). Vercel builds a preview.
2. Review the preview. The preview build does not apply migrations.
3. Merge to `main`. Vercel deploys production.
4. If the change includes a migration, apply it (next section). Additive migrations go before the deploy. Destructive ones go after, once nothing reads the old shape.

## Migrate production

```bash
DIRECT_URL=<production direct connection> npx drizzle-kit migrate
```

- Uses the direct connection, never the transaction pooler.
- Read the SQL in `drizzle/migrations/` first. An applied migration is never edited.
- Migrations run from a developer machine in v1. A CI step gated on `main` is a phase 2 improvement and gets an ADR when done.

## Roll back

- App: redeploy the previous Vercel deployment from the dashboard.
- Schema: there is no down migration. Write a new forward migration that restores the shape. Before a destructive migration, take a Supabase backup (dashboard, Database, Backups) and note the timestamp in the pull request.
- Data: never delete. See the next section.

## Correct data

- A wrong price: insert a new `price_observation` with `supersedes_id` pointing at the bad row (ADR-0009). Never UPDATE; the trigger blocks it.
- A wrong listing match: set the listing `is_active = false` and create the correct listing. History stays attached to the listing it was observed on.
- A wrong deal: `retract`. Price history is untouched.
- Product or variant metadata: ordinary UPDATE. `updated_at` moves by trigger.

## Check health

| Check | How |
|---|---|
| App up | Open the deals feed; Vercel deployment logs |
| Database reachable | `select 1` in Drizzle Studio or the Supabase SQL editor |
| Migrations current | `npx drizzle-kit check`, then compare `drizzle/migrations/` with the `__drizzle_migrations` table |
| Constraints intact | `npm run test:db` locally applies the same migrations to PGlite |

## Not yet decided

Alerting, log retention, backup cadence beyond Supabase defaults. Decided when there is traffic, and recorded in ARCHITECTURE.md section 11 when they become open decisions.
