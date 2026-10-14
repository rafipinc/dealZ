"use client";

// Button, inline SVG chart and per-page tables for the price history of one
// tracked variant: Wayback Machine captures of its tracked pages, plus a
// model search over allowed sites with every point verified on its page
// (ADR-0020). Renders the pre-formatted HistoryView; the only arithmetic here
// scales ISO dates and cents onto the viewBox. No chart library: phase 3
// decides that, so nothing is added to package.json.

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { fetchHistoryAction } from "./actions";
import type {
  HistoryChartView,
  HistoryModelSearchView,
  HistoryPageView,
  HistoryPageViewOk,
  HistorySeriesView,
  HistoryView,
  HistoryViewResult,
} from "./view";

const columns = ["Date", "Price", "Was", "Condition", "Snapshot"] as const;
const skippedColumns = ["Date", "Reason", "Snapshot"] as const;
const verifiedColumns = ["Date", "Retailer", "Price", "Dated", "Source", "Evidence"] as const;
const claimColumns = [
  "Verdict",
  "Retailer",
  "Claimed date",
  "Observed",
  "Price",
  "Reason",
  "Source",
] as const;

/** Longest reason shown in a cell; the full text sits in the title attribute. */
const MESSAGE_LIMIT = 160;

const cellClass = "px-3 py-2 align-top";
const mutedClass = "text-zinc-500";
const badgeClass = "rounded-full border px-2 py-0.5 text-xs font-medium";
const linkClass = "text-zinc-700 underline dark:text-zinc-300";
const tableWrapClass = "overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800";
const theadClass = "bg-zinc-100 text-left dark:bg-zinc-900";
const tbodyClass = "divide-y divide-zinc-200 dark:divide-zinc-800";

/** Five strokes that read on both light and dark backgrounds. */
const palette = ["#2563eb", "#16a34a", "#ea580c", "#9333ea", "#dc2626"] as const;

const chartBox = { width: 800, height: 320, left: 72, right: 16, top: 16, bottom: 40 } as const;

/** Marker radius for an archive circle; a model square has the same footprint. */
const MARKER = 4;

function colourOf(colourIndex: number): string {
  return palette[colourIndex % palette.length];
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function truncate(text: string): string {
  return text.length <= MESSAGE_LIMIT ? text : `${text.slice(0, MESSAGE_LIMIT - 1)}…`;
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-wait disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
    >
      {pending ? "Loading…" : "Load price history"}
    </button>
  );
}

function PendingNote() {
  const { pending } = useFormStatus();
  if (!pending) return null;
  return (
    <span role="status" className="text-sm text-zinc-600 dark:text-zinc-400">
      Reading archived pages and asking the model. This is slow, up to a minute.
    </span>
  );
}

function scaleX(x: string, chart: HistoryChartView): number {
  const { left, right, width } = chartBox;
  const start = Date.parse(chart.xMin);
  const span = Date.parse(chart.xMax) - start;
  return left + ((Date.parse(x) - start) / span) * (width - left - right);
}

function scaleY(y: number, chart: HistoryChartView): number {
  const { top, bottom, height } = chartBox;
  return top + ((chart.yMax - y) / (chart.yMax - chart.yMin)) * (height - top - bottom);
}

function Series({ series, chart }: { series: HistorySeriesView; chart: HistoryChartView }) {
  const colour = colourOf(series.colourIndex);
  const scaled = series.points.map((point) => ({
    ...point,
    cx: scaleX(point.x, chart),
    cy: scaleY(point.y, chart),
  }));
  return (
    <g>
      <polyline
        fill="none"
        stroke={colour}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeDasharray={series.kind === "model" ? "4 3" : undefined}
        points={scaled.map((point) => `${point.cx},${point.cy}`).join(" ")}
      />
      {scaled.map((point, index) => (
        <a key={`${point.x}-${index}`} href={point.href} target="_blank" rel="noreferrer">
          {point.kind === "archive" ? (
            <circle cx={point.cx} cy={point.cy} r={MARKER} fill={colour}>
              <title>{point.title}</title>
            </circle>
          ) : (
            <rect
              x={point.cx - MARKER}
              y={point.cy - MARKER}
              width={MARKER * 2}
              height={MARKER * 2}
              fill={colour}
            >
              <title>{point.title}</title>
            </rect>
          )}
        </a>
      ))}
    </g>
  );
}

/** One legend entry per retailer, whichever kinds of series it has. */
function legendRetailers(series: HistorySeriesView[]): HistorySeriesView[] {
  const seen = new Set<string>();
  return series.filter((entry) => {
    if (seen.has(entry.retailerSlug)) return false;
    seen.add(entry.retailerSlug);
    return true;
  });
}

function Chart({ chart }: { chart: HistoryChartView }) {
  const { width, height, left, right, top, bottom } = chartBox;
  const baseline = height - bottom;
  return (
    <figure className="flex flex-col gap-2">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={chart.ariaLabel}
        className="w-full text-zinc-700 dark:text-zinc-300"
      >
        {chart.yTicks.map((tick) => {
          const y = scaleY(tick.y, chart);
          return (
            <g key={tick.y}>
              <line
                x1={left}
                x2={width - right}
                y1={y}
                y2={y}
                stroke="currentColor"
                strokeOpacity={0.15}
              />
              <text
                x={left - 8}
                y={y}
                textAnchor="end"
                dominantBaseline="middle"
                fontSize={12}
                fill="currentColor"
              >
                {tick.label}
              </text>
            </g>
          );
        })}
        <line
          x1={left}
          y1={top}
          x2={left}
          y2={baseline}
          stroke="currentColor"
          strokeOpacity={0.4}
        />
        <line
          x1={left}
          y1={baseline}
          x2={width - right}
          y2={baseline}
          stroke="currentColor"
          strokeOpacity={0.4}
        />
        <text x={left} y={baseline + 20} textAnchor="start" fontSize={12} fill="currentColor">
          {chart.xMinLabel}
        </text>
        <text
          x={width - right}
          y={baseline + 20}
          textAnchor="end"
          fontSize={12}
          fill="currentColor"
        >
          {chart.xMaxLabel}
        </text>
        {chart.series.map((series) => (
          <Series key={`${series.kind}-${series.retailerSlug}`} series={series} chart={chart} />
        ))}
      </svg>
      <figcaption className="flex flex-col gap-1 text-sm">
        <ul className="flex flex-wrap gap-x-4 gap-y-1">
          {legendRetailers(chart.series).map((series) => (
            <li key={series.retailerSlug} className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="inline-block h-3 w-3 rounded-full"
                style={{ backgroundColor: colourOf(series.colourIndex) }}
              />
              {series.retailerName}
            </li>
          ))}
        </ul>
        <p className={mutedClass}>
          <span aria-hidden="true" className="mr-1 inline-block h-3 w-3 rounded-full bg-current" />
          circle: archive capture.{" "}
          <span aria-hidden="true" className="mr-1 inline-block h-3 w-3 bg-current" />
          square: model-found page, verified on the page. Every point links to the page it was read
          from.
        </p>
      </figcaption>
    </figure>
  );
}

function PointsTable({ page }: { page: HistoryPageViewOk }) {
  return (
    <div className={tableWrapClass}>
      <table className="w-full text-sm">
        <thead className={theadClass}>
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col" className={`${cellClass} font-semibold`}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className={tbodyClass}>
          {page.points.map((point) => (
            <tr key={point.snapshotUrl}>
              <td className={`${cellClass} whitespace-nowrap`}>
                <time dateTime={point.date}>{point.label}</time>
              </td>
              <td className={`${cellClass} whitespace-nowrap`}>{point.price}</td>
              <td className={`${cellClass} whitespace-nowrap ${mutedClass}`}>
                {point.was ? <s>{point.was}</s> : <span className="text-zinc-400">not shown</span>}
              </td>
              <td className={cellClass}>{point.conditionLabel}</td>
              <td className={cellClass}>
                <a href={point.snapshotUrl} target="_blank" rel="noreferrer" className={linkClass}>
                  archived page
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SkippedTable({ page }: { page: HistoryPageViewOk }) {
  return (
    <div className={tableWrapClass}>
      <table className="w-full text-sm">
        <thead className={theadClass}>
          <tr>
            {skippedColumns.map((column) => (
              <th key={column} scope="col" className={`${cellClass} font-semibold`}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className={tbodyClass}>
          {page.skipped.map((snapshot) => (
            <tr key={snapshot.snapshotUrl}>
              <td className={`${cellClass} whitespace-nowrap`}>{snapshot.dateLabel}</td>
              <td className={cellClass}>
                <span
                  className={`${badgeClass} border-amber-300 text-amber-700 dark:text-amber-400`}
                >
                  {snapshot.kind}
                </span>
                <span className="ml-2" title={snapshot.message}>
                  {truncate(snapshot.message)}
                </span>
              </td>
              <td className={cellClass}>
                <a
                  href={snapshot.snapshotUrl}
                  target="_blank"
                  rel="noreferrer"
                  className={linkClass}
                >
                  archived page
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** "4 captures found, 3 read, 1 skipped", or the never-captured case. */
function CaptureSummary({ page }: { page: HistoryPageViewOk }) {
  if (page.snapshotsFound === 0) {
    return <p className={`text-sm ${mutedClass}`}>No capture of this page in the window.</p>;
  }
  return (
    <p className={`text-sm ${mutedClass}`}>
      {plural(page.snapshotsFound, "capture")} found, {page.points.length} read,{" "}
      {page.skipped.length} skipped
    </p>
  );
}

function PageSection({ page }: { page: HistoryPageView }) {
  return (
    <section aria-label={page.retailerName} className="flex flex-col gap-2">
      <h4 className="font-medium">
        {page.retailerName}{" "}
        <a
          href={page.url}
          target="_blank"
          rel="noreferrer"
          className={`ml-1 text-sm font-normal ${linkClass}`}
        >
          open
        </a>
      </h4>
      {page.status === "failed" ? (
        <p className="text-sm">
          <span className={`${badgeClass} border-red-300 text-red-700 dark:text-red-400`}>
            {page.kind}
          </span>
          <span className="ml-2">{page.message}</span>
        </p>
      ) : (
        <>
          <CaptureSummary page={page} />
          {page.points.length > 0 ? <PointsTable page={page} /> : null}
          {page.skipped.length > 0 ? <SkippedTable page={page} /> : null}
        </>
      )}
    </section>
  );
}

function VerifiedTable({ search }: { search: Extract<HistoryModelSearchView, { status: "ok" }> }) {
  return (
    <div className={tableWrapClass}>
      <table className="w-full text-sm">
        <thead className={theadClass}>
          <tr>
            {verifiedColumns.map((column) => (
              <th key={column} scope="col" className={`${cellClass} font-semibold`}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className={tbodyClass}>
          {search.verified.map((point, index) => (
            <tr key={`${point.sourceUrl}-${index}`}>
              <td className={`${cellClass} whitespace-nowrap`}>
                <time dateTime={point.date}>{point.label}</time>
              </td>
              <td className={`${cellClass} whitespace-nowrap`}>{point.retailerName}</td>
              <td className={`${cellClass} whitespace-nowrap`}>{point.price}</td>
              <td className={`${cellClass} whitespace-nowrap ${mutedClass}`}>
                {point.dateSourceLabel}
              </td>
              <td className={cellClass}>
                <a href={point.sourceUrl} target="_blank" rel="noreferrer" className={linkClass}>
                  source page
                </a>
              </td>
              <td className={cellClass} title={point.quoteFull}>
                <q>{point.quote}</q>
                <span className={`ml-2 ${mutedClass}`}>{point.confidence}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ClaimsTable({ search }: { search: Extract<HistoryModelSearchView, { status: "ok" }> }) {
  return (
    <div className={tableWrapClass}>
      <table className="w-full text-sm">
        <thead className={theadClass}>
          <tr>
            {claimColumns.map((column) => (
              <th key={column} scope="col" className={`${cellClass} font-semibold`}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className={tbodyClass}>
          {search.claims.map((claim, index) => (
            <tr key={`${claim.sourceUrl}-${index}`}>
              <td className={`${cellClass} whitespace-nowrap`}>
                <span
                  className={`${badgeClass} border-amber-300 text-amber-700 dark:text-amber-400`}
                >
                  {claim.verdictLabel}
                </span>
              </td>
              <td className={`${cellClass} whitespace-nowrap`}>{claim.retailerName}</td>
              <td className={`${cellClass} whitespace-nowrap ${mutedClass}`}>
                {claim.claimedDateLabel}
              </td>
              <td className={`${cellClass} whitespace-nowrap`}>{claim.observedLabel}</td>
              <td className={`${cellClass} whitespace-nowrap`}>{claim.price}</td>
              <td className={cellClass} title={claim.reason}>
                {truncate(claim.reason)}
              </td>
              <td className={cellClass}>
                <a href={claim.sourceUrl} target="_blank" rel="noreferrer" className={linkClass}>
                  cited page
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ModelSearchSection({ search }: { search: HistoryModelSearchView }) {
  return (
    <section aria-label="Model search" className="flex flex-col gap-2">
      <h4 className="font-medium">Model search</h4>
      {search.status === "failed" ? (
        <p className="text-sm">
          <span className={`${badgeClass} border-red-300 text-red-700 dark:text-red-400`}>
            {search.kind}
          </span>
          <span className="ml-2">
            {search.sentence}: {search.message}
          </span>
        </p>
      ) : (
        <p className={`text-sm ${mutedClass}`}>{search.sentence}.</p>
      )}
      {search.status === "ok" ? (
        <>
          <p className={`text-sm ${mutedClass}`}>
            {search.model}, {search.searches} {search.searches === 1 ? "search" : "searches"},{" "}
            {plural(search.pageOpens, "page open")}
          </p>
          {search.verified.length > 0 ? <VerifiedTable search={search} /> : null}
          {search.claims.length > 0 ? <ClaimsTable search={search} /> : null}
        </>
      ) : null}
    </section>
  );
}

function Summary({ view }: { view: HistoryView }) {
  return (
    <p className="text-sm text-zinc-600 dark:text-zinc-400">
      Window {view.fromLabel} to {view.toLabel}, read at {view.fetchedAtLabel}.{" "}
      {view.lowest ? (
        <>
          Lowest price: <strong>{view.lowest.retailerName}</strong> at{" "}
          <strong>{view.lowest.price}</strong> on {view.lowest.label}, from{" "}
          {view.lowest.href ? (
            <a href={view.lowest.href} target="_blank" rel="noreferrer" className={linkClass}>
              {view.lowest.kindLabel === "archive capture" ? "an" : "a"} {view.lowest.kindLabel}
            </a>
          ) : (
            <>
              {view.lowest.kindLabel === "archive capture" ? "an" : "a"} {view.lowest.kindLabel}
            </>
          )}
          .
        </>
      ) : (
        <>No price found.</>
      )}
    </p>
  );
}

function Results({ view }: { view: HistoryView }) {
  return (
    <div className="flex flex-col gap-4">
      <Summary view={view} />
      {view.chart ? (
        <Chart chart={view.chart} />
      ) : (
        <p className={`text-sm ${mutedClass}`}>Nothing to chart.</p>
      )}
      {view.pages.map((page) => (
        <PageSection key={page.retailerSlug} page={page} />
      ))}
      <ModelSearchSection search={view.modelSearch} />
      <details className="text-sm">
        <summary className="cursor-pointer text-zinc-600 dark:text-zinc-400">Raw history</summary>
        <pre className="mt-2 overflow-x-auto rounded-md bg-zinc-100 p-3 text-xs dark:bg-zinc-900">
          {JSON.stringify(view, null, 2)}
        </pre>
      </details>
    </div>
  );
}

export function HistoryPanel({ slug }: { slug: string }) {
  const [view, formAction] = useActionState<HistoryViewResult | null, FormData>(
    fetchHistoryAction,
    null,
  );
  return (
    <div className="flex flex-col gap-4">
      <form action={formAction} className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <input type="hidden" name="slug" value={slug} />
          <SubmitButton />
          <PendingNote />
        </div>
        <p className={`text-sm ${mutedClass}`}>
          Wayback Machine captures of the tracked pages, plus a model search over allowed sites
          (ADR-0020). Every point links to the page it was read from.
        </p>
      </form>
      {view === null ? null : view.ok ? (
        <Results view={view} />
      ) : (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {view.error}
        </p>
      )}
    </div>
  );
}
