# DealZ

Price history and curated deals for consumer tech in Australia. Look a product up, see what it has actually sold for, and know whether today's price is a good one.

**Status:** pre-alpha. The data model and backend layer come first; there is no UI yet. [ARCHITECTURE.md](docs/ARCHITECTURE.md) has the plan and the phases.

## Why

The [mission](docs/MISSION.md) in one line: help people take control of their purchasing decisions with strong data. Data quality is the core of the product. Everything else is a view over it.

## Architecture at a glance

```
browser today, iOS later
        │
        ▼
Next.js ─ pages, server actions, REST route handlers (/api/v1)
        │   thin adapters: parse input, call one service, shape output
        ▼
services/ ─ business rules: resolve variants, record observations, publish deals
        │
        ▼
db/ ─ Drizzle schema and queries ─── Supabase Postgres
```

Four-layer data model: **product** (family) → **variant** (physical SKU) → **listing** (one retailer page) → **price observation** (append-only fact log). A **deal** is an editorial call that points at one observation. Details in [DATA_MODEL.md](docs/DATA_MODEL.md).

## Stack

| Layer | Choice | Why |
|---|---|---|
| App | Next.js (App Router), TypeScript | Server components call services directly; one deployable |
| Data access | Drizzle ORM, drizzle-kit | Schema in TypeScript, readable SQL migrations, Postgres features intact |
| Database | Supabase Postgres | Managed Postgres, with Auth and Storage available when phases 2 and 3 need them |
| Hosting | Vercel | Preview deployment per pull request |
| Quality | Vitest, PGlite, Playwright, GitHub Actions | Constraint tests run against real Postgres in CI without Docker |

## Documentation

| Document | Covers |
|---|---|
| [Architecture](docs/ARCHITECTURE.md) | Layers, the rules between them, conventions, environment, phases, open decisions |
| [Data model](docs/DATA_MODEL.md) | Tables, every invariant and where it is enforced, matching, corrections |
| [Setup](docs/SETUP.md) | Local environment, migrations, post-migration checks |
| [Decision records](docs/adr/README.md) | Every non-trivial decision, with the options it beat |
| [Research](docs/research/) | Field findings behind the data model |
| [Working rules](docs/WORKING_RULES.md) | How the project is run |
| [AI usage log](docs/AI_USAGE_LOG.md) | What the human brought and what the AI produced, per session |
| [Status](docs/STATUS.md) | Where the project is and what is next, rewritten every session |
| [Testing](docs/TESTING.md) | Test levels, the invariant matrix, the end-to-end journey registry, CI |
| [Runbook](docs/RUNBOOK.md) | Environments, secrets, deploy, migrate, roll back, correct data |
| [Documentation map](docs/README.md) | Every document, its audience, and what obliges an update |

## How it is built

By Rafi Pincus, with Claude as a pair. Rafi decides, Claude proposes, and every non-trivial decision is written down with the options it beat. The [working rules](docs/WORKING_RULES.md) say how. [CLAUDE.md](CLAUDE.md) applies them inside Claude Code: layer rules, language-scoped subagents, a definition of done that requires tests and documentation, and a session protocol. [ADR-0011](docs/adr/0011-development-conventions.md) records why.
