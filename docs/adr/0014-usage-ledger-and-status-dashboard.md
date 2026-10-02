# ADR-0014: A usage ledger in local Postgres and a local-only status dashboard, with no budget cap

**Status:** Accepted (2026-10-02)
**Date:** 2026-10-01
**Decider:** Rafi (proposed by Claude). Rafi decided: local only, no caps, the ledger in local Postgres, the dashboard ahead of the phase 1 queue. Rafi delegated the remaining design decisions to Claude the same day ("implement best practices on the decisions needed"); those are marked "delegated" below. Rafi accepted the record, delegated items included, on 2026-10-02.

## Context

The price-fetch spike of [ADR-0012](0012-sources-layer-live-fetch-spike.md) and [ADR-0013](0013-llm-extraction-boundaries.md) calls four kinds of external service: retailer pages, SerpApi, Gemini and the Wayback Machine. Two are billed or metered against a quota. Nothing recorded what was called, how often, with what outcome or at what cost, and nothing showed whether the database, the migrations and the keys were in place.

On 2026-10-01 Rafi asked for a dashboard for data insights and API spending, reachable only by him. Claude proposed `/admin` with spend, fetch health and data insights, a usage ledger, Supabase Auth with middleware, and a budget cap. Rafi narrowed it: local configuration only, purely to keep track of backend services and usage, no caps for now. He then decided that the dashboard is built now, ahead of the PGlite invariant matrix and the persistence services, and that the ledger lives in local Postgres. The first build left a list of smaller decisions open. Rafi delegated them to Claude and asked for a basic running dashboard.

## Decision

Decided by Rafi:

1. **The dashboard is local only.** `/lab/status` is a server component served only when `NODE_ENV` is `development`. No authentication, because nothing outside the developer's machine can reach it. Two sections, Services and Usage.
2. **No budget cap.** The ledger records and the page shows. Nothing blocks a call.
3. **The ledger lives in the local Postgres**, through the same migrations as every other table.
4. **The dashboard is built now**, ahead of the invariant matrix and the persistence services. Data insights (prices, coverage, matches) are deferred until those services exist.

Proposed by Claude in the first build:

5. **A usage ledger, the table `api_usage`.** One row per outbound HTTP request to an external service, written whether the request succeeded or failed. It never holds an API key or a request URL. Columns are defined in [`src/db/schema.ts`](../../src/db/schema.ts) and explained in [DATA_MODEL.md](../DATA_MODEL.md).
6. **The ledger is append-only**, enforced by the trigger `api_usage_append_only` in [`src/db/sql/api-usage-triggers.sql`](../../src/db/sql/api-usage-triggers.sql). It is the second append-only table after `price_observation` (ADR-0007).
7. **`retailer_slug` and `variant_slug` are text, not foreign keys.** The tracked products are a TypeScript table until the persistence services exist, and a ledger row must not block deleting a catalogue row.
8. **Sources report calls through an injected `meter`.** A source takes an optional `meter` callback beside `fetch` and hands it one `SourceCall` per HTTP request. A source still never touches the database. A meter that throws is ignored. A 200 answer that carries an error body is a failed call. Gemini output tokens include thinking tokens, because they are billed as output.
9. **Two services.** `usage` writes the ledger (`record`) and reads it (`summary`, `daily`, `recentCalls`, `lastOk`, `dashboard`). `status` checks what the backend depends on (`checkServices`): the database and its migrations, whether each key is set, and the SerpApi account. It never returns a key's value.
10. **Recording is best effort.** A service collects the calls its sources make and writes them at the end, waiting at most 2 seconds (`src/services/usage-ledger.ts`). A ledger that cannot be written never changes a report. Each report says how many calls were made and how many were recorded.

Delegated by Rafi, decided by Claude on best practice:

11. **`cost_micros`, millionths of a US dollar, is the one exception to integer cents.** A single model call costs a fraction of a cent and would round to zero. Still an integer. It is an estimate from a hand-maintained price table (`src/lib/api-prices.ts`), fixed at write time. The provider's invoice is the truth. `src/CLAUDE.md` rule 6 states the exception.
12. **The price table is dated.** A call is priced by the entry in force when it started, so a row keeps the cost of its day when a price changes. Gemini prices were checked against the provider's pricing page on 2026-10-01: 3.5 Flash-Lite USD 0.30 input and 2.50 output per million tokens; 3.8 Flash 0.75 and 3.75 through 2026-12-31, then 1.50 and 7.50 from 2027-01-01.
13. **Only what the provider bills is charged.** A SerpApi call is charged only when it is a successful search; the Account API and failed calls cost 0. The rate is 0 while the account is on the free tier. A failed Gemini call that reports tokens is still priced, since the tokens are billed.
14. **A model missing from the price table shows as "unpriced".** Decided when a row is read (`isPriced`), not stored. A total that includes unpriced calls is shown as a lower bound. No schema change.
15. **No exception to "one row per outbound call".** The status check's own SerpApi Account call is written to the ledger, operation `account`, cost 0.
16. **One time zone, Australia/Sydney, for the whole page**, the 30-day chart included. The daily query takes a time zone.
17. **The page calls two services**: `checkServices` and one `usage.dashboard({ now, timeZone })`. The strings the page shows are shaped by pure helpers in `src/lib`, inside the coverage gate.
18. **`/lab` and its four server actions take the same gate as `/lab/status`**: development only. Before, they were blocked only in production.
19. **One hand-written SQL file per custom trigger migration.** Each file in `src/db/sql/` is paired with exactly one custom migration and stays byte-identical to it. A trigger change is a new file plus a new migration. `src/db/CLAUDE.md` rule 3 and SETUP.md section 4 state it. The hyphenated migration names (`0002_api-usage`) stay; they are applied.
20. **Journeys J-014 and J-015 stay `planned`.** Playwright runs the production build, where both lab pages return 404, so a spec cannot reach them. They are verified by unit tests and by hand. This sits in tension with `e2e/CLAUDE.md` rule 6, which moves a journey to `required` in the change that ships its feature. The rule is left as it is; the registry carries a note. A lab page that becomes a product feature follows the rule.

## Options rejected

- **`/admin` behind Supabase Auth now.** Auth is phase 2. A page that only runs on the developer's machine needs no login.
- **A git-ignored JSONL file as the ledger.** No constraints, no queries, and a second storage path to maintain. Postgres already runs locally.
- **Sources returning usage inside their results.** A failed call returns no result, so its usage would be lost, and every source's return type would change.
- **A budget cap.** Rafi ruled it out for now. The free tiers already bound spend, and a cap needs a policy for what a blocked fetch reports.
- **One cumulative `triggers.sql`.** It would have to change after its migration was applied, which breaks the rule that an applied pair stays identical.
- **A `priced` column on the ledger.** A schema change for a fact the price table already answers, and it would freeze "unpriced" on rows whose model is priced later.
- **UTC days for the daily chart.** Two calendars on one page. Today and month to date are Sydney days, so the chart is too.
- **Leaving the status check's Account call out of the ledger.** An exception to the table's one rule, for no saving.
- **Charging SerpApi per call whatever the outcome.** The provider does not bill a failed search or the Account API.
- **A new journey status, or a checker exemption, for development-only pages.** A change to the registry's vocabulary for two pages. A note is enough.

## Consequences

- Spend, quota and failure rates are visible per provider and per day. The first live read showed the Wayback CDX index failing and the availability fallback carrying the run, which no report had surfaced.
- The spike's rule "nothing is persisted" (ADR-0012 item 6) narrows to "no price is persisted". Calls are.
- The estimate is only as good as the price table. When a provider changes a price, an entry is added; an entry that has applied is never edited. When the SerpApi plan changes, the per-call rate is set.
- "Unpriced" follows the table as it is when the page is read. A model added to the table later is priced from then on, but rows already written keep their stored cost of zero.
- The lab is unreachable in a preview or production build. Showing it to anyone else needs a decision and auth.
- The number 0014 is also used by an uncommitted record in another session's worktree (`p1/build-log`). This record keeps the number because the schema, the trigger SQL and the documents cite it; the other becomes ADR-0015 (Rafi, 2026-10-02).
- Revisit when the app is deployed (a hosted view needs auth and a production ledger), when a paid tier is taken (a cap becomes worth its policy), and when the persistence services exist (slugs can become foreign keys, and the data insights section can be built).
