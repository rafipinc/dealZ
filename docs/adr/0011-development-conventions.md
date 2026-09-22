# ADR-0011: Development conventions: CLAUDE.md hierarchy, scoped subagents, test gates, documentation map

**Status:** Accepted
**Date:** 2026-09-18
**Decider:** Rafi (proposed by Claude)

## Context

Phase 1 starts writing code. Until now the repository held documents and a schema, and the working rules lived in a chat project's knowledge. Three things needed settling before the first line of application code. How Claude Code is given the project's rules so every session starts from them. How implementation work is split so each piece is checked against the conventions of its language and layer. How tests and documentation become a condition of "done" rather than a follow-up. The end-to-end level needed its own definition of coverage, since line coverage means little for a browser test. The documentation needed to serve two readers at once: a future Claude session that has to operate the project, and a human reader judging Rafi's work.

## Decision

1. **A CLAUDE.md hierarchy is the repository-side operating context.** The root file is the hub: stack, layer rules, delegation table, definition of done, session protocol. Nested files in `src/`, `src/db/`, `docs/` and `e2e/` carry the checklist for that area and load only when files there are touched. WORKING_RULES.md stays the human-readable statement of how Rafi and Claude work; CLAUDE.md applies it.
2. **Subagents are scoped by language and layer**, in `.claude/agents/`: `ts-dev`, `db-dev`, `test-engineer`, `e2e-engineer`, `docs-writer`, `reviewer`. Each carries its area's rules and verifies its own work before reporting. Decisions stay in the main session. `reviewer` is read-only and runs before every session recap that changed code.
3. **Tests are a condition of done**, stated in CLAUDE.md and detailed in TESTING.md: every invariant has a breaking test, every service function has unit tests for its happy path and each typed error, every bug fix starts with a failing test, and coverage thresholds apply to `src/lib` and `src/services`.
4. **End-to-end coverage is a registry, not a percentage.** `e2e/JOURNEYS.md` lists every user journey with a status. A journey is registered when designed, `required` when shipped, `covered` when green. `scripts/check-e2e-coverage.mjs` fails CI when the registry and the spec files disagree.
5. **Documentation is tracked in a map with two audiences.** `docs/README.md` lists every document, whether it serves `ops` (Claude's operating context) or `story` (Rafi's reasoning and involvement), and what change obliges an update. STATUS.md and RUNBOOK.md are added for `ops`. The ADR decider lines, the AI usage log and git co-author trailers carry `story`.

## Options rejected

- **One large CLAUDE.md.** Every session would load database, test and documentation rules it does not need, and the file would drift as it grew. Nested files load on demand.
- **No subagents; the main session does everything.** Simpler, but every task drags the whole project into one context, and nothing checks the change independently before Rafi sees it.
- **Subagents by task type only (implement, test, review) without language scoping.** A generic implementer editing `triggers.sql` would not carry the migration rules. Scoping by language and layer puts the right checklist in front of the right work.
- **Line coverage for end-to-end tests.** Playwright coverage of a Next.js app is noisy and says nothing about whether a user can do the thing. A journey registry is checkable and readable.
- **A wiki or external notes for operating context.** Not versioned with the code, not loaded by Claude, drifts silently.
- **A separate portfolio document written at the end.** The ADR decider lines, the AI usage log and the commit trailers already record involvement as it happens. A summary can be assembled from them.

## Consequences

- Easier: a session starts from STATUS.md and the right rules without re-reading the repository; a feature that touches three layers becomes three checked pieces; "is this tested" and "is this documented" have mechanical answers.
- Harder: more files to keep honest. The documentation map, the journey registry and STATUS.md all need touching at the end of a session. The reviewer agent and CI catch most drift.
- Revisit at the end of phase 1. If the split slows small changes, fold `test-engineer` into `ts-dev` and `db-dev`. If the journey registry is never out of sync, the CI check can become a warning.
