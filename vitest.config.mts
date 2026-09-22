import { defineConfig } from "vitest/config";

// Policy: docs/TESTING.md. Coverage thresholds apply to src/lib and
// src/services only. Adapters are covered end to end and the schema by the
// PGlite invariant tests, so neither counts towards the threshold.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts", "src/services/**/*.ts"],
      exclude: ["**/*.test.ts"],
      reporter: ["text", "lcov"],
      thresholds: { lines: 90, branches: 90 },
    },
  },
});
