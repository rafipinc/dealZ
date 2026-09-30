"use client";

// Button plus results table for one tracked variant. Renders the pre-formatted
// QuoteView; the only logic here is picking a colour for a sign and muting a
// row the service flagged for review.

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { fetchQuotesAction } from "./actions";
import type {
  QuoteOutcomeViewFailed,
  QuoteOutcomeViewOk,
  QuoteOutcomeViewSkipped,
  QuoteView,
  QuoteViewOk,
} from "./view";

const columns = [
  "Retailer",
  "Price",
  "Was",
  "Delivery",
  "vs cheapest",
  "vs RRP",
  "Confidence",
  "Stock",
  "Identifiers",
  "Source",
  "Link",
] as const;

const cellClass = "px-3 py-2 align-top";
const mutedClass = "text-zinc-500";
const badgeClass = "rounded-full border px-2 py-0.5 text-xs font-medium";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-wait disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
    >
      {pending ? "Fetching…" : "Fetch live prices"}
    </button>
  );
}

function PageLink({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="text-zinc-700 underline dark:text-zinc-300"
    >
      open
    </a>
  );
}

function OkRow({ outcome }: { outcome: QuoteOutcomeViewOk }) {
  const rrpClass =
    outcome.deltaFromRrpCents < 0
      ? "text-green-700 dark:text-green-400"
      : outcome.deltaFromRrpCents > 0
        ? "text-red-700 dark:text-red-400"
        : mutedClass;
  // The service decides which row is cheapest; a row flagged for review is
  // a candidate, so it is never highlighted as the cheapest price.
  const highlight = outcome.isCheapest && !outcome.needsReview;
  return (
    <tr className={highlight ? "bg-zinc-50 dark:bg-zinc-900" : undefined}>
      <td className={cellClass}>
        <div className="font-medium">{outcome.retailerName}</div>
        {outcome.title ? <div className={`text-xs ${mutedClass}`}>{outcome.title}</div> : null}
        {outcome.readByModel || outcome.needsReview || outcome.filledBySearch ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {outcome.filledBySearch ? (
              <span
                className={`${badgeClass} border-violet-300 text-violet-700 dark:text-violet-400`}
              >
                via Google Shopping
              </span>
            ) : null}
            {outcome.readByModel ? (
              <span className={`${badgeClass} border-blue-300 text-blue-700 dark:text-blue-400`}>
                read by model
              </span>
            ) : null}
            {outcome.needsReview ? (
              <span className={`${badgeClass} border-amber-300 text-amber-700 dark:text-amber-400`}>
                needs review
              </span>
            ) : null}
          </div>
        ) : null}
        {outcome.gapReason ? (
          <div className={`mt-1 text-xs ${mutedClass}`}>Page not read: {outcome.gapReason}</div>
        ) : null}
        {outcome.readByModel && outcome.evidence ? (
          <div className={`mt-1 text-xs ${mutedClass}`}>
            <q>{outcome.evidence}</q>
          </div>
        ) : null}
      </td>
      <td className={`${cellClass} whitespace-nowrap`}>
        <span className={highlight ? "font-bold" : undefined}>{outcome.price}</span>
        {highlight ? (
          <span
            className={`ml-2 ${badgeClass} border-green-300 text-green-700 dark:text-green-400`}
          >
            cheapest
          </span>
        ) : null}
      </td>
      <td className={`${cellClass} whitespace-nowrap ${mutedClass}`}>
        {outcome.was ? <s>{outcome.was}</s> : <span className="text-zinc-400">not shown</span>}
      </td>
      <td
        className={`${cellClass} whitespace-nowrap ${
          outcome.shippingCents === null ? "text-zinc-400" : ""
        }`}
      >
        {outcome.delivery}
      </td>
      <td className={`${cellClass} whitespace-nowrap`}>{outcome.vsCheapest}</td>
      <td className={`${cellClass} whitespace-nowrap ${rrpClass}`}>{outcome.vsRrp}</td>
      <td
        className={`${cellClass} whitespace-nowrap ${
          outcome.needsReview ? "text-amber-700 dark:text-amber-400" : ""
        }`}
      >
        {outcome.confidenceLabel}
      </td>
      <td className={cellClass}>{outcome.stock}</td>
      <td className={cellClass}>
        <div>{outcome.identifierLabel}</div>
        {outcome.retailerSku ? (
          <div className={`text-xs ${mutedClass}`}>SKU {outcome.retailerSku}</div>
        ) : null}
      </td>
      <td className={`${cellClass} font-mono text-xs`}>{outcome.method}</td>
      <td className={cellClass}>
        <PageLink url={outcome.url} />
      </td>
    </tr>
  );
}

function FailedRow({ outcome }: { outcome: QuoteOutcomeViewFailed }) {
  return (
    <tr>
      <td className={`${cellClass} font-medium`}>{outcome.retailerName}</td>
      <td className={cellClass} colSpan={columns.length - 2}>
        <span className={`${badgeClass} border-red-300 text-red-700 dark:text-red-400`}>
          {outcome.kind}
        </span>
        <span className="ml-2">{outcome.message}</span>
      </td>
      <td className={cellClass}>
        <PageLink url={outcome.url} />
      </td>
    </tr>
  );
}

function SkippedRow({ outcome }: { outcome: QuoteOutcomeViewSkipped }) {
  return (
    <tr>
      <td className={`${cellClass} font-medium`}>{outcome.retailerName}</td>
      <td className={`${cellClass} ${mutedClass}`} colSpan={columns.length - 2}>
        skipped: {outcome.reason}
      </td>
      <td className={cellClass}>
        <PageLink url={outcome.url} />
      </td>
    </tr>
  );
}

function Summary({ view }: { view: QuoteViewOk }) {
  return (
    <p className="text-sm text-zinc-600 dark:text-zinc-400">
      Fetched {view.fetchedAtLabel}.{" "}
      {view.cheapest ? (
        <>
          Cheapest: <strong>{view.cheapest.retailerName}</strong> at{" "}
          <strong>{view.cheapest.price}</strong>.{" "}
        </>
      ) : (
        <>No retailer returned a price. </>
      )}
      {view.answered} of {view.total} retailers priced.
      {view.gapFillNote ? <> {view.gapFillNote}</> : null}
    </p>
  );
}

function Results({ view }: { view: QuoteViewOk }) {
  return (
    <div className="flex flex-col gap-3">
      <Summary view={view} />
      <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-100 text-left dark:bg-zinc-900">
            <tr>
              {columns.map((column) => (
                <th key={column} scope="col" className={`${cellClass} font-semibold`}>
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {view.outcomes.map((outcome) => {
              switch (outcome.status) {
                case "ok":
                  return <OkRow key={outcome.retailerSlug} outcome={outcome} />;
                case "failed":
                  return <FailedRow key={outcome.retailerSlug} outcome={outcome} />;
                case "skipped":
                  return <SkippedRow key={outcome.retailerSlug} outcome={outcome} />;
              }
            })}
          </tbody>
        </table>
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-zinc-600 dark:text-zinc-400">Raw quotes</summary>
        <pre className="mt-2 overflow-x-auto rounded-md bg-zinc-100 p-3 text-xs dark:bg-zinc-900">
          {JSON.stringify(view, null, 2)}
        </pre>
      </details>
    </div>
  );
}

export function QuotePanel({ slug }: { slug: string }) {
  const [view, formAction] = useActionState<QuoteView | null, FormData>(fetchQuotesAction, null);
  return (
    <div className="flex flex-col gap-4">
      <form action={formAction}>
        <input type="hidden" name="slug" value={slug} />
        <SubmitButton />
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
