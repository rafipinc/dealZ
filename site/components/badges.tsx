import type { Decision, Proposer, Stage } from "../lib/types.ts";

export function StageBadge({ stage }: { stage: Stage }) {
  return <span className={`badge stage-${stage}`}>{stage}</span>;
}

export function StatusBadge({ status }: { status: Decision["status"] }) {
  const label = status === "Proposed" ? "Awaiting Rafi" : status;
  return <span className={`badge status-${status.toLowerCase()}`}>{label}</span>;
}

/** Who decided and who proposed, always shown as two separate facts. */
export function Who({ decider, proposedBy }: { decider: string; proposedBy: Proposer }) {
  return (
    <span className="who">
      <span className="badge human">Decided by {decider}</span>
      <span className={`badge ${proposedBy === "Claude" ? "ai" : proposedBy === "Rafi" ? "human" : "mixed"}`}>
        Proposed by {proposedBy}
      </span>
    </span>
  );
}
