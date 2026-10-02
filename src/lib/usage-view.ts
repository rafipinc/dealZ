// What the lab's status page shows of the usage ledger: tables, the daily
// chart and the recent calls, every cell already a string. Pure shaping over
// the usage service's dashboard; the page renders these and decides nothing.
//
// The input types are structural, so this file imports nothing from
// src/services; the usage service's dashboard satisfies them as it is.

import { isFreeProvider } from "./api-prices";
import { buildDailyChart, type DailyChart } from "./usage-chart";
import {
  formatAge,
  formatCostCell,
  formatCount,
  formatDateTimeIn,
  formatDurationMs,
  formatShortDate,
  formatUsdMicros,
} from "./usage-format";

const DASH = "–";

const providerNames: Record<string, string> = {
  serpapi: "SerpApi",
  gemini: "Gemini",
  wayback: "Wayback Machine",
  retailer: "Retailer pages",
};

function providerName(provider: string): string {
  return providerNames[provider] ?? provider;
}

export interface UsageTotalsInput {
  calls: number;
  ok: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  unpricedCalls: number;
}

export interface UsageSummaryInput {
  providers: readonly (UsageTotalsInput & { provider: string })[];
  totals: UsageTotalsInput;
}

export interface UsageCallInput {
  id: string;
  provider: string;
  operation: string;
  calledAt: Date;
  outcome: "ok" | "failed";
  errorKind: string | null;
  httpStatus: number | null;
  durationMs: number;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costMicros: number;
  priced: boolean;
  retailerSlug: string | null;
}

export interface LastOkInput {
  provider: string;
  retailerSlug: string | null;
  lastOkAt: Date;
}

/** The usage service's dashboard, as far as the page shows it. */
export interface UsageDashboardInput {
  now: Date;
  timeZone: string;
  today: UsageSummaryInput;
  monthToDate: UsageSummaryInput;
  daily: {
    days: readonly string[];
    rows: readonly {
      day: string;
      provider: string;
      calls: number;
      costMicros: number;
      unpricedCalls: number;
    }[];
  };
  recent: readonly UsageCallInput[];
  lastOk: readonly LastOkInput[];
}

export interface UsageRowView {
  key: string;
  label: string;
  calls: string;
  ok: string;
  failed: string;
  /** True when at least one call failed, so the cell can be styled. */
  hasFailures: boolean;
  tokensIn: string;
  tokensOut: string;
  /** "$0.0014", "free", "unpriced", "≥ $0.0014" for a lower bound, or a dash. */
  cost: string;
}

export interface UsageTableView {
  /** One row per provider called in the period. Empty when none was. */
  rows: UsageRowView[];
  /** Null when there are no rows. */
  totals: UsageRowView | null;
  /** What the unpriced calls in this table mean for its costs, or null when there are none. */
  unpricedNote: string | null;
}

function calls(count: number): string {
  return `${formatCount(count)} ${count === 1 ? "call" : "calls"}`;
}

/** The sentence under a table or chart whose figures include calls with no price. */
function unpricedNote(unpricedCalls: number): string | null {
  if (unpricedCalls <= 0) return null;
  return `${calls(unpricedCalls)} used a model with no price in the price table. They are counted but add nothing to the cost, so a figure marked ≥ is a lower bound.`;
}

/** Zero tokens for a provider that has none is a dash, not a count. */
function tokens(count: number): string {
  return count === 0 ? DASH : formatCount(count);
}

function usageRow(
  key: string,
  label: string,
  usage: UsageTotalsInput,
  free: boolean,
): UsageRowView {
  return {
    key,
    label,
    calls: formatCount(usage.calls),
    ok: formatCount(usage.ok),
    failed: formatCount(usage.failed),
    hasFailures: usage.failed > 0,
    tokensIn: tokens(usage.inputTokens),
    tokensOut: tokens(usage.outputTokens),
    cost: formatCostCell({
      costMicros: usage.costMicros,
      calls: usage.calls,
      free,
      unpricedCalls: usage.unpricedCalls,
    }),
  };
}

function usageTable(summary: UsageSummaryInput): UsageTableView {
  const rows = summary.providers.map((provider) =>
    usageRow(
      provider.provider,
      providerName(provider.provider),
      provider,
      isFreeProvider(provider.provider),
    ),
  );
  const allFree = summary.providers.every((provider) => isFreeProvider(provider.provider));
  return {
    rows,
    totals: rows.length === 0 ? null : usageRow("total", "Total", summary.totals, allFree),
    unpricedNote: unpricedNote(summary.totals.unpricedCalls),
  };
}

export interface CallView {
  id: string;
  /** ISO instant, for the time element. */
  calledAt: string;
  calledAtLabel: string;
  provider: string;
  operation: string;
  retailer: string;
  ok: boolean;
  /** "ok", or the error kind of a failed call. */
  outcome: string;
  httpStatus: string;
  duration: string;
  /** "766 in, 180 out", or a dash for a call without tokens. */
  tokens: string;
  model: string | null;
  /** "unpriced" for a call on a model with no price; never a zero or "free" for one. */
  cost: string;
}

function callView(call: UsageCallInput, timeZone: string): CallView {
  const hasTokens = call.inputTokens !== null || call.outputTokens !== null;
  return {
    id: call.id,
    calledAt: call.calledAt.toISOString(),
    calledAtLabel: formatDateTimeIn(call.calledAt, timeZone),
    provider: providerName(call.provider),
    operation: call.operation,
    retailer: call.retailerSlug ?? DASH,
    ok: call.outcome === "ok",
    outcome: call.outcome === "ok" ? "ok" : (call.errorKind ?? "failed"),
    httpStatus: call.httpStatus === null ? DASH : String(call.httpStatus),
    duration: formatDurationMs(call.durationMs),
    tokens: hasTokens
      ? `${formatCount(call.inputTokens ?? 0)} in, ${formatCount(call.outputTokens ?? 0)} out`
      : DASH,
    model: call.model,
    cost: formatCostCell({
      costMicros: call.costMicros,
      calls: 1,
      free: isFreeProvider(call.provider),
      unpricedCalls: call.priced ? 0 : 1,
    }),
  };
}

export interface LastOkView {
  key: string;
  provider: string;
  /** The retailer slug, or "any" for calls made for no one retailer. */
  retailer: string;
  lastOkAt: string;
  lastOkAtLabel: string;
  age: string;
}

function lastOkView(entry: LastOkInput, now: Date, timeZone: string): LastOkView {
  return {
    key: `${entry.provider}/${entry.retailerSlug ?? ""}`,
    provider: providerName(entry.provider),
    retailer: entry.retailerSlug ?? "any",
    lastOkAt: entry.lastOkAt.toISOString(),
    lastOkAtLabel: formatDateTimeIn(entry.lastOkAt, timeZone),
    age: formatAge(entry.lastOkAt, now),
  };
}

export interface ChartBarView {
  day: string;
  /** Tooltip text: "30 Sep: 7 calls, $0.0014 estimated". */
  title: string;
  calls: number;
  segments: { provider: string; colourIndex: number; base: number; calls: number }[];
}

export interface ChartView {
  legend: { provider: string; label: string; colourIndex: number }[];
  bars: ChartBarView[];
  yMax: number;
  yTicks: { value: number; label: string }[];
  firstDayLabel: string;
  lastDayLabel: string;
  /** "9 calls, $0.0014 estimated, over the last 30 days." */
  summary: string;
  ariaLabel: string;
  /** The days that had calls, newest first, for the table under the chart. */
  activeDays: { day: string; label: string; calls: string; cost: string; breakdown: string }[];
  /** What the unpriced calls in the window mean for its costs, or null when there are none. */
  unpricedNote: string | null;
}

/** ", $0.0014 estimated" for a cost worth stating, "at least" when it is a lower bound, "" for none. */
function costPhrase(costMicros: number, callCount: number, unpricedCalls: number): string {
  if (unpricedCalls >= callCount) return ", unpriced";
  if (unpricedCalls > 0) return `, at least ${formatUsdMicros(costMicros)} estimated`;
  return costMicros > 0 ? `, ${formatUsdMicros(costMicros)} estimated` : "";
}

function chartView(chart: DailyChart): ChartView {
  const colourOf = new Map(chart.providers.map((provider, index) => [provider, index]));
  const bars: ChartBarView[] = chart.bars.map((bar) => ({
    day: bar.day,
    title:
      bar.calls === 0
        ? `${formatShortDate(bar.day)}: no calls`
        : `${formatShortDate(bar.day)}: ${calls(bar.calls)}${
            costPhrase(bar.costMicros, bar.calls, bar.unpricedCalls) || ", no cost"
          }`,
    calls: bar.calls,
    segments: bar.segments.map((segment) => ({
      provider: segment.provider,
      colourIndex: colourOf.get(segment.provider) ?? 0,
      base: segment.base,
      calls: segment.calls,
    })),
  }));
  const dayCount = chart.bars.length;
  const summary = `${calls(chart.totalCalls)}${costPhrase(
    chart.totalCostMicros,
    chart.totalCalls,
    chart.totalUnpricedCalls,
  )} over the last ${dayCount} ${dayCount === 1 ? "day" : "days"}.`;
  return {
    legend: chart.providers.map((provider, index) => ({
      provider,
      label: providerName(provider),
      colourIndex: index,
    })),
    bars,
    yMax: chart.yMax,
    yTicks: chart.yTicks.map((value) => ({ value, label: formatCount(value) })),
    firstDayLabel: formatShortDate(chart.bars[0].day),
    lastDayLabel: formatShortDate(chart.bars[chart.bars.length - 1].day),
    summary,
    ariaLabel: `Calls per day, stacked by provider. ${summary}`,
    activeDays: chart.bars
      .filter((bar) => bar.calls > 0)
      .reverse()
      .map((bar) => ({
        day: bar.day,
        label: formatShortDate(bar.day),
        calls: formatCount(bar.calls),
        // Free only when every provider called that day is free.
        cost: formatCostCell({
          costMicros: bar.costMicros,
          calls: bar.calls,
          free: bar.segments.every((segment) => isFreeProvider(segment.provider)),
          unpricedCalls: bar.unpricedCalls,
        }),
        breakdown: bar.segments
          .map((segment) => `${providerName(segment.provider)} ${formatCount(segment.calls)}`)
          .join(", "),
      })),
    unpricedNote: unpricedNote(chart.totalUnpricedCalls),
  };
}

export interface UsageView {
  /** True when the ledger holds nothing the page asked for. */
  empty: boolean;
  /** The zone every day and time in this view is in, for the page to name. */
  timeZone: string;
  /** How many days the chart covers. */
  dayCount: number;
  today: UsageTableView;
  monthToDate: UsageTableView;
  /** Null when the window holds no call. */
  chart: ChartView | null;
  recent: CallView[];
  lastOk: LastOkView[];
}

/** Shapes the usage service's dashboard for the page. Times are printed in the dashboard's own zone. */
export function toUsageView(dashboard: UsageDashboardInput): UsageView {
  const { now, timeZone } = dashboard;
  const chart = buildDailyChart(dashboard.daily.days, dashboard.daily.rows);
  return {
    empty:
      dashboard.recent.length === 0 && dashboard.monthToDate.totals.calls === 0 && chart === null,
    timeZone,
    dayCount: dashboard.daily.days.length,
    today: usageTable(dashboard.today),
    monthToDate: usageTable(dashboard.monthToDate),
    chart: chart === null ? null : chartView(chart),
    recent: dashboard.recent.map((call) => callView(call, timeZone)),
    lastOk: dashboard.lastOk.map((entry) => lastOkView(entry, now, timeZone)),
  };
}
