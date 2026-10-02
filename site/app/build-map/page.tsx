import type { Metadata } from "next";
import Link from "next/link";
import { Fragment } from "react";

import { StageBadge } from "../../components/badges.tsx";
import { buildLog } from "../../lib/data.ts";
import type { Stage } from "../../lib/types.ts";

export const metadata: Metadata = { title: "Build map" };

const LEGEND: { stage: Stage; meaning: string }[] = [
  { stage: "planned", meaning: "designed, no code" },
  { stage: "spike", meaning: "code written to learn from; may be reshaped" },
  { stage: "built", meaning: "on main; definition of done not yet met" },
  { stage: "tested", meaning: "meets the definition of done" },
  { stage: "shipped", meaning: "in use" },
];

export default function BuildMap() {
  const { components, phases, currentPhase } = buildLog;
  return (
    <>
      <h1>Build map</h1>
      <p className="lede">
        Every component, the layer it belongs to, its stage and the decisions that shaped it. The registry is
        checked against the code on every build: a component marked built must exist, and one marked planned must
        not.
      </p>
      <ul className="legend">
        {LEGEND.map((item) => (
          <li key={item.stage}>
            <StageBadge stage={item.stage} /> {item.meaning}
          </li>
        ))}
      </ul>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Component</th>
              <th>Layer</th>
              <th>Stage</th>
              <th>Decisions</th>
            </tr>
          </thead>
          <tbody>
            {phases.map((phase) => {
              const rows = components.filter((c) => c.phase === phase.id);
              if (rows.length === 0) return null;
              return (
                <Fragment key={phase.id}>
                  <tr>
                    <th colSpan={4} scope="colgroup">
                      {phase.id === "Later" ? "Later" : `Phase ${phase.id}`}: {phase.deliverable}
                      {phase.id === currentPhase ? " · now" : ""}
                    </th>
                  </tr>
                  {rows.map((c) => (
                    <tr key={c.id}>
                      <td>
                        {c.name}
                        <br />
                        <code>{c.path}</code>
                      </td>
                      <td>{c.layer}</td>
                      <td>
                        <StageBadge stage={c.stage} />
                      </td>
                      <td>
                        {c.decisions.map((id, i) => (
                          <Fragment key={id}>
                            {i > 0 ? ", " : ""}
                            <Link href={`/decisions/${id}/`}>{id}</Link>
                          </Fragment>
                        ))}
                      </td>
                    </tr>
                  ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
