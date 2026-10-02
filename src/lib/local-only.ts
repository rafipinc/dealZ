// The gate for pages that show the developer's own machine: database state,
// which keys are set, what was spent. Stricter than "not production": only a
// development server passes, so a preview build or a test run never serves
// such a page.

/** True only for `next dev`. Pass process.env.NODE_ENV. */
export function isLocalDevelopment(nodeEnv: string | undefined): boolean {
  return nodeEnv === "development";
}
