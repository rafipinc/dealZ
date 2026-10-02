import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Policy: docs/TESTING.md. Coverage thresholds apply to src/lib, src/services
// and src/sources only. Adapters are covered end to end and the schema by the
// PGlite invariant tests, so neither counts towards the threshold.
export default defineConfig({
  // Mirrors the "@/*" path in tsconfig.json so runtime imports resolve under Vitest.
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    passWithNoTests: true,
    // The JSON report and the coverage summary feed the build log's per-commit metrics
    // (site/scripts/collect-metrics.ts, ADR-0015). Both land in coverage/, which is ignored.
    reporters: ["default", ["json", { outputFile: "coverage/test-results.json" }]],
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts", "src/services/**/*.ts", "src/sources/**/*.ts"],
      exclude: ["**/*.test.ts", "src/sources/fixtures/**"],
      reporter: ["text", "lcov", "json-summary"],
      thresholds: { lines: 90, branches: 90 },
    },
  },
});
