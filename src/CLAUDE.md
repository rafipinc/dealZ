# src/: rules for application code

Loads when a file under `src/` is read. The root CLAUDE.md and ARCHITECTURE.md section 3 hold the full layer rules; this file is the checklist.

## Placement

| Kind of code | Goes in | Test next to it |
|---|---|---|
| Drizzle schema, client, thin queries | `src/db/` | `src/db/invariants.test.ts` (PGlite), `src/db/queries/*.test.ts` |
| Business rules | `src/services/<module>.ts` | `src/services/<module>.test.ts` |
| Typed errors | `src/services/errors.ts` | With the service that throws them |
| Pure helpers | `src/lib/<name>.ts` | `src/lib/<name>.test.ts` |
| Pages, server actions, route handlers | `src/app/` | Covered by e2e, not by unit tests |

## Rules the reviewer checks

1. Nothing outside `src/db` imports from `drizzle-orm` or `postgres`.
2. `src/lib` imports nothing from `src/`.
3. `src/app` imports from `src/services` and `src/lib` only. No SQL, no Drizzle, no business rule. A route handler and a server action that do the same thing call the same service function.
4. Every exported service function validates its input with a Zod schema. Insert shapes come from `drizzle-zod` over the table, never hand-written a second time.
5. Services throw `NotFoundError`, `ConflictError` or `ValidationError`. Adapters map them to status codes or UI state. Nothing else catches them.
6. Money is integer cents. Timestamps are `timestamptz`. GTINs are 14 digits by the time they reach the database.
7. Server components never fetch `/api/v1`. They call the service.
8. No `any` at an exported boundary. `unknown` plus a Zod parse instead.

## Naming

- Files kebab-case, exports camelCase, types PascalCase, database identifiers snake_case (Drizzle maps them).
- Service modules are nouns (`catalog`, `listings`, `observations`, `deals`); their functions are verbs (`createProduct`, `record`, `publish`).
- Test names read as sentences: `it("rejects a GTIN with a bad check digit")`.
