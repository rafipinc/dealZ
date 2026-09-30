"use client";

// Button plus results table for a Google Shopping search (through SerpApi)
// on one tracked variant. Renders the pre-formatted SearchView; the only
// logic here is picking a colour for a sign.

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { searchQuotesAction } from "./actions";
import type { SearchQuoteView, SearchView, SearchViewResult } from "./view";

const columns = [
  "Seller",
  "Tracked",
  "Price",
  "Was",
  "Delivery",
  "Total",
  "vs cheapest",
  "vs RRP",
  "Confidence",
  "Condition",
  "Identifiers",
  "Links",
] as const;

const cellClass = "px-3 py-2 align-top";
const mutedClass = "text-zinc-500";
const badgeClass = "rounded-full border px-2 py-0.5 text-xs font-medium";
const linkClass = "text-zinc-700 underline dark:text-zinc-300";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-wait disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
    >
      {pending ? "Searching…" : "Search Google Shopping"}
    </button>
  );
}

function QuoteRow({ quote }: { quote: SearchQuoteView }) {
  const rrpClass =
    quote.deltaFromRrpCents < 0
      ? "text-green-700 dark:text-green-400"
      : quote.deltaFromRrpCents > 0
        ? "text-red-700 dark:text-red-400"
        : mutedClass;
  return (
    <tr className={quote.isCheapest ? "bg-zinc-50 dark:bg-zinc-900" : undefined}>
      <td className={cellClass}>
        <div className="font-medium">{quote.sellerName}</div>
        {quote.title ? <div className={`text-xs ${mutedClass}`}>{quote.title}</div> : null}
      </td>
      <td className={cellClass}>
        {quote.trackedRetailerSlug === null ? (
          <span className={`${badgeClass} border-zinc-300 ${mutedClass} dark:border-zinc-700`}>
            {quote.trackedLabel}
          </span>
        ) : (
          <span className={`${badgeClass} border-blue-300 text-blue-700 dark:text-blue-400`}>
            {quote.trackedLabel}
          </span>
        )}
      </td>
      <td className={`${cellClass} whitespace-nowrap`}>
        <span className={quote.isCheapest ? "font-bold" : undefined}>{quote.price}</span>
        {quote.isCheapest ? (
          <span
            className={`ml-2 ${badgeClass} border-green-300 text-green-700 dark:text-green-400`}
          >
            cheapest
          </span>
        ) : null}
        {quote.needsReview ? (
          <span
            className={`ml-2 ${badgeClass} border-amber-300 text-amber-700 dark:text-amber-400`}
          >
            needs review
          </span>
        ) : null}
      </td>
      <td className={`${cellClass} whitespace-nowrap ${mutedClass}`}>
        {quote.was ? <s>{quote.was}</s> : <span className="text-zinc-400">not shown</span>}
      </td>
      <td
        className={`${cellClass} whitespace-nowrap ${
          quote.shippingCents === null ? "text-zinc-400" : ""
        }`}
      >
        {quote.delivery}
      </td>
      <td
        className={`${cellClass} whitespace-nowrap ${
          quote.totalCents === null ? "text-zinc-400" : ""
        }`}
      >
        {quote.total}
      </td>
      <td className={`${cellClass} whitespace-nowrap`}>{quote.vsCheapest}</td>
      <td className={`${cellClass} whitespace-nowrap ${rrpClass}`}>{quote.vsRrp}</td>
      <td className={`${cellClass} whitespace-nowrap`}>{quote.confidenceLabel}</td>
      <td className={cellClass}>{quote.conditionLabel}</td>
      <td className={cellClass}>
        <div>{quote.identifierLabel}</div>
        {quote.gtin ? <div className={`text-xs ${mutedClass}`}>GTIN {quote.gtin}</div> : null}
        {quote.mpn ? <div className={`text-xs ${mutedClass}`}>MPN {quote.mpn}</div> : null}
        {quote.retailerSku ? (
          <div className={`text-xs ${mutedClass}`}>SKU {quote.retailerSku}</div>
        ) : null}
      </td>
      <td className={`${cellClass} whitespace-nowrap`}>
        <a href={quote.url} target="_blank" rel="noreferrer" className={linkClass}>
          retailer
        </a>
        {quote.productUrl ? (
          <>
            {" · "}
            <a href={quote.productUrl} target="_blank" rel="noreferrer" className={linkClass}>
              on Google
            </a>
          </>
        ) : null}
      </td>
    </tr>
  );
}

function Summary({ view }: { view: SearchView }) {
  if (view.outcome.status === "failed") {
    return (
      <p className="text-sm">
        <span className={`${badgeClass} border-red-300 text-red-700 dark:text-red-400`}>
          {view.outcome.kind}
        </span>
        <span className="ml-2">{view.outcome.message}</span>
      </p>
    );
  }
  const { outcome } = view;
  return (
    <p className="text-sm text-zinc-600 dark:text-zinc-400">
      Searched <code className="font-mono">{view.query}</code> at {view.fetchedAtLabel}.{" "}
      {outcome.sellers} {outcome.sellers === 1 ? "seller" : "sellers"}.{" "}
      {outcome.cheapest ? (
        <>
          Cheapest: <strong>{outcome.cheapest.sellerName}</strong> at{" "}
          <strong>{outcome.cheapest.price}</strong>.
        </>
      ) : (
        <>No seller returned a price.</>
      )}
    </p>
  );
}

function Results({ view }: { view: SearchView }) {
  return (
    <div className="flex flex-col gap-3">
      <Summary view={view} />
      {view.outcome.status === "ok" && view.outcome.quotes.length > 0 ? (
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
              {view.outcome.quotes.map((quote) => (
                <QuoteRow key={quote.key} quote={quote} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <details className="text-sm">
        <summary className="cursor-pointer text-zinc-600 dark:text-zinc-400">Raw results</summary>
        <pre className="mt-2 overflow-x-auto rounded-md bg-zinc-100 p-3 text-xs dark:bg-zinc-900">
          {JSON.stringify(view, null, 2)}
        </pre>
      </details>
    </div>
  );
}

export function SearchPanel({ slug, query }: { slug: string; query: string | null }) {
  const [view, formAction] = useActionState<SearchViewResult | null, FormData>(
    searchQuotesAction,
    null,
  );
  return (
    <div className="flex flex-col gap-4">
      <form action={formAction} className="flex flex-wrap items-center gap-3">
        <input type="hidden" name="slug" value={slug} />
        <SubmitButton />
        <span className="text-sm text-zinc-600 dark:text-zinc-400">
          Query:{" "}
          {query === null ? (
            <span className={mutedClass}>none configured</span>
          ) : (
            <code className="font-mono">{query}</code>
          )}
        </span>
      </form>
      {view === null ? null : view.ok ? (
        <Results view={view} />
      ) : view.notice ? (
        <p role="status" className="text-sm text-zinc-600 dark:text-zinc-400">
          {view.error}
        </p>
      ) : (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {view.error}
        </p>
      )}
    </div>
  );
}
