import Link from "next/link";

import { StageBadge } from "../components/badges.tsx";
import { buildLog } from "../lib/data.ts";
import { STAGES } from "../lib/types.ts";

export default function Overview() {
  const { decisions, sessions, components, commits, phases, currentPhase } = buildLog;
  const awaiting = decisions.filter((d) => d.status === "Proposed").length;
  const proposedByClaude = decisions.filter((d) => d.proposedBy === "Claude").length;
  const proposedByRafi = decisions.filter((d) => d.proposedBy === "Rafi").length;
  const joint = decisions.length - proposedByClaude - proposedByRafi;
  const rejected = decisions.reduce((sum, d) => sum + (d.optionsRejected ?? 0), 0);
  const authored = commits.filter((c) => c.pullRequest === null);
  const coAuthored = authored.filter((c) => c.coAuthor !== null).length;
  const merges = commits.length - authored.length;
  const latest = sessions.slice(-3).reverse();

  return (
    <>
      <h1>How DealZ is being built</h1>
      <p className="lede">
        DealZ is a price history and deals app for consumer tech in Australia, built by Rafi Pincus working with
        Claude as a pair. This log shows the method: every architecture decision with who made it, the stage of
        every component, and what each of us brought to each session.
      </p>

      <div className="stats">
        <div className="card stat">
          <div className="n">{decisions.length}</div>
          <div className="label">
            decisions recorded: {decisions.length - awaiting} accepted by Rafi
            {awaiting > 0 ? `, ${awaiting} awaiting his call` : ""}
          </div>
        </div>
        <div className="card stat">
          <div className="n">
            {proposedByRafi} · {proposedByClaude} · {joint}
          </div>
          <div className="label">proposed by Rafi, by Claude, and jointly</div>
        </div>
        <div className="card stat">
          <div className="n">{rejected}</div>
          <div className="label">alternatives weighed and rejected, each with its reason</div>
        </div>
        <div className="card stat">
          <div className="n">{sessions.length}</div>
          <div className="label">working sessions, each logged with what Rafi and Claude brought</div>
        </div>
        <div className="card stat">
          <div className="n">
            {coAuthored}/{authored.length}
          </div>
          <div className="label">
            commits co-authored by Claude; {merges} pull requests reviewed and merged by Rafi
          </div>
        </div>
      </div>

      <h2>The working rules</h2>
      <ul className="prose">
        <li>
          <strong>Rafi decides, Claude proposes.</strong> Options come with trade-offs. Nothing is built until Rafi
          picks, and a proposal is labelled as Claude&apos;s until he accepts it.
        </li>
        <li>
          <strong>Every non-trivial decision is a record</strong> with the options rejected and why. An accepted
          record is never edited; it is superseded.
        </li>
        <li>
          <strong>Done is mechanical.</strong> Tests, a registry of user journeys and a registry of components are
          checked in CI, so &quot;is it tested&quot; and &quot;what stage is it at&quot; have answers a script can
          verify.
        </li>
      </ul>

      <h2>Phases</h2>
      <ol className="phases">
        {phases.map((phase) => {
          const inPhase = components.filter((c) => c.phase === phase.id);
          const current = phase.id === currentPhase;
          return (
            <li key={phase.id} className={`card phase${current ? " current" : ""}`}>
              <div className="tag">
                {phase.id === "Later" ? "Later" : `Phase ${phase.id}`}
                {current ? " · now" : ""}
              </div>
              <h3>{phase.deliverable}</h3>
              <div className="counts">
                {STAGES.map((stage) => {
                  const n = inPhase.filter((c) => c.stage === stage).length;
                  return n > 0 ? (
                    <span key={stage} title={`${n} ${stage}`}>
                      <StageBadge stage={stage} /> <span className="small muted">{n}</span>
                    </span>
                  ) : null;
                })}
              </div>
            </li>
          );
        })}
      </ol>
      <p className="small muted">
        Stage counts come from the <Link href="/build-map/">build map</Link>, which CI checks against the code.
      </p>

      <h2>Latest sessions</h2>
      <ul className="list">
        {latest.map((session) => (
          <li key={session.id} className="card">
            <div className="row-head">
              <span className="num">{session.date}</span>
            </div>
            <div className="split">
              <div>
                <div className="label">Rafi</div>
                <p>{session.rafi}</p>
              </div>
              <div className="claude">
                <div className="label">Claude</div>
                <p>{session.claude}</p>
              </div>
            </div>
          </li>
        ))}
      </ul>
      <p>
        <Link href="/timeline/">Full timeline</Link> · <Link href="/decisions/">All decisions</Link>
      </p>
    </>
  );
}
