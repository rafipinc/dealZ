# e2e/: rules for end-to-end tests

Loads when a file under `e2e/` is read. TESTING.md, section End-to-end, is the policy; this is the checklist.

## Structure

- `JOURNEYS.md` is the registry. Every user-facing journey has a row with an ID, a phase and a status. Coverage is measured against this file, not against lines of code.
- One spec per journey: `e2e/<ID>-<slug>.spec.ts`, for example `J-004-publish-deal.spec.ts`. The top-level `test.describe` title starts with the ID.
- `e2e/fixtures/` holds seed helpers. Seeding goes through `src/services`, never raw SQL, so fixtures obey the same invariants as production data.
- `playwright.config.ts` at the repo root, `testDir: "e2e"`, `webServer` runs `npm start` with `reuseExistingServer` on locally.

## Rules

1. `node scripts/check-e2e-coverage.mjs` passes: every `required` or `covered` journey has a spec containing its ID, every spec has a registry row, no `planned` journey has a spec.
2. Locators are role-based: `getByRole`, `getByLabel`, `getByText`. `data-testid` only when no accessible role exists, and the attribute is added to the component in the same change.
3. Each spec seeds what it needs and depends on no other spec. The database is reset between specs with `TRUNCATE ... CASCADE`.
4. No `waitForTimeout`. Wait on a locator or a response.
5. A spec asserts the outcome a user would see, not internal state. Database assertions belong in service or invariant tests.
6. A journey moves `planned` to `required` in the change that ships its feature, and `required` to `covered` when its spec is green in CI.
