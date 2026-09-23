# Status

Where DealZ is right now. Rewritten at the end of every session and read at the start of the next.

**Updated:** 2026-09-24. **Phase:** 1, working database and backend layer. **Step:** migrations on `main`, invariant tests next.

## What exists

- `docs/`: mission, working rules, architecture, data model, setup guide, testing policy, runbook, eleven accepted ADRs, one research note, the AI usage log.
- `src/db/schema.ts` and `src/db/sql/triggers.sql`: the reviewed schema, verified against a real Postgres engine on 2026-09-17. `src/db/client.ts`: the pooler-safe Drizzle client.
- Local Supabase stack running under Colima with analytics off; `.env.local` in place. `drizzle/migrations/0000_init.sql` and `0001_triggers.sql` generated, reviewed against DATA_MODEL.md, applied locally, and the nine SETUP.md section 5 checks pass by hand. Merged to `main` in pull request #2, reviewed and CI green.
- The Next.js scaffold, merged to `main` in pull request #1: `package.json` with every script from SETUP.md section 3, strict TypeScript, ESLint, Prettier, Tailwind, Vitest with the coverage thresholds from TESTING.md, `drizzle.config.ts`, `.env.example`, a placeholder home page. CI green.
- Development conventions per [ADR-0011](adr/0011-development-conventions.md), accepted 2026-09-22: root and nested CLAUDE.md files, six subagents, [TESTING.md](TESTING.md), the [journey registry](../e2e/JOURNEYS.md) with its CI check, the [documentation map](README.md), [RUNBOOK.md](RUNBOOK.md), the CI workflow and the pull request template.
- Architecture reviewed 2026-09-18: `retailers` service added to phase 1, read-only `pricing` service planned for phase 3 with journey J-013. LLM use confined to phase 4 matching and extraction.
- Git: `main` on GitHub at rafipinc/dealZ with the phase 0, scaffold and migrations commits, CI green.

## What does not exist yet

No tests, no services, no `src/lib`. The constraints and triggers have no PGlite tests yet.

## Next

Phase 1, in this order, one per session unless small:

1. `src/db/invariants.test.ts` against PGlite: the full matrix in TESTING.md.
2. `src/lib`: gtin, url, model-code parsing, with unit tests.
3. Services `retailers`, `catalog`, `listings`, `observations`, `deals`, each with its test file.

## Open

- The open decisions table in ARCHITECTURE.md section 11. Claude's recommendations for each were reviewed on 2026-09-18 and each becomes an ADR in its phase.
- ADR-0012, LLM usage boundaries and provider isolation, to be proposed before phase 4.
- Research questions: JB Hi-Fi Shopify `barcode` field; first five retailers; a non-Samsung model-code check.
- Whether `.claude/settings.json` hooks (typecheck on edit, tests on stop) are worth their latency. `npm test` now exists, so this can be decided.
- Four moderate `npm audit` findings in drizzle-kit's bundled esbuild loader, dev-only, no fix available. Recheck when drizzle-kit updates.
