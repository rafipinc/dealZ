# ADR-0002: Consumer tech as the single starting category

**Status:** Accepted
**Date:** 2026-09-15
**Decider:** Rafi

## Context

The mission says "any product", but automated matching only works where products carry stable identifiers. The category chosen first decides whether the matching pipeline can be validated at all.

## Decision

Version 1 covers one category, consumer tech (TVs first), in Australia. Other categories come only after matching is proven on this one.

## Options rejected

- **All categories from day one.** Groceries, fashion and furniture often lack GTINs or reuse them across variants, so matching quality would collapse before the model was proven.
- **A different single category.** Consumer tech has the strongest identifiers (GTIN and manufacturer model codes printed on every AU retailer page checked), frequent price movement, and it is the domain the field research already covered.

## Consequences

- `product.category` is free text and `variant.attributes` is JSON, so adding a category later needs no schema change.
- The model-code parser is built per brand, starting with Samsung.
