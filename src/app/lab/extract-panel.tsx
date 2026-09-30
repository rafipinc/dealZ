"use client";

// URL input plus result card for reading one page of any store with the
// model (ADR-0013). Renders the pre-formatted ExtractView; the only logic
// here is choosing a badge colour for a flag the service already set.

import { useActionState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { extractQuoteAction } from "./actions";
import type { ExtractQuoteView, ExtractView, ExtractViewResult } from "./view";

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
      {pending ? "Reading…" : "Extract price"}
    </button>
  );
}

function PendingNote() {
  const { pending } = useFormStatus();
  if (!pending) return null;
  return (
    <span role="status" className="text-sm text-zinc-600 dark:text-zinc-400">
      Fetching the page and asking the model. This takes a few seconds.
    </span>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className={mutedClass}>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function QuoteCard({ quote }: { quote: ExtractQuoteView }) {
  return (
    <article
      aria-label="Extracted quote"
      className="flex flex-col gap-3 rounded-md border border-zinc-200 p-4 dark:border-zinc-800"
    >
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs">{quote.retailerSlug}</span>
          {quote.needsReview ? (
            <span className={`${badgeClass} border-amber-300 text-amber-700 dark:text-amber-400`}>
              needs review
            </span>
          ) : null}
          <a href={quote.url} target="_blank" rel="noreferrer" className={`text-sm ${linkClass}`}>
            open
          </a>
        </div>
        <h4 className="font-medium">
          {quote.title ?? <span className={mutedClass}>no title</span>}
        </h4>
      </header>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <Field label="Price">
          <span className={quote.needsReview ? undefined : "font-bold"}>{quote.price}</span>
        </Field>
        <Field label="Was">
          {quote.was ? (
            <s className={mutedClass}>{quote.was}</s>
          ) : (
            <span className="text-zinc-400">not shown</span>
          )}
        </Field>
        <Field label="Delivery">
          <span className={quote.shippingCents === null ? "text-zinc-400" : undefined}>
            {quote.delivery}
          </span>
        </Field>
        <Field label="Condition">{quote.conditionLabel}</Field>
        <Field label="Availability">{quote.stock}</Field>
        <Field label="Identifiers">
          <div>{quote.identifierLabel}</div>
          {quote.gtin ? <div className={`text-xs ${mutedClass}`}>GTIN {quote.gtin}</div> : null}
          {quote.mpn ? <div className={`text-xs ${mutedClass}`}>MPN {quote.mpn}</div> : null}
          {quote.retailerSku ? (
            <div className={`text-xs ${mutedClass}`}>SKU {quote.retailerSku}</div>
          ) : null}
        </Field>
        <Field label="Confidence">
          <div className={quote.needsReview ? "text-amber-700 dark:text-amber-400" : undefined}>
            {quote.confidenceLabel}
          </div>
          {quote.reasons.length > 0 ? (
            <ul className={`mt-1 list-disc pl-5 text-xs ${mutedClass}`}>
              {quote.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
        </Field>
        <Field label="Evidence">
          {quote.evidence ? (
            <blockquote
              className={`border-l-2 border-zinc-300 pl-3 ${mutedClass} dark:border-zinc-700`}
            >
              {quote.evidence}
            </blockquote>
          ) : (
            <span className="text-zinc-400">none returned</span>
          )}
        </Field>
        <Field label="Tracked">{quote.matchLabel}</Field>
      </dl>
    </article>
  );
}

function Summary({ view }: { view: ExtractView }) {
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
  return (
    <p className="text-sm text-zinc-600 dark:text-zinc-400">
      Read <code className="font-mono">{view.url}</code> at {view.fetchedAtLabel} with{" "}
      <code className="font-mono">{view.method}</code>.
    </p>
  );
}

function Results({ view }: { view: ExtractView }) {
  return (
    <div className="flex flex-col gap-3">
      <Summary view={view} />
      {view.outcome.status === "ok" ? <QuoteCard quote={view.outcome.quote} /> : null}
      <details className="text-sm">
        <summary className="cursor-pointer text-zinc-600 dark:text-zinc-400">
          Raw extraction
        </summary>
        <pre className="mt-2 overflow-x-auto rounded-md bg-zinc-100 p-3 text-xs dark:bg-zinc-900">
          {JSON.stringify(view, null, 2)}
        </pre>
      </details>
    </div>
  );
}

export function ExtractPanel() {
  const [view, formAction] = useActionState<ExtractViewResult | null, FormData>(
    extractQuoteAction,
    null,
  );
  return (
    <div className="flex flex-col gap-4">
      <form action={formAction} className="flex flex-wrap items-center gap-3">
        <label className="flex flex-1 flex-col gap-1 text-sm">
          <span className="sr-only">Product page URL</span>
          <input
            type="url"
            name="url"
            required
            placeholder="https://store.example.com.au/product/..."
            className="min-w-64 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          />
        </label>
        <SubmitButton />
        <PendingNote />
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
