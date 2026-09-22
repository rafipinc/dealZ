# ADR-0010: Every listing records how it was matched; unmatched pages are staged, not stored as listings

**Status:** Accepted
**Date:** 2026-09-17
**Decider:** Rafi (proposed by Claude)

## Context

The matching tiers (ADR-0004) auto-merge on GTIN and model code but not on title or LLM matches. The first schema had no place for a page that had not been matched yet, and no record of how a matched listing had been linked, so a bad merge could not be found or undone. The decisions log also carried a shorthand, "automated matching, no manual checks", that read as if every tier auto-merged.

## Decision

1. `listing.variant_id` stays NOT NULL. A listing is, by definition, a confirmed retailer page for a known variant.
2. Every listing records `match_method` (`manual`, `gtin`, `mpn`, `title`, `llm`), `match_confidence` and `matched_at`. In v1 every listing is `manual`.
3. Tiers 1 and 2 auto-merge. Tiers 3 and 4 never do. When ingestion arrives (phase 4) such pages go into a staging table and become listings only once a match is confirmed, by rule or by hand.

## Options rejected

- **Nullable `variant_id` with match columns.** Simple, but every query needs a null guard and "best price" has to remember to skip unmatched rows.
- **No audit columns.** Cheap now, but the first wrong merge would be undetectable.

## Consequences

- The staging table is designed with the first scraper, not now; nothing in the current schema constrains its shape.
- "Automated matching" means tiers 1 and 2. Tiers 3 and 4 produce candidates, never merges.
