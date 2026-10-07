// Lab: a development tool per ADR-0012. Lists the hand-tracked variants and
// lets a developer fetch live prices, search Google Shopping and read the
// Wayback Machine's copies for one, then read any page with the model
// (ADR-0013). No price is saved. The product search at the top reads the
// local catalogue index as you type; Enter asks the storefronts and Google
// Shopping when the index holds too little, under a daily cap on the paid
// calls, and remembers what they return (ADR-0017). The index holds
// candidates, never catalogue rows.

import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isLocalDevelopment } from "@/lib/local-only";
import { formatAud } from "@/lib/money";
import { MAX_QUERY_LENGTH } from "@/services/discovery";
import { trackedVariants, type TrackedVariant } from "@/services/tracked-products";
import { CatalogSearchPanel } from "./catalog-search-panel";
import { ExtractPanel } from "./extract-panel";
import { HistoryPanel } from "./history-panel";
import { loadIndexStatus, loadSerpApiBudget } from "./index-loaders";
import { QuotePanel } from "./quote-panel";
import { SearchPanel } from "./search-panel";

export const metadata: Metadata = { title: "Lab: live price fetch" };

// The index status and SerpApi budget lines are live state: never prerendered, never cached.
export const dynamic = "force-dynamic";

const cellClass = "px-3 py-2 align-top";

function Panel({ title, lead, children }: { title: string; lead: string; children: ReactNode }) {
  return (
    <section
      aria-label={title}
      className="flex flex-col gap-3 border-t border-zinc-200 pt-4 dark:border-zinc-800"
    >
      <h3 className="text-lg font-semibold">{title}</h3>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">{lead}</p>
      {children}
    </section>
  );
}

function VariantCard({ variant }: { variant: TrackedVariant }) {
  return (
    <article className="flex flex-col gap-4 rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
      <header className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold tracking-tight">{variant.displayName}</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-sm text-zinc-600 dark:text-zinc-400">
          <dt>Model code</dt>
          <dd className="font-mono">{variant.mpn}</dd>
          <dt>GTIN</dt>
          <dd className="font-mono">{variant.gtin}</dd>
          <dt>RRP</dt>
          <dd>{formatAud(variant.rrpCents)}</dd>
        </dl>
      </header>
      <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-100 text-left dark:bg-zinc-900">
            <tr>
              <th scope="col" className={`${cellClass} font-semibold`}>
                Retailer
              </th>
              <th scope="col" className={`${cellClass} font-semibold`}>
                Source
              </th>
              <th scope="col" className={`${cellClass} font-semibold`}>
                Note
              </th>
              <th scope="col" className={`${cellClass} font-semibold`}>
                Link
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {variant.pages.map((page) => (
              <tr key={page.retailerSlug}>
                <td className={`${cellClass} font-medium`}>{page.retailerName}</td>
                <td className={`${cellClass} font-mono text-xs`}>
                  {page.source ?? <span className="font-sans text-zinc-500">not fetched</span>}
                </td>
                <td className={`${cellClass} text-zinc-600 dark:text-zinc-400`}>
                  {page.note ?? ""}
                </td>
                <td className={cellClass}>
                  <a
                    href={page.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-zinc-700 underline dark:text-zinc-300"
                  >
                    open
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Panel
        title="Live prices"
        lead="Fetched now, cheapest route first: the retailer page, then the model for a page without structured data, then one Google Shopping search for any retailer still without a price. Nothing is saved."
      >
        <QuotePanel slug={variant.slug} />
      </Panel>
      <Panel
        title="Google Shopping"
        lead="Every seller Google Shopping lists for this model, through SerpApi. Nothing is saved."
      >
        <SearchPanel slug={variant.slug} query={variant.searches[0]?.query ?? null} />
      </Panel>
      <Panel
        title="Price history"
        lead="Prices read from the Wayback Machine's archived copies of each retailer page, from the on-sale date to today. Nothing is saved."
      >
        <HistoryPanel slug={variant.slug} />
      </Panel>
    </article>
  );
}

export default async function LabPage() {
  // A development tool only. Its actions fire live requests at retailers and
  // write the local usage ledger, so only a development server serves it
  // (ADR-0012 item 7): never a public deployment, a preview build or a test run.
  if (!isLocalDevelopment(process.env.NODE_ENV)) notFound();
  // A database that is down is a line under the search box, never a failed page.
  const [indexStatus, serpApiBudget] = await Promise.all([loadIndexStatus(), loadSerpApiBudget()]);
  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-3xl font-semibold tracking-tight">Lab: live price fetch</h1>
        <p className="text-zinc-600 dark:text-zinc-400">
          A development tool per ADR-0012. Prices are fetched live when you press the button and no
          price is saved. Each outbound call is logged to the local usage ledger.
        </p>
        <p className="text-sm">
          <Link href="/lab/status" className="text-zinc-700 underline dark:text-zinc-300">
            Services and usage
          </Link>
        </p>
      </header>
      <section
        aria-label="Find a product"
        className="flex flex-col gap-3 rounded-lg border border-zinc-200 p-5 dark:border-zinc-800"
      >
        <h2 className="text-xl font-semibold tracking-tight">Find a product</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Type to search the local index by title, model code or GTIN. Enter answers from the index
          when it holds enough; otherwise it asks Google Shopping (one SerpApi search, under a daily
          cap) and the storefronts that answer scripted requests, and remembers what they return. No
          price is saved; each request is logged to the usage ledger.
        </p>
        <CatalogSearchPanel
          maxQueryLength={MAX_QUERY_LENGTH}
          indexStatus={indexStatus}
          serpApiBudget={serpApiBudget}
        />
      </section>
      {trackedVariants.map((variant) => (
        <VariantCard key={variant.slug} variant={variant} />
      ))}
      <section
        aria-label="Read any page with the model"
        className="flex flex-col gap-3 rounded-lg border border-zinc-200 p-5 dark:border-zinc-800"
      >
        <h2 className="text-xl font-semibold tracking-tight">Read any page with the model</h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          For a store that is not tracked, or a page without structured data. The model returns
          evidence; rules assign the confidence (ADR-0013). Nothing is saved.
        </p>
        <ExtractPanel />
      </section>
    </main>
  );
}
