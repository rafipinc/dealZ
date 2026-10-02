# src/db/: rules for the database layer

Loads when a file under `src/db/` is read. DATA_MODEL.md explains the shape; SETUP.md sections 3 to 5 explain the migration workflow.

## Non-negotiable

1. `schema.ts` is the source of truth. drizzle-kit generates migrations from it into `drizzle/migrations/`. Migrations are reviewed as SQL before they are applied.
2. An applied migration is never edited. A mistake gets a new migration.
3. Each hand-written SQL file in `sql/` is paired with exactly one custom migration and stays byte-identical to it (ADR-0014). A trigger change is a new file plus a new custom migration. An applied pair is never edited.
4. `price_observation` and `api_usage` are append-only. Never write an UPDATE or DELETE against either, in code or in tests. The one exception is the breaking test in `invariants.test.ts` that rule 6 requires, which asserts the trigger rejects it. A price correction inserts a row with `supersedes_id`.
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

Tests reset state with `TRUNCATE ... CASCADE`, never `DELETE`. Row-level triggers do not fire on TRUNCATE, so the append-only triggers on `price_observation` and `api_usage` do not block it. Do not weaken a trigger to make a test pass.
