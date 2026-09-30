# Status

Where DealZ is right now. Rewritten at the end of every session and read at the start of the next.

**Updated:** 2026-10-01. **Phase:** 1, working database and backend layer. **Step:** price-fetch spike on branch `p1/price-fetch-lab`, uncommitted. The spike has page, search, archive and model sources, four lab panels, and the layered ladder for live prices that Rafi decided on 2026-10-01. Awaiting Rafi's review and the acceptance of ADR-0012 and ADR-0013.

## What exists

- `docs/`: mission, working rules, architecture, data model, setup guide, testing policy, runbook, eleven accepted ADRs and two proposed ([ADR-0012](adr/0012-sources-layer-live-fetch-spike.md), amended 2026-09-28 for the search and archive sources and 2026-10-01 for the layered ladder; [ADR-0013](adr/0013-llm-extraction-boundaries.md), the model reader), four research notes, the AI usage log.
- `src/db/schema.ts` and `src/db/sql/triggers.sql`: the reviewed schema, verified against a real Postgres engine on 2026-09-17. `src/db/client.ts`: the pooler-safe Drizzle client. Migrations `0000_init` and `0001_triggers` applied locally and merged to `main` in pull request #2. Local Supabase stack under Colima; `.env.local` in place.
- The Next.js scaffold, merged in pull request #1: every script from SETUP.md section 3, strict TypeScript, ESLint, Prettier, Tailwind, Vitest with the TESTING.md coverage thresholds, `drizzle.config.ts`, `.env.example`.
- Development conventions per [ADR-0011](adr/0011-development-conventions.md), accepted 2026-09-22: root and nested CLAUDE.md files, six subagents, [TESTING.md](TESTING.md), the [journey registry](../e2e/JOURNEYS.md) with its CI check, the [documentation map](README.md), [RUNBOOK.md](RUNBOOK.md), the CI workflow and the pull request template.
- Architecture reviewed 2026-09-18: `retailers` service in phase 1, read-only `pricing` service planned for phase 3 with journey J-013. LLM use was confined to phase 4; ADR-0013 proposes extraction now, matching still phase 4, never a price fact on its own.
- On the branch, uncommitted, from the 2026-09-28 and 2026-10-01 sessions:
  - `src/lib`: `gtin`, `url`, `money`, `json-ld` (reads condition as well as price), `slug`, `page-text` (visible text, entity decoding, trimming around price marks), pure, with unit tests.
  - `src/sources` per ADR-0012 and ADR-0013, four kinds behind one `PriceQuote` that carries provenance (`live`, `search`, `archive`), condition, confidence, evidence and shipping. Page sources `shopify` (`shopify_json`), `json-ld` (`json_ld`) and `llm_extract` (the model reader: `gemini.ts` is the only file that knows the provider, the key travels in a header, rules in `llm-extract.ts` set the confidence, `REVIEW_THRESHOLD` 0.7). The search source `serpapi` (`serpapi_google_shopping`) as two hops, `google_shopping` for the product entity then `google_immersive_product` for its stores, key redacted from every URL and message. The archive source `wayback`, CDX index first, availability endpoint month by month as fallback, at most three captures in flight, skipped captures reported with their kind. Plus `http`, `limiter`, `index`, `types`. `fetch` is injected; tests replay recorded fixtures, the SerpApi and Gemini ones redacted.
  - `src/services`: `errors.ts`; `tracked-products.ts`, a hand-maintained stand-in for the catalog tables with one variant (slug `samsung-s85h-65-au`, GTIN 08806097962670, MPN QA65S85HAEXXY, RRP $3,299) and seven pages, five fetched live; `quotes.ts` with `fetchQuotes`, `searchQuotes`, `fetchHistory` and `extractQuote`. `fetchQuotes` follows the ladder (ARCHITECTURE.md section 3.1), cheapest route first: structured data, then the model for a page with none when a Gemini key is set, then one Google Shopping search that fills only the retailers still without a price. No gap, no search. The report's `gapFill` says what the search layer did (`not_needed`, `no_key`, `ok`, `failed`); a filled outcome carries `filledBySearch` and `gapReason`. A quote below the threshold is a candidate and never wins cheapest. `extractQuote` reads any URL and matches a tracked variant by GTIN, then MPN. All with tests.
  - The lab page at `/lab`: server component, server actions, four client panels: live prices (confidence and delivery columns, "read by model", "needs review" and "via Google Shopping" badges, the last with the reason the page was not read), Google Shopping table, price history with an inline SVG chart, "Read any page with the model". Journey J-014, planned.
  - `SERPAPI_API_KEY` and `GEMINI_API_KEY` in `.env.example`, optional. Vitest coverage gate extended to `src/sources`; `@/` alias added. ARCHITECTURE.md, root and `src/` CLAUDE.md, TESTING.md, SETUP.md and the ADR index updated. Research notes [live fetch](research/2026-09-28-s85h-live-fetch.md), [SerpApi and Wayback](research/2026-09-28-serpapi-and-wayback.md) and [LLM extraction experiment](research/2026-09-28-llm-extraction-experiment.md).
- API keys for local development live in the macOS Keychain and are injected by `scripts/keys.sh` (`npm run dev:keys`, and the app preview). `GEMINI_API_KEY` and `SERPAPI_API_KEY` are both stored. SETUP.md section 2 documents it.
- The gate is green locally on 2026-10-01: typecheck, lint, 446 tests, about 99 percent lines and 92 percent branches on `src/lib`, `src/services` and `src/sources`.
- Live run on 2026-10-01: five of seven pages answered directly, Powerland cheapest at $2,388. Google Shopping listed 13 sellers, among them Harvey Norman at $2,788 (plus $59 delivery) and Bing Lee at $2,795 (plus $40), the two retailers without a page price.
- The Wayback route verified live on 2026-10-01, its first live run: web.archive.org answered, 16 captures across five retailers, all 16 read, none skipped. Powerland and Toptek have no captures. The Harvey Norman and Bing Lee captures hold the real product page with a price, not the bot challenge. Lowest archived price: JB Hi-Fi, $2,495 on 2026-06-08.
- The earlier run, 2026-09-28 at 15:43, page by page. Live panel, five of seven pages; JB Hi-Fi and The Good Guys matched on GTIN, Samsung AU on model code:

| Retailer | Price | Struck-through | Stock | Against RRP |
|---|---|---|---|---|
| Powerland | $2,388.00 | | in stock | 28 percent under, cheapest |
| JB Hi-Fi | $2,795.00 | $3,295.00 | in stock | 15 percent under |
| The Good Guys | $2,795.00 | $3,295.00 | in stock | 15 percent under |
| Samsung AU | $2,799.00 | | out of stock | 15 percent under |
| Toptek | $4,158.00 | | out of stock | 26 percent over |
| Harvey Norman, Bing Lee | skipped, bot-protected | | | |

Google Shopping panel: 13 sellers through the two hops. Cheapest Appliance Central at $2,388 with free delivery, not tracked. Harvey Norman $2,788 and Bing Lee $2,795 present and resolved to tracked retailers. Extraction panel: Betta's page read at $2,795, was $3,295, model code matched, evidence "Sale price NOW $2,795", confidence 0.5 with a doubt about store-specific pricing, flagged needs review; Videopro blocked (403).

## What does not exist yet

Services `retailers`, `catalog`, `listings`, `observations` and `deals`. PGlite tests for the constraints and triggers. Nothing from a quote is persisted; the tracked variant is a TypeScript table, not rows. No model-read candidate is stored, so the labelled set is empty. Affiliate feeds, the planned long-term route to the chains that block scripted requests, are not verified and not built.

## Next

Phase 1, in this order, one per session unless small:

1. Rafi reviews the lab and the two ADRs, ratifies or reverses the decisions listed under Open. Commit and open the pull request.
2. `src/db/invariants.test.ts` against PGlite: the full matrix in TESTING.md.
3. Persistence services `retailers`, `catalog`, `listings`, `observations`, so quotes and model-read candidates become rows: observations with confidence, staged below the threshold per ADR-0010.

## Open

- The open decisions table in ARCHITECTURE.md section 11. Claude's recommendations for each were reviewed on 2026-09-18 and each becomes an ADR in its phase.
- Decisions the sources agent made on 2026-09-28, for Rafi to ratify or reverse: (1) the `json_ld` source reports Samsung's `sku` as `retailerSku` and leaves `mpn` null, and the `quotes` service counts a retailer SKU equal to the tracked MPN as a model-code match; (2) page sources assume AUD when the page states no currency; (3) the SerpApi source records AUD for region `au` and the upper-cased region code as a placeholder for any other region; (4) a seller link that is not an http URL is kept as SerpApi gave it; (5) the availability fallback tolerates some months failing and throws only when every month fails.
- Decisions from the evening of 2026-09-28, for Rafi to ratify or reverse: (6) `gemini-3.5-flash-lite` as the extraction tier with `gemini-3.8-flash` as the escalation (ADR-0013 item 5); (7) the confidence rule table in ADR-0013 item 3 (a page the model calls not a product page yields no quote rather than a capped one); (8) empty `verifyTokens` rejects every entity in the search source; (9) a hop-1 fallback quote carries confidence 0.5; (10) `extractQuote` keeps the `www` prefix in `retailerName`; (11) a candidate's delta from cheapest can be negative when a reviewed quote undercuts the cheapest; (12) a null currency from the model counts as not AUD.
- Decisions from 2026-10-01 in the gap fill, for Rafi to ratify or reverse: (13) which failures trigger the search: currently any tracked retailer whose outcome is failed or skipped, whatever the failure kind; (14) which listing is used when the search lists one seller more than once: a price before a candidate, then the lowest; (15) a search fill for a listing that is not new is a candidate, never a price, and a candidate row is labelled "candidate" and not counted as priced.
- A labelled set for the extractor: Rafi's confirmations in the lab, target fifty pages. None recorded yet.
- SerpApi's free tier is about 100 calls a month. A search is two calls when the first product entity is accepted and at most four (one hop 1, up to three hop 2), so the free tier is about 50 product refreshes a month; the $75 for 5,000 calls tier is about 3 cents a refresh. Its terms of use are unchecked against the lab's use.
- Terms of use for the seven tracked retailers, and for any page the extraction panel reads, are unread. Required before any scheduled fetching (phase 4).
- Research questions: first five retailers; a non-Samsung model-code check. The JB Hi-Fi Shopify `barcode` question is closed, confirmed on 2026-09-28. The S85H model code ends in `AE`, not `AW`, so the per-brand parser must not assume the `W` suffix.
- Whether `.claude/settings.json` hooks (typecheck on edit, tests on stop) are worth their latency. `npm test` now exists, so this can be decided.
- Four moderate `npm audit` findings in drizzle-kit's bundled esbuild loader, dev-only, no fix available. Recheck when drizzle-kit updates.
