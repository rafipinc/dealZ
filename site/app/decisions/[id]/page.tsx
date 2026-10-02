import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { StageBadge, StatusBadge, Who } from "../../../components/badges.tsx";
import { buildLog, decisionById } from "../../../lib/data.ts";

type Props = { params: Promise<{ id: string }> };

export const dynamicParams = false;

export function generateStaticParams() {
  return buildLog.decisions.map((d) => ({ id: d.id }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  return { title: `ADR-${id}` };
}

export default async function DecisionPage({ params }: Props) {
  const { id } = await params;
  const decision = decisionById(id);
  if (!decision) notFound();
  const built = buildLog.components.filter((c) => c.decisions.includes(id));

  return (
    <article>
      <p className="small">
        <Link href="/decisions/">Decisions</Link> / ADR-{decision.id}
      </p>
      <h1>{decision.title}</h1>
      <div className="row-meta">
        <StatusBadge status={decision.status} />
        <Who decider={decision.decider} proposedBy={decision.proposedBy} />
        <span>{decision.date}</span>
      </div>
      {decision.deciderNote ? <p className="small muted">In the record&apos;s words: {decision.deciderNote}.</p> : null}

      {decision.treatment === "summary" ? (
        <div className="prose">
          <h2>Summary</h2>
          <p>{decision.summary}</p>
          <p className="small muted">
            This record is summarised for the public log. The summary covers the architecture; operational detail
            is left out.
          </p>
        </div>
      ) : (
        decision.sections.map((s) => (
          <section key={s.heading} className="prose">
            <h2>{s.heading}</h2>
            <div dangerouslySetInnerHTML={{ __html: s.html }} />
          </section>
        ))
      )}

      {built.length > 0 ? (
        <>
          <h2>Shapes these components</h2>
          <ul className="list">
            {built.map((c) => (
              <li key={c.id} className="row-meta">
                <StageBadge stage={c.stage} /> <span>{c.name}</span> <code>{c.path}</code>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </article>
  );
}
