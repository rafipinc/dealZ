# ADR-0013: A language model reads pages that carry no structured data, returns evidence, and never sets a price on its own

**Status:** Proposed
**Date:** 2026-09-28
**Decider:** Rafi (the approach proposed by Rafi, the rules and the model tier proposed by Claude)

## Context

Most retailer pages carry a schema.org `Product` block or a platform JSON endpoint, and the page sources of ADR-0012 read those for free with confidence 1. Some do not: small independents, listing pages, pages that render the price only in text. The architecture review of 2026-09-18 confined language models to phase 4 matching and extraction and said they never state a price fact. Rafi asked on 2026-09-28 whether a cheap model could read the price from the easiest source and rate its own confidence, and whether a Flash-class model is strong enough. The [experiment](../research/2026-09-28-llm-extraction-experiment.md) answered the second question: on five pages the smallest Gemini model matched the larger one, three right and two flagged as doubtful, none silently wrong.

## Decision

1. **A fourth page source, `llm_extract`.** It fetches a page like any page source, reduces it to visible text trimmed around price marks (`src/lib/page-text.ts`, pure and tested), and asks a model for a fixed JSON shape. It is used only when a page has no structured data, or when a tracked page declares it.
2. **The model returns evidence, not a verdict.** The response schema asks for the price, the exact text fragment it was read from, the model code and GTIN if printed, condition words, whether the page is a single product page and whether it is a bundle, and any doubts. It is never asked "how confident are you".
3. **Rules assign the confidence**, in one pure function with a test per rule. Start at 0.6. The evidence fragment must exist in the text that was sent, otherwise 0.3: a fragment that is not there was invented. Doubts stated: minus 0.2. Bundle or a non-AUD currency: capped at 0.3. A printed model code: plus 0.1. A page the model says is not a single product page, or where it finds no price, yields no quote at all. The rules bound the score to 0.3 through 0.7, so a model-read price never outranks structured data.
4. **Below `REVIEW_THRESHOLD` (0.7) a quote is a candidate**, shown for review, never charted as a price and never the basis of a deal. This matches ADR-0010: tiers 3 and 4 produce candidates, never merges.
5. **One provider, one module.** `src/sources/gemini.ts` is the only file that knows the provider's API. The extraction tier is `gemini-3.5-flash-lite`; `gemini-3.8-flash` is the escalation when the extractor reports doubts. Swapping provider or model changes that file and this record, nothing above the sources layer.
6. **The key lives in the macOS Keychain locally** (`scripts/keys.sh`, SETUP.md) and in Vercel's environment in production. It travels in a request header, never a URL, and is redacted from every error and raw record.
7. **Nothing a model reads becomes a deal.** Deals stay editorial (ADR-0003, ADR-0006). The model's other permitted job, matching a page or title to a variant, follows the same evidence-and-rules shape when it is built in phase 4.

## Options rejected

- **Ask the model for a confidence score.** Self-reported confidence is poorly calibrated and unreproducible. Evidence plus rules gives a number that a test can check.
- **A model as the first reader of every page.** Structured data is free, exact and deterministic on most pages. The model reads the remainder.
- **A model with web search as a price source.** Index snippets with no provenance; one was a day stale in today's test.
- **A larger model for extraction.** No measured gain on the sample, five times the cost, twice the latency. Revisit if the labelled set shows the small model failing on a class of page.
- **Provider-neutral abstraction now.** One provider behind one module is the abstraction. A second provider is a second file, not a framework.

## Consequences

- `PriceQuote` carries `confidence` and `evidence` for every source, so the lab and later the `pricing` service can weight quotes: live structured 1, archive 0.9, search 0.8, model-read 0.3 to 0.7.
- The lab shows a model-read quote with its evidence and its reasons, and marks it for review when below the threshold. Rafi's confirmations become the labelled set that measures the extractor.
- Cost is bounded by the number of pages without structured data: cents a day at phase 4 volume.
- The trimmer, not the model, is where accuracy is won. Both misses in the experiment were input defects.
- Revisit when the labelled set reaches fifty pages, when the provider changes its models or prices, or when matching (phase 4) needs the same module.
