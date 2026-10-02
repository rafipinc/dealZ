// Prints the Snapshot for the checked-out commit as one line of JSON. The `metrics` CI job
// appends that line to metrics.jsonl on the `build-log-data` branch after every push to
// main, so the build log has one snapshot per green push. Policy: docs/adr/0014.
//
// Usage: node site/scripts/collect-metrics.ts     (no dependencies beyond Node 22.18)

import { resolve } from "node:path";

import { collectSnapshot } from "./snapshot.ts";

const root = resolve(import.meta.dirname, "../..");
console.log(JSON.stringify(collectSnapshot(root, { testOutput: true })));
