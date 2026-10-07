"use client";

// Search box plus results for finding a product (ADR-0016 step c, ADR-0017
// item 6). As you type, a listbox under the box shows what the local
// catalogue index holds, eight products at most, debounced 150 ms with the
// latest answer winning, and never a paid call. Enter with no row
// highlighted runs the discover search: the index, then Google Shopping and
// the storefronts when it holds too little, grouped into product cards with
// every seller's offer; Enter on a row opens its product page. The flat
// table of what the sources returned stays under a details, and each
// storefront row there can ask for its identifiers, which the InspectView
// then fills in. No business rule lives here: relevance, grouping, routing
// and the daily cap are the service's.

import {
  useActionState,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import { useFormStatus } from "react-dom";
import {
  discoverProductsAction,
  inspectCandidateAction,
  refreshIndexAction,
  suggestProductsAction,
} from "./actions";
import type {
  DiscoverOfferView,
  DiscoverProductView,
  DiscoverView,
  DiscoverViewResult,
  DiscoveryRowView,
  IndexStatusView,
  InspectOutcomeViewOk,
  InspectViewResult,
  RefreshViewResult,
  SerpApiBudgetView,
  SuggestRowView,
  SuggestViewResult,
} from "./view";

/** The pause after the last keystroke before the index is asked (ADR-0017 item 6). */
const DEBOUNCE_MS = 150;

const columns = [
  "Store",
  "Product",
  "Price",
  "Was",
  "Stock",
  "Model code",
  "GTIN",
  "Held",
  "Links",
] as const;

const cellClass = "px-3 py-2 align-top";
const mutedClass = "text-zinc-500";
const badgeClass = "rounded-full border px-2 py-0.5 text-xs font-medium";
const linkClass = "text-zinc-700 underline dark:text-zinc-300";
const buttonClass =
  "rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-wait disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300";
const smallButtonClass =
  "rounded-md border border-zinc-300 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-wait disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={buttonClass}>
      {pending ? "Searching…" : "Search"}
    </button>
  );
}

function RefreshButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={smallButtonClass}>
      {pending ? "Refreshing…" : "Refresh index"}
    </button>
  );
}

function ReadButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={smallButtonClass}>
      {pending ? "Reading…" : "Read identifiers"}
    </button>
  );
}

function HeldBadge({
  trackedVariantSlug,
  heldLabel,
  matchedLabel,
}: Pick<DiscoveryRowView, "trackedVariantSlug" | "heldLabel" | "matchedLabel">) {
  return (
    <>
      {trackedVariantSlug === null ? (
        <span className={`${badgeClass} border-zinc-300 ${mutedClass} dark:border-zinc-700`}>
          {heldLabel}
        </span>
      ) : (
        <span className={`${badgeClass} border-blue-300 text-blue-700 dark:text-blue-400`}>
          {heldLabel}
        </span>
      )}
      {matchedLabel ? <div className={`mt-1 text-xs ${mutedClass}`}>{matchedLabel}</div> : null}
    </>
  );
}

/** The identifiers the product JSON returned for this row, once read. */
function inspectedOf(result: InspectViewResult | null): InspectOutcomeViewOk | null {
  if (result === null || !result.ok || result.outcome.status !== "ok") return null;
  return result.outcome;
}

function CandidateRow({ row }: { row: DiscoveryRowView }) {
  const [inspect, inspectAction] = useActionState<InspectViewResult | null, FormData>(
    inspectCandidateAction,
    null,
  );
  const inspected = inspectedOf(inspect);
  const held = inspected ?? row;
  return (
    <tr className={row.trackedVariantSlug !== null ? "bg-zinc-50 dark:bg-zinc-900" : undefined}>
      <td className={`${cellClass} font-medium`}>
        {row.retailerName}
        {row.via === "google_shopping" ? (
          <div className={`text-xs font-normal ${mutedClass}`}>via Google Shopping</div>
        ) : null}
      </td>
      <td className={cellClass}>
        <div className="flex items-start gap-3">
          {row.imageUrl ? (
            // A thumbnail from the store's CDN, in a development-only tool;
            // next/image would need every store's host in remotePatterns.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={row.imageUrl}
              alt={row.title}
              width={48}
              height={48}
              loading="lazy"
              className="h-12 w-12 shrink-0 rounded border border-zinc-200 object-contain dark:border-zinc-800"
            />
          ) : (
            <div
              aria-hidden="true"
              className="h-12 w-12 shrink-0 rounded border border-dashed border-zinc-200 dark:border-zinc-800"
            />
          )}
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{row.title}</span>
              {row.tier === "accessory" ? (
                <span
                  className={`${badgeClass} border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-400`}
                >
                  {row.tierLabel}
                </span>
              ) : null}
            </div>
            {row.subtitle ? <div className={`text-xs ${mutedClass}`}>{row.subtitle}</div> : null}
            {row.hidden ? (
              <div className={`text-xs ${mutedClass}`}>
                {row.tierLabel} · {row.relevanceReason}
              </div>
            ) : null}
          </div>
        </div>
      </td>
      <td
        className={`${cellClass} whitespace-nowrap ${row.priceCents === null ? "text-zinc-400" : ""}`}
      >
        {inspected ? inspected.price : row.price}
      </td>
      <td className={`${cellClass} whitespace-nowrap ${mutedClass}`}>
        {row.was ? <s>{row.was}</s> : <span className="text-zinc-400">not shown</span>}
      </td>
      <td className={`${cellClass} whitespace-nowrap`}>{row.stock}</td>
      <td className={`${cellClass} font-mono text-xs`}>
        {inspected?.modelCodeRead ? (
          inspected.modelCode
        ) : row.mpnFromTitle ? (
          row.modelCode
        ) : (
          <span className="font-sans text-zinc-400">{row.modelCode}</span>
        )}
      </td>
      <td className={`${cellClass} font-mono text-xs`}>
        {inspected ? (
          <>
            <div className={inspected.gtinRead ? undefined : "font-sans text-zinc-400"}>
              {inspected.gtin}
            </div>
            <div className={mutedClass}>SKU {inspected.sku}</div>
          </>
        ) : (
          <span className="font-sans text-zinc-400">{row.gtin}</span>
        )}
      </td>
      <td className={cellClass}>
        <HeldBadge
          trackedVariantSlug={held.trackedVariantSlug}
          heldLabel={held.heldLabel}
          matchedLabel={held.matchedLabel}
        />
      </td>
      <td className={`${cellClass} whitespace-nowrap`}>
        <div className="flex flex-col items-start gap-2">
          <a href={row.url} target="_blank" rel="noreferrer" className={linkClass}>
            open
          </a>
          {row.inspectable ? (
            <form action={inspectAction}>
              <input type="hidden" name="retailerSlug" value={row.retailerSlug} />
              <input type="hidden" name="url" value={row.url} />
              <ReadButton />
            </form>
          ) : null}
          {inspect === null || inspected ? null : inspect.ok ? (
            inspect.outcome.status === "failed" ? (
              <span role="alert" className="text-xs">
                <span className={`${badgeClass} border-red-300 text-red-700 dark:text-red-400`}>
                  {inspect.outcome.kind}
                </span>
              </span>
            ) : null
          ) : (
            <span role="alert" className="text-xs text-red-700 dark:text-red-400">
              {inspect.error}
            </span>
          )}
        </div>
      </td>
    </tr>
  );
}

function Summary({ view }: { view: DiscoverView }) {
  return (
    <p className="text-sm text-zinc-600 dark:text-zinc-400">
      Searched <code className="font-mono">{view.query}</code> as {view.queryKindLabel}
      {view.gtin ? (
        <>
          {" "}
          (<code className="font-mono">{view.gtin}</code>)
        </>
      ) : null}{" "}
      at {view.fetchedAtLabel}. {view.countLine} {view.budgetLine}
    </p>
  );
}

function ResultsTable({ rows }: { rows: DiscoveryRowView[] }) {
  return (
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
          {rows.map((row) => (
            <CandidateRow key={row.key} row={row} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OfferRow({ offer }: { offer: DiscoverOfferView }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-1.5">
      <span className="font-medium">{offer.retailerName}</span>
      <span
        className={`whitespace-nowrap ${offer.priceCents === null ? "text-zinc-400" : ""} ${
          offer.isCheapest ? "font-semibold" : ""
        }`}
      >
        {offer.price}
      </span>
      {offer.was ? <s className={`whitespace-nowrap ${mutedClass}`}>{offer.was}</s> : null}
      <span className={mutedClass}>{offer.stock}</span>
      <a href={offer.url} target="_blank" rel="noreferrer" className={linkClass}>
        open
      </a>
      <span className={`text-xs ${mutedClass}`}>
        {offer.sourceLabel} · seen {offer.lastSeenLabel}
      </span>
    </li>
  );
}

function ProductCard({ product }: { product: DiscoverProductView }) {
  return (
    <article className="flex flex-col gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="flex items-start gap-3">
        {product.imageUrl ? (
          // A thumbnail from the store's CDN or the aggregator, in a development-only
          // tool; next/image would need every host in remotePatterns.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={product.imageUrl}
            alt={product.title}
            width={96}
            height={96}
            loading="lazy"
            className="h-24 w-24 shrink-0 rounded border border-zinc-200 object-contain dark:border-zinc-800"
          />
        ) : (
          <div
            aria-hidden="true"
            className="h-24 w-24 shrink-0 rounded border border-dashed border-zinc-200 dark:border-zinc-800"
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h4 className="font-medium">{product.title}</h4>
          {product.subtitle ? (
            <div className={`font-mono text-xs ${mutedClass}`}>{product.subtitle}</div>
          ) : null}
          <div className="text-sm">{product.fromLine}</div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className={mutedClass}>{product.sellersLabel}</span>
            {product.trackedVariantSlug !== null ? (
              <span className={`${badgeClass} border-blue-300 text-blue-700 dark:text-blue-400`}>
                {product.heldLabel}
              </span>
            ) : null}
            {product.tier === "accessory" ? (
              <span
                className={`${badgeClass} border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-400`}
              >
                {product.tierLabel}
              </span>
            ) : null}
            {product.hidden ? (
              <span className={mutedClass}>
                {product.tierLabel} · {product.relevanceReason}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-zinc-600 dark:text-zinc-400">
          Offers ({product.sellerCount})
        </summary>
        <ul className="mt-1 divide-y divide-zinc-200 dark:divide-zinc-800">
          {product.offers.map((offer) => (
            <OfferRow key={offer.key} offer={offer} />
          ))}
        </ul>
      </details>
    </article>
  );
}

function ProductGrid({ products }: { products: DiscoverProductView[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {products.map((product) => (
        <ProductCard key={product.key} product={product} />
      ))}
    </div>
  );
}

function Results({ view }: { view: DiscoverView }) {
  return (
    <div className="flex flex-col gap-3">
      <Summary view={view} />
      {view.googleLine ? (
        <p role="status" className="text-sm text-amber-700 dark:text-amber-400">
          {view.googleLine}
        </p>
      ) : null}
      {view.products.length > 0 ? (
        <ProductGrid products={view.products} />
      ) : (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">No product matched every word.</p>
      )}
      {view.hiddenProducts.length > 0 ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-zinc-600 dark:text-zinc-400">
            Partial matches ({view.hiddenProducts.length})
          </summary>
          <div className="mt-2">
            <ProductGrid products={view.hiddenProducts} />
          </div>
        </details>
      ) : null}
      {view.rows.length > 0 ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-zinc-600 dark:text-zinc-400">
            All rows as the sources returned them ({view.rows.length})
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            {view.usageLine ? <p className={`text-xs ${mutedClass}`}>{view.usageLine}.</p> : null}
            <ResultsTable rows={view.rows} />
          </div>
        </details>
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

/** One row of the listbox: a product in the index, or the offer to search Google Shopping and the stores. */
type Suggestion = { kind: "product"; row: SuggestRowView } | { kind: "live"; query: string };

/** The view decides whether the live row is offered; the row carries the query as typed. */
function suggestionsOf(result: SuggestViewResult | null, query: string): Suggestion[] {
  if (result === null || !result.ok) return [];
  const rows: Suggestion[] = result.rows.map((row) => ({ kind: "product", row }));
  if (result.offerLiveSearch) rows.push({ kind: "live", query });
  return rows;
}

function SuggestRow({ row }: { row: SuggestRowView }) {
  return (
    <>
      {row.imageUrl ? (
        // A thumbnail from the store's CDN, in a development-only tool;
        // next/image would need every store's host in remotePatterns.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={row.imageUrl}
          alt=""
          width={40}
          height={40}
          loading="lazy"
          className="h-10 w-10 shrink-0 rounded border border-zinc-200 object-contain dark:border-zinc-800"
        />
      ) : (
        <div
          aria-hidden="true"
          className="h-10 w-10 shrink-0 rounded border border-dashed border-zinc-200 dark:border-zinc-800"
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium" title={row.title}>
          {row.title}
        </div>
        {row.subtitle ? <div className={`text-xs ${mutedClass}`}>{row.subtitle}</div> : null}
        {row.trackedVariantSlug !== null ? (
          <div className="mt-0.5">
            <span
              className={`${badgeClass} border-blue-300 text-blue-700 dark:text-blue-400`}
              title={row.heldLabel}
            >
              held
            </span>
          </div>
        ) : null}
      </div>
      <div className="shrink-0 text-right">
        <div className="text-sm whitespace-nowrap">{row.priceLine}</div>
        <div className={`text-xs ${mutedClass}`}>{row.storesLabel}</div>
      </div>
    </>
  );
}

interface SearchBoxProps {
  maxQueryLength: number;
  formAction: (formData: FormData) => void;
}

/**
 * The combobox: a text input whose Enter submits the enclosing form (the
 * discover search), with a listbox of index products under it. Arrow keys
 * move the highlight; Enter on a highlighted product opens its page in a
 * new tab, on the live row submits the form; Escape closes the list.
 */
function SearchBox({ maxQueryLength, formAction }: SearchBoxProps) {
  const listboxId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const anchorRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  // The number of the latest request; an answer for an earlier one is dropped.
  const latest = useRef(0);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SuggestViewResult | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  const trimmed = query.trim();
  const suggestions = suggestionsOf(result, trimmed);
  const optionId = (index: number) => `${listboxId}-option-${index}`;

  useEffect(() => {
    if (trimmed === "") return;
    const request = (latest.current += 1);
    const timer = setTimeout(() => {
      suggestProductsAction(trimmed).then(
        (answer) => {
          if (latest.current !== request) return;
          setResult(answer);
          setActive(-1);
          setOpen(true);
        },
        (reason: unknown) => {
          if (latest.current !== request) return;
          const message = reason instanceof Error ? reason.message : String(reason);
          setResult({ ok: false, error: `Index unavailable: ${message}` });
          setOpen(true);
        },
      );
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [trimmed]);

  function onChange(event: ChangeEvent<HTMLInputElement>) {
    const next = event.target.value;
    setQuery(next);
    setActive(-1);
    if (next.trim() === "") {
      // Nothing to ask; an answer still in flight is for a query that no longer exists.
      latest.current += 1;
      setResult(null);
      setOpen(false);
    }
  }

  function close() {
    setOpen(false);
    setActive(-1);
  }

  function choose(index: number) {
    const suggestion = suggestions[index];
    if (suggestion === undefined) return;
    if (suggestion.kind === "live") {
      close();
      formRef.current?.requestSubmit();
      return;
    }
    anchorRefs.current[index]?.click();
    close();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case "ArrowDown":
        if (suggestions.length === 0) return;
        event.preventDefault();
        setOpen(true);
        setActive((current) => Math.min(current + 1, suggestions.length - 1));
        return;
      case "ArrowUp":
        if (!open) return;
        event.preventDefault();
        setActive((current) => Math.max(current - 1, -1));
        return;
      case "Enter":
        // With a row highlighted, Enter is the row's; otherwise the form submits the discover search.
        if (open && active >= 0) {
          event.preventDefault();
          choose(active);
        } else {
          close();
        }
        return;
      case "Escape":
        if (open) event.preventDefault();
        close();
        return;
      default:
    }
  }

  const expanded = open && trimmed !== "" && result !== null;

  return (
    <form
      ref={formRef}
      action={formAction}
      onSubmit={close}
      className="relative flex w-full max-w-2xl flex-wrap items-center gap-3"
    >
      <div className="min-w-0 flex-1">
        <input
          type="text"
          name="q"
          role="combobox"
          aria-label="Product search"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={listboxId}
          aria-activedescendant={expanded && active >= 0 ? optionId(active) : undefined}
          autoComplete="off"
          placeholder="Title, model code or GTIN"
          required
          maxLength={maxQueryLength}
          value={query}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onFocus={() => {
            if (result !== null) setOpen(true);
          }}
          onBlur={close}
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
        />
        <ul
          id={listboxId}
          role="listbox"
          aria-label="Products in the index"
          hidden={!expanded}
          // Keeps the focus, and so the listbox, on the input while a row is clicked.
          onMouseDown={(event) => event.preventDefault()}
          className="absolute top-full right-0 left-0 z-10 mt-1 max-h-96 overflow-y-auto rounded-md border border-zinc-200 bg-white text-sm shadow-lg dark:border-zinc-800 dark:bg-zinc-950"
        >
          {result === null ? null : !result.ok ? (
            <li role="presentation" className="px-3 py-2 text-red-700 dark:text-red-400">
              {result.error}
            </li>
          ) : suggestions.length === 0 ? (
            <li role="presentation" className={`px-3 py-2 ${mutedClass}`}>
              No products in the index match. Press Enter to search Google Shopping and the stores.
            </li>
          ) : (
            suggestions.map((suggestion, index) => {
              const highlighted = index === active;
              const rowClass = `flex cursor-pointer items-center gap-3 px-3 py-2 ${
                highlighted ? "bg-zinc-100 dark:bg-zinc-900" : ""
              }`;
              return suggestion.kind === "live" ? (
                <li
                  key="live"
                  id={optionId(index)}
                  role="option"
                  aria-selected={highlighted}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(index)}
                  className={`${rowClass} border-t border-zinc-200 text-zinc-700 dark:border-zinc-800 dark:text-zinc-300`}
                >
                  Search Google Shopping and the stores for &lsquo;{suggestion.query}&rsquo;
                </li>
              ) : (
                <li
                  key={suggestion.row.key}
                  id={optionId(index)}
                  role="option"
                  aria-selected={highlighted}
                  onMouseEnter={() => setActive(index)}
                  className={rowClass}
                >
                  <a
                    ref={(element) => {
                      anchorRefs.current[index] = element;
                    }}
                    href={suggestion.row.url}
                    target="_blank"
                    rel="noreferrer"
                    tabIndex={-1}
                    onClick={close}
                    className="flex min-w-0 flex-1 items-center gap-3"
                  >
                    <SuggestRow row={suggestion.row} />
                  </a>
                </li>
              );
            })
          )}
        </ul>
      </div>
      <SubmitButton />
    </form>
  );
}

function IndexStatusLine({
  status,
  budget,
}: {
  status: IndexStatusView;
  budget: SerpApiBudgetView;
}) {
  // The action takes no payload: the form is the button, nothing else.
  const [refresh, refreshAction] = useActionState<RefreshViewResult | null>(
    refreshIndexAction,
    null,
  );
  return (
    <div className="flex flex-col gap-2 text-xs">
      <div className="flex flex-wrap items-center gap-3">
        <p role="status" className={status.ok ? mutedClass : "text-red-700 dark:text-red-400"}>
          {status.line}
        </p>
        <form action={refreshAction}>
          <RefreshButton />
        </form>
      </div>
      <p
        role="status"
        className={
          !budget.ok
            ? "text-red-700 dark:text-red-400"
            : budget.allowed
              ? mutedClass
              : "text-amber-700 dark:text-amber-400"
        }
      >
        {budget.line}
      </p>
      {refresh === null ? null : refresh.ok ? (
        <p role="status" className={mutedClass}>
          {refresh.lines.join("; ")}. {refresh.usageLine}, at {refresh.refreshedAtLabel}.
        </p>
      ) : (
        <p role="alert" className="text-red-700 dark:text-red-400">
          {refresh.error}
        </p>
      )}
    </div>
  );
}

/**
 * The query length limit, the index status and the SerpApi budget come from
 * the page as props: the page is a server component and reads the services,
 * while this client component must not import a service module, which
 * reaches the database driver and cannot be bundled for the browser.
 */
export function CatalogueSearchPanel({
  maxQueryLength,
  indexStatus,
  serpApiBudget,
}: {
  maxQueryLength: number;
  indexStatus: IndexStatusView;
  serpApiBudget: SerpApiBudgetView;
}) {
  const [view, formAction] = useActionState<DiscoverViewResult | null, FormData>(
    discoverProductsAction,
    null,
  );
  return (
    <div className="flex flex-col gap-4">
      <SearchBox maxQueryLength={maxQueryLength} formAction={formAction} />
      <IndexStatusLine status={indexStatus} budget={serpApiBudget} />
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
