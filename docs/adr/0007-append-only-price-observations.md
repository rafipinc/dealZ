# ADR-0007: price_observation is append-only

**Status:** Accepted
**Date:** 2026-09-17
**Decider:** Rafi (proposed by Claude)

## Context

Price history is the core asset. A scraper will sometimes parse a price wrong, and there is a temptation to "fix" the row. Once rows can be edited the history can no longer be trusted: there is no way to tell a correction from a mistake or a tampered value.

## Decision

`price_observation` accepts INSERT only. A Postgres trigger raises on UPDATE and DELETE. Corrections are new rows that supersede the bad one (ADR-0009).

## Options rejected

- **Convention only.** Zero setup; violated the first time something looks wrong at 11pm.
- **Revoke UPDATE and DELETE from the application role.** Enforced, but Supabase's default roles make grant management fiddly and easy to lose when roles change.
- **Trigger that raises (chosen).** Enforced regardless of role, lives in a migration next to the schema, obvious in the code. A superuser can still drop the trigger; that is an explicit act and acceptable.

## Consequences

- Easier: trusting any chart drawn from this table; replaying bad parses from `raw`.
- Harder: correcting data means thinking in new observations, not edits. Every history query filters to current observations.
- Revisit: retention. If the table grows large, roll old rows into a daily summary table rather than deleting.
