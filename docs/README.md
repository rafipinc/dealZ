# Documentation map

Every document in the project, who it is for, and what change obliges an update. Two audiences:

- **ops**: operating context so a future Claude Code session, or a new developer, can act without re-deriving the project.
- **story**: the reasoning and Rafi's part in it, for a human reader or recruiter.

When a document is added, renamed or retired, this table changes in the same commit.

## Map

| Document | Audience | Holds | Update when |
|---|---|---|---|
| [README.md](../README.md) | story | What DealZ is, the stack, how it is built | The stack or a phase changes |
| [CLAUDE.md](../CLAUDE.md) and the nested files in `src/`, `src/db/`, `docs/`, `e2e/` | ops | Rules Claude follows: layers, delegation, definition of done, session protocol | A convention changes, with an ADR |
| [STATUS.md](STATUS.md) | ops | Current phase, what exists, what is next, what is open | End of every session |
| [MISSION.md](MISSION.md) | story | Why the product exists, in Rafi's words | Rarely |
| [WORKING_RULES.md](WORKING_RULES.md) | both | How Rafi and Claude work together | A working rule changes |
| [ARCHITECTURE.md](ARCHITECTURE.md) | both | Layers, rules between them, API conventions, environment, phases, open decisions | A layer rule, phase or open decision changes |
| [DATA_MODEL.md](DATA_MODEL.md) | both | Tables, invariants and where each is enforced, matching, corrections | Any change to `src/db/schema.ts` or `triggers.sql` |
| [SETUP.md](SETUP.md) | ops | Local environment, config, migrations, first checks | A tool, script or environment variable changes |
| [TESTING.md](TESTING.md) | ops | Test levels, rules, invariant matrix, end-to-end policy, CI | A test rule, level or CI job changes |
| [RUNBOOK.md](RUNBOOK.md) | ops | Environments, secrets, deploy, migrate, roll back, correct data | A production procedure changes or is first used |
| [adr/](adr/README.md) | story | One record per non-trivial decision, with the options rejected | Every non-trivial decision |
| [research/](research/) | story | Field findings behind the model | New research. Existing notes are never edited |
| [AI_USAGE_LOG.md](AI_USAGE_LOG.md) | story | Per session: Rafi's input, Claude's output, outcome | End of every session |
| [e2e/JOURNEYS.md](../e2e/JOURNEYS.md) | ops | Registry of user journeys and their end-to-end status | A journey is designed, shipped, covered or retired |
| `src/db/schema.ts`, `src/db/sql/triggers.sql` | both | The database as code, with comments saying why | Every schema change |

## Reading order

For Claude at the start of a session: STATUS.md, WORKING_RULES.md, then the document for the layer being touched. The root CLAUDE.md has that table.

For a recruiter or reviewer, twenty minutes:

1. [README.md](../README.md): what it is and how it is built.
2. [adr/README.md](adr/README.md): the decisions log. Each record names who decided and what was rejected.
3. [AI_USAGE_LOG.md](AI_USAGE_LOG.md): what Rafi brought to each session and what came of it.
4. [ARCHITECTURE.md](ARCHITECTURE.md) and [DATA_MODEL.md](DATA_MODEL.md): the design.
5. `git log`: commits by Rafi, with a co-author trailer on the ones Claude wrote.

## Evidence of involvement

The story documents record Rafi's contribution as it happens, so no separate write-up is needed:

| Evidence | Where |
|---|---|
| What Rafi decided, and what he rejected | Every ADR: the Decider line and the Options rejected section |
| What Rafi brought to each session | AI_USAGE_LOG.md, "Rafi's input" column |
| What Rafi learned | Session recaps, summarised in the "Outcome" column |
| Who wrote each change | Git history: the author, plus a `Co-Authored-By` trailer when Claude wrote the code |
| Field work | research/ notes, dated and hand-inspected |

An end-of-project summary can be assembled from these five sources.

## Health checks

- Every relative link in a Markdown file resolves. CI checks this on every pull request.
- Every document opens with one line saying what it is for.
- STATUS.md carries the date of the last session. The reviewer agent flags a stale one.
- No document repeats what the schema defines. DATA_MODEL.md explains; `schema.ts` defines.
