# ADR-0018: A GitHub Projects board is the one task list

**Status:** Accepted (2026-10-08)
**Date:** 2026-10-08
**Decider:** Rafi. The move to one source of truth and the engine-only scope were decided by Rafi. GitHub Projects, the epics and the columns were proposed by Claude.

## Context

Rafi stepped back and asked whether the work was being tracked as it happened. The task list lived in several places: the Next and Open lists in STATUS.md, a claude.ai artifact board, and notes in the usage log. Rafi said the documents were growing out of control and asked for a small task board he can write himself. Two read-only audits found that the session narrative was written twice and that the same rules were stated in several documents.

## Decision

1. The task list is the GitHub Projects board at https://github.com/users/rafipinc/projects/1. It is public and linked to the repository `rafipinc/dealZ`.
2. The board's Status field has five columns: Later, Next, Doing, Waiting on Rafi, Done.
3. Work is grouped into epics. An epic is a GitHub issue labelled `epic`. Its tasks are sub-issues. The epics are #16 Database, #17 Backend services, #18 Sources and scheduling, #19 Lab and dashboard.
4. Labels are `area:db`, `area:services`, `area:sources`, `area:app`, `epic` and `needs-rafi`.
5. Only engine-building tasks go on the board. Other items are closed or parked in STATUS.md under "Parked" until picked up.
6. STATUS.md keeps the phase, what exists, what does not exist and the parked notes. It no longer holds a Next or Open list.
7. A session starts by reading STATUS.md, WORKING_RULES.md and then the board. The task in Doing, or the top of Next, is the session's one thing.
8. A session ends by moving the card. A pull request body says `Closes #N`, so the issue closes when the pull request merges.
9. Rafi writes the cards. Claude may propose a card; it is not on the board until Rafi adds it.
10. The earlier claude.ai artifact board is deleted.

## Options rejected

| Option | Why not |
|---|---|
| Linear | A separate account and a private tool. Pull requests and CI would not link to the card without an integration. |
| Jira or Notion | Heavier than a one-person project needs, and not part of the repository's public record. |
| The claude.ai artifact board | It sits outside the repository, so nothing verifies it. Rafi chose to delete it. |
| Keeping the lists in STATUS.md | It was already duplicated elsewhere, and a rewritten file keeps no history of a task moving. |

## Consequences

Easier:

- One list of what to do next.
- A pull request closes its task, so planning, pull requests, CI and commit trailers form one public, verifiable chain.
- A reader can see the plan without opening the repository.

Harder:

- One more place to read at the start of a session.
- The pre-commit hook does not check the board. Keeping it current depends on the end-of-session step.

Revisit if the board and the code drift apart, or if the project gains a second contributor.
