import type { Metadata } from "next";

import { buildLog } from "../../lib/data.ts";

export const metadata: Metadata = { title: "Journeys" };

export default function Journeys() {
  return (
    <>
      <h1>Journeys</h1>
      <p className="lede">
        End-to-end coverage is a registry, not a percentage. Each thing a user can do is registered when it is
        designed. Once its feature ships it must have a browser test, and CI fails when the registry and the test
        files disagree.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Journey</th>
              <th>Actor</th>
              <th>Phase</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {buildLog.journeys.map((j) => (
              <tr key={j.id}>
                <td>
                  <code>{j.id}</code>
                </td>
                <td>{j.journey}</td>
                <td>{j.actor}</td>
                <td>{j.phase}</td>
                <td>
                  <span className={`badge ${j.status === "covered" ? "human" : ""}`}>{j.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
