# ADR-0004: GTIN as primary product identifier, manufacturer model code as fallback

**Status:** Accepted
**Date:** 2026-09-15
**Decider:** Rafi

## Context

Linking a retailer page to the right physical product is the core of the system, and a wrong link poisons a price history. [Field research](../research/2026-09-15-au-retailer-identifiers.md) on Australian retailer pages found the GTIN identical across retailers where it is exposed, and the manufacturer model code printed verbatim on every page checked.

## Decision

The GTIN is the primary identifier for a variant. The manufacturer model code (MPN), parsed by a per-brand deterministic parser, is the fallback. Both auto-merge. Title matching and LLM matching never auto-merge (ADR-0010).

## Options rejected

- **Retailer SKU as primary.** Internal to each retailer; useless across shops.
- **Normalised title as primary.** Retailer titles were unreliable in the research: a display-model S90F was listed in a way that looked like a new S90H.
- **Model code as primary.** Consistent in AU, but the GTIN is the globally unique number; the model code is one region's variant of a base code.

## Consequences

- GTINs are normalised to 14 digits and check-digit validated before they are stored; the database enforces the 14-digit shape.
- The `identifier` table maps any number of identifiers to one variant, with a global uniqueness rule for GTIN and MPN.
