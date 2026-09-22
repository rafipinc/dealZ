# ADR-0005: Listing condition as a strict enum, separate price history per condition

**Status:** Accepted
**Date:** 2026-09-15
**Decider:** Rafi

## Context

The same GTIN is sold new, as a factory second, as a display model and refurbished, at very different prices. The research found a factory-second S90H at a price that would have looked like the deal of the year in a "new" price history.

## Decision

Condition is a strict enum on the listing, never on the variant: `new`, `refurbished_manufacturer`, `refurbished_seller`, `factory_second`, `display_model`, `open_box`, `used`, `unknown`. Automated ingestion defaults to `unknown`, and `unknown` is excluded from "best price" until confirmed. Each condition has its own price history because each listing has its own.

## Options rejected

- **Free-text condition.** Cannot be filtered or trusted.
- **A boolean `is_new`.** Loses the warranty distinction between manufacturer and seller refurbishment.
- **Condition on the variant.** Would mean a separate variant per condition and break GTIN uniqueness.
- **Defaulting to `new`.** Silent optimism is exactly how a display model ends up in a new-price chart.

## Consequences

- `listing.condition_confidence` and `condition_notes` record how the condition was determined.
- The "best price" query groups by condition and excludes `unknown`.
