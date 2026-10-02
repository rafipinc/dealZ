// Pure readers for the facts about the stack and the implementation that CI records
// once per commit on main. File contents and listings in, one Snapshot out. No IO here.

import { ParseError } from "./parse.ts";
import type { ParsedJourney } from "./parse.ts";
import type { LayerCount, Snapshot, StackItem } from "./types.ts";

/**
 * The packages worth showing, with the part each plays. An allowlist: a dependency that is
 * not named here is never published, whatever package.json gains later.
 */
const STACK: { pkg: string; name: string; role: string }[] = [
  { pkg: "typescript", name: "TypeScript", role: "Language" },
  { pkg: "next", name: "Next.js", role: "Framework" },
  { pkg: "react", name: "React", role: "UI" },
  { pkg: "tailwindcss", name: "Tailwind CSS", role: "Styling" },
  { pkg: "drizzle-orm", name: "Drizzle ORM", role: "Data access" },
  { pkg: "drizzle-kit", name: "Drizzle Kit", role: "Migrations" },
  { pkg: "postgres", name: "postgres.js", role: "Database driver" },
  { pkg: "zod", name: "Zod", role: "Validation at boundaries" },
  { pkg: "vitest", name: "Vitest", role: "Unit and database tests" },
  { pkg: "@electric-sql/pglite", name: "PGlite", role: "In-process Postgres for tests" },
  { pkg: "@playwright/test", name: "Playwright", role: "End-to-end tests" },
  { pkg: "eslint", name: "ESLint", role: "Lint" },
  { pkg: "prettier", name: "Prettier", role: "Format" },
];

const LAYERS: { layer: string; path: string }[] = [
  { layer: "Database", path: "src/db/" },
  { layer: "Services", path: "src/services/" },
  { layer: "Sources", path: "src/sources/" },
  { layer: "Adapters", path: "src/app/" },
  { layer: "Shared", path: "src/lib/" },
];

function parseJson(file: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ParseError(file, "is not valid JSON");
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

/** Installed versions from the lockfile when there is one, otherwise the declared range. */
export function stackFrom(packageJson: string, lockJson: string | null): StackItem[] {
  const pkg = record(parseJson("package.json", packageJson));
  const declared = { ...record(pkg.dependencies), ...record(pkg.devDependencies) };
  const locked = lockJson === null ? {} : record(record(parseJson("package-lock.json", lockJson)).packages);

  return STACK.flatMap(({ pkg: name, name: label, role }) => {
    const range = declared[name];
    if (typeof range !== "string") return [];
    const installed = record(locked[`node_modules/${name}`]).version;
    const version = typeof installed === "string" ? installed : range.replace(/^[\^~]/, "");
    return [{ name: label, role, version }];
  });
}

const isTest = (path: string): boolean => /\.test\.tsx?$/.test(path);
const isModule = (path: string): boolean => /\.tsx?$/.test(path) && !isTest(path) && !path.includes("/fixtures/");

/** Modules and test files per layer, from a listing of tracked files. Counts only, never names. */
export function layerCounts(files: string[]): LayerCount[] {
  return LAYERS.map(({ layer, path }) => {
    const inLayer = files.filter((file) => file.startsWith(path));
    return { layer, path, modules: inLayer.filter(isModule).length, testFiles: inLayer.filter(isTest).length };
  });
}

export function migrationCount(files: string[]): number {
  return files.filter((file) => /^drizzle\/migrations\/[^/]+\.sql$/.test(file)).length;
}

/** Totals from Vitest's JSON reporter. */
export function testTotals(vitestJson: string): Snapshot["tests"] {
  const file = "coverage/test-results.json";
  const report = record(parseJson(file, vitestJson));
  const { numTotalTests: total, numPassedTests: passed, testResults } = report;
  if (typeof total !== "number" || typeof passed !== "number" || !Array.isArray(testResults)) {
    throw new ParseError(file, "is not a Vitest JSON report");
  }
  return { files: testResults.length, total, passed };
}

/** Percentages from the coverage provider's json-summary reporter. */
export function coverageTotals(summaryJson: string): Snapshot["coverage"] {
  const file = "coverage/coverage-summary.json";
  const total = record(record(parseJson(file, summaryJson)).total);
  const pct = (key: string): number => {
    const value = record(total[key]).pct;
    if (typeof value !== "number") throw new ParseError(file, `has no total.${key}.pct`);
    return value;
  };
  return { lines: pct("lines"), branches: pct("branches"), functions: pct("functions"), statements: pct("statements") };
}

/** The display name of each job in a GitHub Actions workflow, or its id when it has none. */
export function ciJobNames(workflowYaml: string): string[] {
  const lines = workflowYaml.split("\n");
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (start === -1) return [];
  const names: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (/^\S/.test(line)) break;
    const id = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)?.[1];
    if (!id) continue;
    const name = /^ {4}name:\s*(.+?)\s*$/.exec(lines[i + 1] ?? "")?.[1];
    names.push(name ?? id);
  }
  return names;
}

export function journeyCounts(journeys: ParsedJourney[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { status } of journeys) counts[status] = (counts[status] ?? 0) + 1;
  return counts;
}

/** One snapshot per line, as CI appends them. Oldest first. */
export function parseHistory(jsonl: string): Snapshot[] {
  return jsonl
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, i) => {
      const snapshot = parseJson(`metrics.jsonl line ${i + 1}`, line);
      if (!isRecord(snapshot) || typeof snapshot.commit !== "string" || typeof snapshot.date !== "string") {
        throw new ParseError(`metrics.jsonl line ${i + 1}`, "is not a snapshot");
      }
      return snapshot as unknown as Snapshot;
    });
}
