import type { Metadata } from "next";
import Link from "next/link";

import { buildLog } from "../../lib/data.ts";

export const metadata: Metadata = { title: "Timeline" };

export default function Timeline() {
  const { sessions, commits, decisions } = buildLog;
  const days = [...new Set([...sessions.map((s) => s.date), ...commits.map((c) => c.date)])].sort().reverse();

  return (
    <>
      <h1>Timeline</h1>
      <p className="lede">
        Each working session, with what Rafi brought and decided beside what Claude produced, the decisions
        recorded that day and the commits that landed.
      </p>
      {days.map((day) => {
        const daySessions = sessions.filter((s) => s.date === day).reverse();
        const dayCommits = commits.filter((c) => c.date === day);
        const dayDecisions = decisions.filter((d) => d.date === day);
        return (
          <section key={day} className="day">
            <time dateTime={day}>{day}</time>
            <div className="entries">
              {daySessions.map((session) => (
                <div key={session.id} className="card">
                  <div className="split" style={{ marginTop: 0 }}>
                    <div>
                      <div className="label">Rafi</div>
                      <p>{session.rafi}</p>
                    </div>
                    <div className="claude">
                      <div className="label">Claude</div>
                      <p>{session.claude}</p>
                    </div>
                  </div>
                </div>
              ))}
              {dayDecisions.length > 0 ? (
                <div className="small">
                  <span className="muted">Decisions recorded: </span>
                  {dayDecisions.map((d, i) => (
                    <span key={d.id}>
                      {i > 0 ? " · " : ""}
                      <Link href={`/decisions/${d.id}/`}>ADR-{d.id}</Link>
                    </span>
                  ))}
                </div>
              ) : null}
              {dayCommits.length > 0 ? (
                <div className="commits small">
                  <span className="muted">Commits:</span>
                  {dayCommits.map((c) =>
                    c.pullRequest !== null ? (
                      <span key={c.hash} className="badge human">
                        PR #{c.pullRequest} merged by {c.author}
                      </span>
                    ) : (
                      <span key={c.hash} className={`badge ${c.coAuthor ? "mixed" : "human"}`}>
                        {c.area ?? "change"} · {c.author}
                        {c.coAuthor ? ` with ${c.coAuthor}` : ""}
                      </span>
                    ),
                  )}
                </div>
              ) : null}
            </div>
          </section>
        );
      })}
    </>
  );
}
