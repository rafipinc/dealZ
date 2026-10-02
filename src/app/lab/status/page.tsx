// Lab status: which external services the backend depends on, whether they
// are there, and what was called, how often and at what estimated cost. Reads
// the usage ledger and the status checks on every load. The only thing it
// writes is the ledger row for its own SerpApi account call.
//
// Local-only, decided by Rafi: it shows the state of the developer's own
// machine, so only a development server serves it.

import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SYDNEY } from "@/lib/day-ranges";
import { isLocalDevelopment } from "@/lib/local-only";
import {
  ledgerBlockedReason,
  ledgerReadFailure,
  toStatusView,
  type CheckView,
  type Tone,
} from "@/lib/status-view";
import {
  toUsageView,
  type CallView,
  type ChartView,
  type LastOkView,
  type UsageTableView,
  type UsageView,
} from "@/lib/usage-view";
import { checkServices, safeFailureMessage } from "@/services/status";
import { dashboard } from "@/services/usage";

export const metadata: Metadata = { title: "Lab: services and usage" };

// Live state on every request: never prerendered, never cached.
export const dynamic = "force-dynamic";

/** The one zone every day and time on this page is in. */
const TIME_ZONE = SYDNEY;
const CHART_DAYS = 30;
const RECENT_CALLS = 20;

const cellClass = "px-3 py-2 align-top";
const numberClass = `${cellClass} text-right tabular-nums whitespace-nowrap`;
const mutedClass = "text-zinc-500";
const leadClass = "text-sm text-zinc-600 dark:text-zinc-400";
const badgeClass = "rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap";
const linkClass = "text-zinc-700 underline dark:text-zinc-300";
const tableWrapClass = "overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800";
const cardClass = "flex flex-col gap-5 rounded-lg border border-zinc-200 p-5 dark:border-zinc-800";

const toneClasses: Record<Tone, string> = {
  good: "border-green-300 text-green-700 dark:text-green-400",
  warn: "border-amber-300 text-amber-700 dark:text-amber-400",
  bad: "border-red-300 text-red-700 dark:text-red-400",
  muted: "border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400",
};

/** The history panel's strokes: they read on both light and dark backgrounds. */
const palette = ["#2563eb", "#16a34a", "#ea580c", "#9333ea", "#dc2626"] as const;

const chartBox = { width: 800, height: 240, left: 48, right: 8, top: 12, bottom: 28 } as const;

function colourOf(colourIndex: number): string {
  return palette[colourIndex % palette.length];
}

type UsageResult = { ok: true; view: UsageView } | { ok: false; reason: string };

/** Reads the ledger through the one dashboard call. A failure is a reason to show, never a thrown page. */
async function loadUsage(now: Date): Promise<UsageResult> {
  try {
    const usage = await dashboard({
      now,
      timeZone: TIME_ZONE,
      days: CHART_DAYS,
      recentLimit: RECENT_CALLS,
    });
    return { ok: true, view: toUsageView(usage) };
  } catch (error) {
    // Redacted by the service, as its own check messages are: a database
    // error can quote the connection string.
    return { ok: false, reason: ledgerReadFailure(safeFailureMessage(error)) };
  }
}

function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`${badgeClass} ${toneClasses[tone]}`}>{children}</span>;
}

function Section({ title, lead, children }: { title: string; lead: string; children: ReactNode }) {
  return (
    <section
      aria-label={title}
      className="flex flex-col gap-3 border-t border-zinc-200 pt-4 dark:border-zinc-800"
    >
      <h3 className="text-lg font-semibold">{title}</h3>
      <p className={leadClass}>{lead}</p>
      {children}
    </section>
  );
}

function HeaderRow({ columns, numericFrom }: { columns: readonly string[]; numericFrom: number }) {
  return (
    <thead className="bg-zinc-100 text-left dark:bg-zinc-900">
      <tr>
        {columns.map((column, index) => (
          <th
            key={column}
            scope="col"
            className={`${cellClass} font-semibold ${index >= numericFrom ? "text-right" : ""}`}
          >
            {column}
          </th>
        ))}
      </tr>
    </thead>
  );
}

function CheckRow({ name, check }: { name: string; check: CheckView }) {
  return (
    <tr>
      <th scope="row" className={`${cellClass} text-left font-medium whitespace-nowrap`}>
        {name}
      </th>
      <td className={cellClass}>
        <Badge tone={check.tone}>{check.badge}</Badge>
      </td>
      <td className={cellClass}>
        {check.detail}
        {check.note === null ? null : (
          <span className={`mt-1 block break-words ${mutedClass}`}>{check.note}</span>
        )}
      </td>
    </tr>
  );
}

function LastOkTable({ rows }: { rows: LastOkView[] }) {
  if (rows.length === 0) {
    return <p className={`text-sm ${mutedClass}`}>No call has succeeded yet.</p>;
  }
  return (
    <div className={tableWrapClass}>
      <table className="w-full text-sm">
        <HeaderRow
          columns={["Provider", "Retailer", "Last successful call", "Age"]}
          numericFrom={99}
        />
        <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {rows.map((row) => (
            <tr key={row.key}>
              <td className={`${cellClass} font-medium`}>{row.provider}</td>
              <td className={`${cellClass} font-mono text-xs`}>{row.retailer}</td>
              <td className={`${cellClass} whitespace-nowrap`}>
                <time dateTime={row.lastOkAt}>{row.lastOkAtLabel}</time>
              </td>
              <td className={`${cellClass} whitespace-nowrap`}>{row.age}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const usageColumns = [
  "Provider",
  "Calls",
  "Ok",
  "Failed",
  "Tokens in",
  "Tokens out",
  "Estimated cost (USD)",
] as const;

function UnpricedNote({ note }: { note: string | null }) {
  if (note === null) return null;
  return <p className="text-sm text-amber-700 dark:text-amber-400">{note}</p>;
}

function UsageTable({ table, emptyText }: { table: UsageTableView; emptyText: string }) {
  if (table.totals === null) {
    return <p className={`text-sm ${mutedClass}`}>{emptyText}</p>;
  }
  return (
    <>
      <UsageTableBody table={table} totals={table.totals} />
      <UnpricedNote note={table.unpricedNote} />
    </>
  );
}

function UsageTableBody({
  table,
  totals,
}: {
  table: UsageTableView;
  totals: NonNullable<UsageTableView["totals"]>;
}) {
  return (
    <div className={tableWrapClass}>
      <table className="w-full text-sm">
        <HeaderRow columns={usageColumns} numericFrom={1} />
        <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {table.rows.map((row) => (
            <tr key={row.key}>
              <th scope="row" className={`${cellClass} text-left font-medium`}>
                {row.label}
              </th>
              <td className={numberClass}>{row.calls}</td>
              <td className={numberClass}>{row.ok}</td>
              <td
                className={`${numberClass} ${row.hasFailures ? "text-red-700 dark:text-red-400" : ""}`}
              >
                {row.failed}
              </td>
              <td className={numberClass}>{row.tokensIn}</td>
              <td className={numberClass}>{row.tokensOut}</td>
              <td className={numberClass}>{row.cost}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t border-zinc-300 font-semibold dark:border-zinc-700">
          <tr>
            <th scope="row" className={`${cellClass} text-left`}>
              {totals.label}
            </th>
            <td className={numberClass}>{totals.calls}</td>
            <td className={numberClass}>{totals.ok}</td>
            <td className={numberClass}>{totals.failed}</td>
            <td className={numberClass}>{totals.tokensIn}</td>
            <td className={numberClass}>{totals.tokensOut}</td>
            <td className={numberClass}>{totals.cost}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function DailyChart({ chart }: { chart: ChartView }) {
  const { width, height, left, right, top, bottom } = chartBox;
  const baseline = height - bottom;
  const plotHeight = baseline - top;
  const slot = (width - left - right) / chart.bars.length;
  const barWidth = Math.max(2, slot * 0.7);
  const yOf = (value: number) => baseline - (value / chart.yMax) * plotHeight;
  return (
    <figure className="flex flex-col gap-2">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={chart.ariaLabel}
        className="w-full text-zinc-700 dark:text-zinc-300"
      >
        {chart.yTicks.map((tick) => (
          <g key={tick.value}>
            <line
              x1={left}
              x2={width - right}
              y1={yOf(tick.value)}
              y2={yOf(tick.value)}
              stroke="currentColor"
              strokeOpacity={tick.value === 0 ? 0.4 : 0.15}
            />
            <text
              x={left - 8}
              y={yOf(tick.value)}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize={12}
              fill="currentColor"
            >
              {tick.label}
            </text>
          </g>
        ))}
        <text x={left} y={baseline + 18} textAnchor="start" fontSize={12} fill="currentColor">
          {chart.firstDayLabel}
        </text>
        <text
          x={width - right}
          y={baseline + 18}
          textAnchor="end"
          fontSize={12}
          fill="currentColor"
        >
          {chart.lastDayLabel}
        </text>
        {chart.bars.map((bar, index) => {
          const x = left + index * slot + (slot - barWidth) / 2;
          return (
            <g key={bar.day}>
              <title>{bar.title}</title>
              {/* A full-height, invisible target so an empty day still has a tooltip. */}
              <rect
                x={left + index * slot}
                y={top}
                width={slot}
                height={plotHeight}
                fill="transparent"
              />
              {bar.segments.map((segment) => (
                <rect
                  key={segment.provider}
                  x={x}
                  y={yOf(segment.base + segment.calls)}
                  width={barWidth}
                  height={yOf(segment.base) - yOf(segment.base + segment.calls)}
                  fill={colourOf(segment.colourIndex)}
                />
              ))}
            </g>
          );
        })}
      </svg>
      <figcaption>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {chart.legend.map((entry) => (
            <li key={entry.provider} className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="inline-block h-3 w-3 rounded-sm"
                style={{ backgroundColor: colourOf(entry.colourIndex) }}
              />
              {entry.label}
            </li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}

function ActiveDaysTable({ chart }: { chart: ChartView }) {
  return (
    <div className={tableWrapClass}>
      <table className="w-full text-sm">
        <HeaderRow
          columns={["Day", "By provider", "Calls", "Estimated cost (USD)"]}
          numericFrom={2}
        />
        <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {chart.activeDays.map((day) => (
            <tr key={day.day}>
              <td className={`${cellClass} whitespace-nowrap`}>
                <time dateTime={day.day}>{day.label}</time>
              </td>
              <td className={cellClass}>{day.breakdown}</td>
              <td className={numberClass}>{day.calls}</td>
              <td className={numberClass}>{day.cost}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const callColumns = [
  "Time",
  "Provider",
  "Operation",
  "Retailer",
  "Outcome",
  "HTTP",
  "Duration",
  "Tokens",
  "Estimated cost (USD)",
] as const;

function CallsTable({ calls }: { calls: CallView[] }) {
  if (calls.length === 0) {
    return <p className={`text-sm ${mutedClass}`}>No call recorded yet.</p>;
  }
  return (
    <div className={tableWrapClass}>
      <table className="w-full text-sm">
        <HeaderRow columns={callColumns} numericFrom={5} />
        <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {calls.map((call) => (
            <tr key={call.id}>
              <td className={`${cellClass} whitespace-nowrap`}>
                <time dateTime={call.calledAt}>{call.calledAtLabel}</time>
              </td>
              <td className={`${cellClass} font-medium whitespace-nowrap`}>{call.provider}</td>
              <td className={`${cellClass} font-mono text-xs`}>{call.operation}</td>
              <td className={`${cellClass} font-mono text-xs`}>{call.retailer}</td>
              <td className={cellClass}>
                <Badge tone={call.ok ? "good" : "bad"}>{call.outcome}</Badge>
              </td>
              <td className={numberClass}>{call.httpStatus}</td>
              <td className={numberClass}>{call.duration}</td>
              <td className={numberClass} title={call.model ?? undefined}>
                {call.tokens}
              </td>
              <td className={numberClass}>{call.cost}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Unavailable({ reason }: { reason: string }) {
  return (
    <p role="alert" className="text-sm break-words text-red-700 dark:text-red-400">
      {reason}
    </p>
  );
}

function UsageSections({ view }: { view: UsageView }) {
  if (view.empty) {
    return (
      <p className={leadClass}>
        The ledger is empty. Fetch live prices, run a search or load a price history in the{" "}
        <Link href="/lab" className={linkClass}>
          lab
        </Link>{" "}
        and every outbound call appears here.
      </p>
    );
  }
  return (
    <>
      <Section title="Today" lead="Calls since midnight, per provider.">
        <UsageTable table={view.today} emptyText="No call today." />
      </Section>
      <Section title="Month to date" lead="Calls since the first of the month, per provider.">
        <UsageTable table={view.monthToDate} emptyText="No call this month." />
      </Section>
      <Section title={`Last ${view.dayCount} days`} lead="Calls per day, stacked by provider.">
        {view.chart === null ? (
          <p className={`text-sm ${mutedClass}`}>No call in the last {view.dayCount} days.</p>
        ) : (
          <>
            <p className={leadClass}>{view.chart.summary}</p>
            <DailyChart chart={view.chart} />
            <ActiveDaysTable chart={view.chart} />
            <UnpricedNote note={view.chart.unpricedNote} />
          </>
        )}
      </Section>
      <Section title={`Last ${RECENT_CALLS} calls`} lead="Newest first.">
        <CallsTable calls={view.recent} />
      </Section>
    </>
  );
}

export default async function LabStatusPage() {
  if (!isLocalDevelopment(process.env.NODE_ENV)) notFound();

  const now = new Date();
  const services = await checkServices({ now: () => now });
  const status = toStatusView(services, TIME_ZONE);
  // The database check has already waited for the database once, with a bound.
  // When it says the ledger cannot be read, the ledger is not asked again.
  const blocked = ledgerBlockedReason(services.database);
  const usage: UsageResult =
    blocked === null ? await loadUsage(now) : { ok: false, reason: blocked };

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-semibold tracking-tight">Lab: services and usage</h1>
        <p className="text-zinc-600 dark:text-zinc-400">
          What the backend calls, whether it is there, and what the calls cost. Local only. Every
          day and time on this page is in {TIME_ZONE}. Checked at {status.checkedAtLabel}; reload to
          check again.
        </p>
        <p className="text-sm">
          <Link href="/lab" className={linkClass}>
            Back to the lab
          </Link>
        </p>
      </header>

      <section aria-label="Services" className={cardClass}>
        <h2 className="text-xl font-semibold tracking-tight">Services</h2>
        <div className={tableWrapClass}>
          <table className="w-full text-sm">
            <HeaderRow columns={["Service", "State", "Detail"]} numericFrom={99} />
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              <CheckRow name="Database" check={status.database} />
              {status.keys.map((key) => (
                <tr key={key.name}>
                  <th
                    scope="row"
                    className={`${cellClass} text-left font-mono text-xs font-medium`}
                  >
                    {key.name}
                  </th>
                  <td className={cellClass}>
                    <Badge tone={key.tone}>{key.badge}</Badge>
                  </td>
                  <td className={`${cellClass} ${mutedClass}`}>
                    Only whether the key is set. Its value is never read by this page.
                  </td>
                </tr>
              ))}
              <CheckRow name="SerpApi account" check={status.serpApiAccount} />
            </tbody>
          </table>
        </div>
        <Section
          title="Last successful call"
          lead="When each provider last answered, per retailer where the call was for one."
        >
          {usage.ok ? (
            <LastOkTable rows={usage.view.lastOk} />
          ) : (
            <Unavailable reason={usage.reason} />
          )}
        </Section>
      </section>

      <section aria-label="Usage" className={cardClass}>
        <header className="flex flex-col gap-1">
          <h2 className="text-xl font-semibold tracking-tight">Usage</h2>
          <p className={leadClass}>
            One ledger row per outbound call, including the SerpApi account check this page makes.
            Costs are estimated from a price table in US dollars, not read from an invoice. A
            provider that charges nothing shows as free; a model with no price in the table shows as
            unpriced.
          </p>
        </header>
        {usage.ok ? <UsageSections view={usage.view} /> : <Unavailable reason={usage.reason} />}
      </section>
    </main>
  );
}
