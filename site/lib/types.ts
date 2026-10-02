// The shape of generated/build-log.json: everything the pages render, and nothing else.

export const STAGES = ["planned", "spike", "built", "tested", "shipped", "retired"] as const;
export type Stage = (typeof STAGES)[number];

export type Proposer = "Rafi" | "Claude" | "Rafi and Claude";
export type DecisionStatus = "Proposed" | "Accepted" | "Superseded";

export interface Decision {
  id: string;
  title: string;
  status: DecisionStatus;
  date: string;
  decider: string;
  proposedBy: Proposer;
  treatment: "full" | "summary";
  /** The Decider line's note in the record's own words. Full records only. */
  deciderNote: string | null;
  /** Hand-written public text. Summary records only. */
  summary: string | null;
  /** Rendered sections of the record. Full records only. */
  sections: { heading: string; html: string }[];
  optionsRejected: number | null;
}

export interface Session {
  id: string;
  date: string;
  rafi: string;
  claude: string;
}

export interface Component {
  id: string;
  name: string;
  layer: string;
  path: string;
  phase: string;
  stage: Stage;
  decisions: string[];
}

export interface Journey {
  id: string;
  journey: string;
  actor: string;
  phase: string;
  status: string;
}

export interface Phase {
  id: string;
  deliverable: string;
}

export interface Commit {
  hash: string;
  date: string;
  /** The subject's area prefix (`db`, `docs`). The subject itself is never published. */
  area: string | null;
  author: string;
  coAuthor: string | null;
  pullRequest: number | null;
}

export interface StackItem {
  name: string;
  role: string;
  version: string;
}

export interface LayerCount {
  layer: string;
  path: string;
  modules: number;
  testFiles: number;
}

/** The stack and the implementation at one commit. CI records one per green push to main. */
export interface Snapshot {
  commit: string;
  date: string;
  stack: StackItem[];
  layers: LayerCount[];
  migrations: number;
  /** Null when the tests were not run for this snapshot (a local build without a test run). */
  tests: { files: number; total: number; passed: number } | null;
  coverage: { lines: number; branches: number; functions: number; statements: number } | null;
  journeys: Record<string, number>;
  ciJobs: string[];
}

export interface Metrics {
  /** The checked-out commit, computed at build time. */
  current: Snapshot;
  /** One snapshot per green push to main, oldest first, as recorded by CI. */
  history: Snapshot[];
}

export interface BuildLog {
  metrics: Metrics;
  generatedAt: string;
  currentPhase: string;
  phases: Phase[];
  decisions: Decision[];
  sessions: Session[];
  components: Component[];
  journeys: Journey[];
  commits: Commit[];
}
