# src/db/: rules for the database layer

Loads when a file under `src/db/` is read. DATA_MODEL.md explains the shape; SETUP.md sections 3 to 5 explain the migration workflow.

## Non-negotiable

1. `schema.ts` is the source of truth. drizzle-kit generates migrations from it into `drizzle/migrations/`. Migrations are reviewed as SQL before they are applied.
2. An applied migration is never edited. A mistake gets a new migration.
3. `sql/triggers.sql` and the custom migration that applied it stay identical. A trigger change is a new custom migration, and both files change together.
4. `price_observation` is append-only. Never write an UPDATE or DELETE against it, in code or in tests. Corrections insert a row with `supersedes_id`.
5. `schemaFilter` stays `["public"]`. Supabase's `auth` and `storage` schemas are never managed here.
6. Every new invariant gets a check, unique or trigger here, plus a PGlite test in `invariants.test.ts` that tries to violate it and asserts the named error. Application validation is the second line, never the only one.

## Checklist for a schema change

- [ ] `schema.ts` updated, with a comment saying why the column or constraint exists.
- [ ] `npx drizzle-kit generate --name <what-changed>` run; the generated SQL read and understood.
- [ ] `npm run db:check` green.
- [ ] Row added to the invariants table in DATA_MODEL.md and to the matrix in TESTING.md.
- [ ] Breaking test added to `invariants.test.ts`.
- [ ] If the change alters meaning rather than shape, an ADR is proposed.

## Test reset

Tests reset state with `TRUNCATE ... CASCADE`, never `DELETE`. Row-level triggers do not fire on TRUNCATE, so the append-only trigger on `price_observation` does not block it. Do not weaken the trigger to make a test pass.
