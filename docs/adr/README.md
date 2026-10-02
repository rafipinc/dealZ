# Architecture Decision Records

One file per non-trivial decision, numbered and dated. Two paragraphs is enough: the decision, the reasoning, the options rejected. An accepted record is never edited; it is superseded by a new one that links back. This index is the project's decisions log.

| # | Decision | Status | Date |
|---|---|---|---|
| [0001](0001-web-app-first.md) | Web app first, iOS later if at all | Accepted | 2026-09-15 |
| [0002](0002-consumer-tech-wedge.md) | Consumer tech as the single starting category | Accepted | 2026-09-15 |
| [0003](0003-hand-posted-deals-at-launch.md) | Hand-posted deals at launch, no scraper or feeds in v1 | Accepted | 2026-09-15 |
| [0004](0004-gtin-primary-identifier.md) | GTIN as primary identifier, model code as fallback | Accepted | 2026-09-15 |
| [0005](0005-listing-condition-strict-enum.md) | Listing condition as a strict enum, per-condition history | Accepted | 2026-09-15 |
| [0006](0006-deal-as-separate-entity.md) | Deal is a separate entity from price observation | Accepted | 2026-09-17 |
| [0007](0007-append-only-price-observations.md) | `price_observation` is append-only, trigger-enforced | Accepted | 2026-09-17 |
| [0008](0008-drizzle-and-service-boundary.md) | Drizzle for data access, services as the boundary, REST for external clients | Accepted | 2026-09-17 |
| [0009](0009-corrections-by-supersession.md) | Corrections supersede observations instead of outranking them | Accepted | 2026-09-17 |
| [0010](0010-listing-match-audit-and-staging.md) | Every listing records its match; unmatched pages are staged, not stored as listings | Accepted | 2026-09-17 |
| [0011](0011-development-conventions.md) | Development conventions: CLAUDE.md hierarchy, scoped subagents, test gates, documentation map | Accepted | 2026-09-22 |
| [0012](0012-sources-layer-live-fetch-spike.md) | A sources layer for live retailer fetches, started as a phase 1 spike | Proposed | 2026-09-28 |
| [0013](0013-llm-extraction-boundaries.md) | A language model reads pages without structured data, returns evidence, never sets a price on its own | Proposed | 2026-09-28 |
| [0014](0014-usage-ledger-and-status-dashboard.md) | A usage ledger in local Postgres and a local-only status dashboard, with no budget cap | Accepted | 2026-10-01 |

## Template

```markdown
# ADR-NNNN: Title

**Status:** Proposed | Accepted | Superseded by ADR-NNNN
**Date:** YYYY-MM-DD
**Decider:** Rafi (proposed by Claude | proposed by Rafi)

## Context
What forced the decision, in a paragraph.

## Decision
What was decided, stated so it can be checked against the code.

## Options rejected
Each option, one line on why not.

## Consequences
What becomes easier, what becomes harder, when to revisit.
```
