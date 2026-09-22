# ADR-0009: Corrections supersede observations instead of outranking them

**Status:** Accepted
**Date:** 2026-09-17
**Decider:** Rafi (proposed by Claude)

## Context

ADR-0007 makes `price_observation` append-only, so a bad parse cannot be edited. The first design corrected a row by inserting a new one "with higher confidence" at the same timestamp. That fails twice. Confidence defaults to 1 and is capped at 1, so nothing can outrank a default row. And "same timestamp" is an implicit link that only works when timestamps match exactly.

## Decision

A correction is a new observation whose `supersedes_id` points at the row it replaces. An observation is current when no row supersedes it. A trigger requires the correction to be on the same listing as the original. `confidence` goes back to meaning how sure the parser was.

## Options rejected

- **Higher confidence wins.** Impossible with a capped scale, and it conflates two meanings in one column.
- **A `voided` flag on the original.** Requires an UPDATE on an append-only table.
- **Delete and re-insert.** Destroys the audit trail, which is the point of the table.

## Consequences

- Every history query filters to current observations with `NOT EXISTS (select 1 from price_observation c where c.supersedes_id = o.id)`. A partial index on `supersedes_id` keeps that cheap.
- Chains are allowed: a correction can itself be corrected. The original stays visible for audit.
