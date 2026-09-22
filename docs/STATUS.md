# Status

Where DealZ is right now. Rewritten at the end of every session and read at the start of the next.

**Updated:** 2026-09-22. **Phase:** 0, documentation and schema. **Next phase:** 1, working database and backend layer.

## What exists

- `docs/`: mission, working rules, architecture, data model, setup guide, eleven accepted ADRs, one research note, the AI usage log.
- `src/db/schema.ts` and `src/db/sql/triggers.sql`: the reviewed schema, verified against a real Postgres engine on 2026-09-17.
- Architecture reviewed 2026-09-18 against a high-level diagram. Two gaps closed in ARCHITECTURE.md section 4: a `retailers` service in phase 1 and a read-only `pricing` service planned for phase 3, with journey J-013. LLM use is confined to phase 4 matching and extraction; no ADR yet.
- Development conventions, added 2026-09-18 and proposed in [ADR-0011](adr/0011-development-conventions.md): root and nested CLAUDE.md files, six subagents in `.claude/agents/`, [TESTING.md](TESTING.md), the [journey registry](../e2e/JOURNEYS.md) with its CI check, the [documentation map](README.md), [RUNBOOK.md](RUNBOOK.md), the CI workflow and the pull request template. Accepted by Rafi on 2026-09-22.

## What does not exist yet

No `package.json`, no Next.js scaffold, no generated migrations, no tests. Everything from SETUP.md section 1 onward is still to do. The git repository exists with the remote set; nothing is pushed yet.

## Next

Phase 1, in this order, one per session unless small:

1. Scaffold per SETUP.md section 1. Add the scripts from SETUP.md section 3. CI becomes live with the first push.
2. Local Supabase stack, `.env.local`, generate and apply the init and triggers migrations.
3. `src/db/invariants.test.ts` against PGlite: the full matrix in TESTING.md.
4. `src/lib`: gtin, url, model-code parsing, with unit tests.
5. Services `retailers`, `catalog`, `listings`, `observations`, `deals`, each with its test file.

## Open

- The open decisions table in ARCHITECTURE.md section 11. Claude's recommendations for each were reviewed on 2026-09-18 and each becomes an ADR in its phase.
- ADR-0012, LLM usage boundaries and provider isolation, to be proposed before phase 4.
- Research questions: JB Hi-Fi Shopify `barcode` field; first five retailers; a non-Samsung model-code check.
- Whether `.claude/settings.json` hooks (typecheck on edit, tests on stop) are worth their latency. Decide once `npm test` exists.
