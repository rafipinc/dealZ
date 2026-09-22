# DealZ Working Rules

How Rafi and Claude work together on DealZ. Add this file to the project knowledge so every new chat starts from it.

## Goal

DealZ is a portfolio-grade web app for consumer tech price history and curated deals. Portfolio piece first, revenue second, but it must still be a beautiful product. Data quality is the core of the project.

## Working rules

1. Rafi decides, Claude proposes. Design and architecture choices are presented as options with trade-offs. Nothing is built until Rafi picks.
2. No code, no files, no memory writes without a green light in that turn.
3. One thing per session. No "while I was at it" extras.
4. Every proposal is labelled as Claude's until Rafi accepts it. Accepted decisions are recorded as Rafi's.
5. Each session ends with a short recap: what was decided, what Rafi learned, what is next. Rafi confirms before it is stored.
6. If Claude is about to make an assumption to keep moving, it says so and stops.
7. Claude teaches as it goes. If a session taught Rafi nothing, the pace was wrong.

## Where the truth lives

- **Repo `docs/`:** durable artefacts. [Architecture](ARCHITECTURE.md), [data model](DATA_MODEL.md), [setup](SETUP.md), [testing](TESTING.md), [runbook](RUNBOOK.md), [decision records](adr/README.md), [research](research/). The [documentation map](README.md) lists every document, its audience and when it changes.
- **[STATUS.md](STATUS.md):** where the project is and what is next. Rewritten at the end of every session, read at the start of the next.
- **Root [CLAUDE.md](../CLAUDE.md) and `.claude/agents/`:** these rules applied inside Claude Code: layer rules, which subagent does which work, the definition of done, the session protocol. Changed only with an ADR.
- **Project knowledge:** the mission statement, this file, and the current versions of the key docs.
- **Claude memory:** decisions and status only, in Rafi's words, with pointers to the repo for detail. Never drafts or unaccepted proposals.
- **[AI usage log](AI_USAGE_LOG.md):** one entry per session recording Rafi's input, Claude's output, and the outcome. Feeds the end-of-project account of contribution and AI leverage.

## Decisions

Every non-trivial decision gets a record in [`docs/adr/`](adr/README.md), numbered and dated, with the options rejected. The index there is the decisions log; it is not duplicated anywhere else.
