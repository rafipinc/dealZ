## What

One or two sentences. Link the ADR if this implements a decision.

## Definition of done

- [ ] Unit tests for every new service or lib function: happy path and each typed error
- [ ] Breaking test for every new constraint or trigger, plus rows in DATA_MODEL.md and TESTING.md
- [ ] `e2e/JOURNEYS.md` updated; `node scripts/check-e2e-coverage.mjs` passes
- [ ] Bug fix: the failing test that reproduces it is in this PR
- [ ] Documents obliged by `docs/README.md` updated; STATUS.md current
- [ ] No applied migration edited; `triggers.sql` matches its migration
- [ ] `npm run typecheck && npm run lint && npm test && npm run db:check` green locally

## Decisions

Anything decided here that is not yet an ADR, or "none".
