# docs/: rules for documentation

Loads when a file under `docs/` is read. docs/README.md is the map: every document, its audience and what obliges an update. Keep the map current when a document is added, renamed or retired.

## Two audiences

- `ops`: operating context so a future Claude session, or a new developer, can act without re-deriving the project. Precise, current, mechanical. STATUS.md, SETUP.md, RUNBOOK.md, TESTING.md.
- `story`: the reasoning and Rafi's part in it, for a human reader or recruiter. README.md, the ADRs, AI_USAGE_LOG.md, research notes.

A document serves one or both. Write for the audience declared in the map. An `ops` document does not narrate; a `story` document does not list commands.

## Style

- Short sentences. One idea per sentence. Tables for parallel facts.
- British spelling. No em-dashes. No exclamation marks.
- Say what is true now. Planned things are marked planned, with the phase.
- Link to the source of truth instead of repeating it. The schema is in `src/db/schema.ts`; do not paste columns into prose.
- ISO dates, `2026-09-18`. Relative dates never appear in a document.
- Every document opens with one line saying what it is for.

## ADRs

- Numbered, dated, with the options rejected and one line each on why not. Template in `docs/adr/README.md`.
- Decider is Rafi. "Proposed by Claude" is noted when true. Status is `Proposed` until Rafi accepts in chat, then `Accepted`. Claude never marks its own proposal accepted.
- An accepted ADR is never edited. A change is a new ADR that supersedes it, and the old one's status line points forward.
- The index in `docs/adr/README.md` is the decisions log. Add the row in the same change as the file.

## AI usage log

One row per session, added at the end: Rafi's input, Claude's output, outcome. Written so a reader can tell what Rafi decided and what Claude produced. Rafi's decisions are named as Rafi's.

## STATUS.md

Rewritten, not appended, at the end of every session. Four questions: what phase, what exists, what is next, what is blocked or open. Under a screen long.
