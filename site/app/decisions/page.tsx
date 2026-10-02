import type { Metadata } from "next";
import Link from "next/link";

import { StatusBadge, Who } from "../../components/badges.tsx";
import { buildLog } from "../../lib/data.ts";

export const metadata: Metadata = { title: "Decisions" };

export default function Decisions() {
  const decisions = [...buildLog.decisions].reverse();
  return (
    <>
      <h1>Decisions</h1>
      <p className="lede">
        One record per non-trivial decision. Each names who decided, who proposed it and what was rejected. A
        proposal from Claude does not count until Rafi accepts it.
      </p>
      <ul className="list">
        {decisions.map((d) => (
          <li key={d.id} className="card">
            <div className="row-head">
              <span className="num">ADR-{d.id}</span>
              <h3>
                <Link href={`/decisions/${d.id}/`}>{d.title}</Link>
              </h3>
            </div>
            <div className="row-meta">
              <StatusBadge status={d.status} />
              <Who decider={d.decider} proposedBy={d.proposedBy} />
              <span>{d.date}</span>
              {d.optionsRejected !== null ? <span>{d.optionsRejected} options rejected</span> : null}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
