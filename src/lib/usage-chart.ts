// The daily usage chart as plain numbers: one stacked bar of calls per day,
// one segment per provider, with the day's estimated cost alongside. Pure;
// the page only scales these onto an SVG viewBox.

export interface DailyUsageRow {
  /** "2026-09-30". */
  day: string;
  provider: string;
  calls: number;
  costMicros: number;
  /** Calls the price table cannot price. Absent means none. */
  unpricedCalls?: number;
}

export interface ChartSegment {
  provider: string;
  calls: number;
  costMicros: number;
  /** Calls stacked beneath this segment; the segment spans `base` to `base + calls`. */
  base: number;
}

export interface ChartBar {
  day: string;
  /** Calls across every provider that day. */
  calls: number;
  /** A lower bound when `unpricedCalls` is above zero. */
  costMicros: number;
  unpricedCalls: number;
  /** In the order of `providers`. Providers with no calls that day are left out. */
  segments: ChartSegment[];
}

export interface DailyChart {
  /** Every provider that appears, by name: the legend, and the stacking order. */
  providers: string[];
  /** One bar per requested day, oldest first, including days with no calls. */
  bars: ChartBar[];
  /** Top of the axis: a round number at or above the busiest day. At least 4. */
  yMax: number;
  /** Five ticks from 0 to yMax. */
  yTicks: number[];
  /** Calls and cost over the whole window. */
  totalCalls: number;
  /** A lower bound when `totalUnpricedCalls` is above zero. */
  totalCostMicros: number;
  totalUnpricedCalls: number;
}

const TICK_STEPS = 4;

/** The smallest of 1, 2 or 5 times a power of ten that gives four steps covering `max`. */
function niceMax(max: number): number {
  if (max <= TICK_STEPS) return TICK_STEPS;
  const rawStep = max / TICK_STEPS;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= rawStep);
  return (step ?? 10 * magnitude) * TICK_STEPS;
}

/**
 * Builds the chart for `days` from the ledger's daily rows. Rows for a day
 * outside `days` are ignored; a day with no row is an empty bar. Returns null
 * when no call falls inside the window, so the page shows an empty state
 * instead of an empty axis.
 */
export function buildDailyChart(
  days: readonly string[],
  rows: readonly DailyUsageRow[],
): DailyChart | null {
  const wanted = new Set(days);
  const inWindow = rows.filter((row) => wanted.has(row.day) && row.calls > 0);
  if (inWindow.length === 0) return null;

  const providers = Array.from(new Set(inWindow.map((row) => row.provider))).sort();
  const bars: ChartBar[] = days.map((day) => {
    let base = 0;
    let costMicros = 0;
    let unpricedCalls = 0;
    const segments: ChartSegment[] = [];
    for (const provider of providers) {
      // The ledger gives one row per day and provider; summing tolerates more.
      const matching = inWindow.filter((row) => row.day === day && row.provider === provider);
      if (matching.length === 0) continue;
      const calls = matching.reduce((sum, row) => sum + row.calls, 0);
      const cost = matching.reduce((sum, row) => sum + row.costMicros, 0);
      segments.push({ provider, calls, costMicros: cost, base });
      base += calls;
      costMicros += cost;
      unpricedCalls += matching.reduce((sum, row) => sum + (row.unpricedCalls ?? 0), 0);
    }
    return { day, calls: base, costMicros, unpricedCalls, segments };
  });

  const yMax = niceMax(Math.max(...bars.map((bar) => bar.calls)));
  return {
    providers,
    bars,
    yMax,
    yTicks: Array.from({ length: TICK_STEPS + 1 }, (_, index) => (yMax * index) / TICK_STEPS),
    totalCalls: bars.reduce((sum, bar) => sum + bar.calls, 0),
    totalCostMicros: bars.reduce((sum, bar) => sum + bar.costMicros, 0),
    totalUnpricedCalls: bars.reduce((sum, bar) => sum + bar.unpricedCalls, 0),
  };
}
