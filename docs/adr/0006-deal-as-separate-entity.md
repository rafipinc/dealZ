# ADR-0006: Deal is a separate entity from price observation

**Status:** Accepted
**Date:** 2026-09-17
**Decider:** Rafi (proposed by Claude)

## Context

A deal is what DealZ publishes: "this TV is $1,995 at JB right now, buy it." A price observation is what the system records: "at 14:02 the JB page showed $1,995." At launch deals are hand-posted, so the question was whether a deal is an observation with commentary attached, or its own thing.

## Decision

`deal` is its own table. It references the `price_observation` that triggered it and carries its own title, commentary, status and lifecycle timestamps. It reaches the listing, variant and product through the observation, so it can never disagree with the observation about which listing it is on.

## Options rejected

- **Commentary column on `price_observation`.** One table, nothing to join, but editorial edits would mutate a fact table, a deal could not be retracted without touching history, and deal state (draft, expired) would pollute the fact log.
- **A `listing_id` on `deal` as well as the observation.** Convenient for "deals on this listing", but a second path to the listing that can drift from the first. Dropped in the 2026-09-17 review; the join through the observation is cheap.

## Consequences

- Easier: retracting or expiring deals, auditing what price a deal was posted at, generating deals automatically later.
- Harder: nothing material. One extra join on the deals page.
- Revisit: when deals become automated, add `generated_by` and a rule reference.
