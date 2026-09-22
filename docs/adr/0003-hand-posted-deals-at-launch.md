# ADR-0003: Hand-posted deals at launch, no scraper or affiliate feeds in v1

**Status:** Accepted
**Date:** 2026-09-15
**Decider:** Rafi

## Context

Price data can come from hand entry, scrapers, retailer APIs or affiliate network feeds. Each automated source adds legal, operational and data-quality risk before the product exists to justify it.

## Decision

At launch every deal and every price observation is entered by hand through the admin flow. Scrapers and feeds arrive in phase 4, once the data model has been exercised by real entries.

## Options rejected

- **Scraper in v1.** Retailer terms, rate limits and parser fragility would dominate the first months. The schema already leaves room: `observation_source` includes `scrape` and `api`, and `price_observation.raw` keeps the scraper's input for replay.
- **Affiliate feeds in v1.** Networks approve live sites with traffic, so they are unavailable at launch anyway.

## Consequences

- Price history is thin at launch. The chart shows points, not trends, until phase 4. Hero products can be back-filled by hand meanwhile.
- The first scraper targets a structured endpoint (JB Hi-Fi's Shopify product JSON) rather than HTML, per the [research notes](../research/2026-09-15-au-retailer-identifiers.md).
