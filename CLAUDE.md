# DealZ: operating context for Claude Code

Price history and curated deals for consumer tech in Australia, built by Rafi Pincus with Claude as a pair. This file is the hub. It states the rules that apply to every session and points at the documents that hold the detail. Nested CLAUDE.md files in `src/`, `src/db/`, `docs/` and `e2e/` add the checklist for that area and load when files there are touched.

## Start of every session

1. Read [docs/STATUS.md](docs/STATUS.md): current phase, what exists, what is next, what is open.
2. Read [docs/WORKING_RULES.md](docs/WORKING_RULES.md). Short form: Rafi decides, Claude proposes. One thing per session. Every non-trivial decision becomes an ADR. Every proposal is labelled Claude's until Rafi accepts it.
3. Read the document for the layer being touched (table under Documentation).

Do not re-derive the design from the code. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) is the map and [docs/DATA_MODEL.md](docs/DATA_MODEL.md) explains the schema.

## Stack

Next.js (App Router) and TypeScript. Drizzle ORM on Supabase Postgres. Vitest with PGlite for database tests. Playwright for end-to-end. GitHub Actions for CI. Vercel for hosting. Node 22. Strict TypeScript, ESLint, Prettier. No `any` at a layer boundary.

Status: pre-alpha. `docs/` and `src/db/` exist. The app scaffold is phase 1 and follows [docs/SETUP.md](docs/SETUP.md).

## Layer rules

ARCHITECTURE.md section 3 is authoritative. Short form:

| Layer | Path | May import |
|---|---|---|
| Database | `src/db/` | Drizzle only. The only place Drizzle is imported |
| Services | `src/services/` | `src/db`, `src/lib`. Business rules as plain functions. Zod at the boundary. Typed errors |
| Adapters | `src/app/` | `src/services`, `src/lib`. Parse input, call one service, shape output. No business rules |
| Shared | `src/lib/` | Nothing internal. Pure functions |

Server components call services directly, never the app's own REST routes.

## Delegation to subagents

Subagents live in `.claude/agents/`. Each is scoped to one language or layer and carries that area's rules, so work is checked against the right conventions without loading everything into the main session.

| Work | Agent | Language |
|---|---|---|
| Services, adapters, shared helpers, pages, server actions, route handlers | `ts-dev` | TypeScript |
| Schema, triggers, migrations, query helpers | `db-dev` | SQL and Drizzle |
| Unit, database and integration tests (Vitest, PGlite) | `test-engineer` | TypeScript |
| End-to-end journeys (Playwright) and the journey registry | `e2e-engineer` | TypeScript |
| Docs, ADRs, STATUS, AI usage log, documentation map | `docs-writer` | Markdown |
| Read-only check of a change against these conventions | `reviewer` | All |

Rules:

1. Delegate work that is self-contained and lives in one layer. Keep orchestration, trade-offs and anything Rafi has to decide in the main session.
2. A feature that crosses layers is split by layer and run in dependency order: `db-dev`, then `ts-dev`, then `test-engineer` or `e2e-engineer`. Independent pieces run in parallel.
3. Every implementing agent runs its own verification (typecheck, lint, the tests it touched) before reporting. An agent that reports without verifying has not finished.
4. `reviewer` runs after any change under `src/`, `e2e/` or `drizzle/`, before the session recap. Its findings are fixed, or deferred with a reason in the recap.
5. Agents never make a decision that needs an ADR. They propose; the main session brings the options to Rafi.
6. Relay agent findings in your own words. Rafi does not see the agent's report.

## Definition of done

A change is done when all of these hold. [docs/TESTING.md](docs/TESTING.md) and [docs/README.md](docs/README.md) hold the full rules.

- Every new service or lib function has unit tests: the happy path and each typed error it can throw.
- Every new database constraint or trigger has a PGlite test that tries to break it, and a row in DATA_MODEL.md.
- Every user-facing journey is registered in [e2e/JOURNEYS.md](e2e/JOURNEYS.md) and, once the feature ships, has a Playwright spec. `node scripts/check-e2e-coverage.mjs` passes.
- A bug fix starts with a failing test that reproduces it.
- `npm run typecheck`, `npm run lint`, `npm test` and `npm run db:check` are green (once the scaffold exists).
- The documents that docs/README.md lists as obliged by this kind of change are updated in the same change.
- STATUS.md reflects the new state. AI_USAGE_LOG.md has a row for the session.

## Commands

Defined in `package.json` from phase 1, per SETUP.md.

```bash
npm run typecheck && npm run lint && npm test && npm run db:check   # the CI gate
npm run test:db                    # PGlite invariant and query tests only
npm run test:e2e                   # Playwright; needs the app and a database
node scripts/check-e2e-coverage.mjs
```

## Documentation

Two audiences, tracked in [docs/README.md](docs/README.md): operating context for Claude (`ops`) and the project story for a human reader or recruiter (`story`). Every document declares which it serves and what change obliges an update.

| Touching | Read first |
|---|---|
| Anything | STATUS.md, WORKING_RULES.md |
| `src/db/` | DATA_MODEL.md, SETUP.md, `src/db/CLAUDE.md` |
| `src/services/`, `src/app/`, `src/lib/` | ARCHITECTURE.md sections 3 to 6, `src/CLAUDE.md` |
| Tests | TESTING.md |
| `e2e/` | TESTING.md, `e2e/CLAUDE.md`, `e2e/JOURNEYS.md` |
| Deployment, secrets, production data | RUNBOOK.md |
| Any document | `docs/CLAUDE.md` |

House style for every document: short sentences, tables for parallel facts, British spelling, no em-dashes. Say what is true now and mark what is planned. An accepted ADR is never edited; it is superseded. An applied migration is never edited; a mistake gets a new migration.

## Git

- Commit and push only when Rafi asks in that turn. Claude prepares the change and proposes the message.
- Subject: imperative, under 72 characters, prefixed with the area: `db:`, `services:`, `app:`, `lib:`, `test:`, `e2e:`, `docs:`, `ci:`.
- When Claude wrote the code, the message ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`, so the history shows who did what.
- One branch per session, named `<phase>/<thing>`, for example `p1/services-catalog`. Pull requests use the template in `.github/`.

## End of every session

1. Run `reviewer` if `src/`, `e2e/` or `drizzle/` changed.
2. Recap in chat: what was decided, what Rafi learned, what is next.
3. Update STATUS.md and add the AI_USAGE_LOG.md row. Write or update an ADR if a decision was made.
4. Write to Claude memory only after Rafi confirms the recap, and only decisions and status, in Rafi's words.
