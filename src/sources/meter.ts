// Metering for sources: one SourceCall per HTTP request, reported to the
// injected meter. Shared by http.ts, serpapi.ts and gemini.ts so every request
// is timed and classified the same way. Not exported from the index.

import {
  SourceError,
  type Meter,
  type SourceCall,
  type SourceErrorKind,
  type SourceOperation,
  type SourceProvider,
} from "./types";

/** What is known about a request before it is sent. */
export interface CallLabel {
  provider: SourceProvider;
  operation: SourceOperation;
  retailerSlug: string | null;
  model?: string | null;
}

/** What is known once it has answered or failed. */
export interface CallResult {
  /** Set when the call failed. A SourceError gives the kind and status; anything else is "network". */
  error?: unknown;
  /** The status of a response that arrived. Falls back to the error's status. */
  httpStatus?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

export type FinishCall = (result?: CallResult) => void;

const NOTHING: FinishCall = () => {};

function errorKindOf(error: unknown): SourceErrorKind {
  return error instanceof SourceError ? error.kind : "network";
}

function statusOf(result: CallResult): number | null {
  if (result.httpStatus !== undefined && result.httpStatus !== null) return result.httpStatus;
  return result.error instanceof SourceError ? result.error.status : null;
}

/** Hands a call to the meter. A meter that throws or rejects is ignored. */
export function report(meter: Meter, call: SourceCall): void {
  try {
    // Typed void, but an async function is assignable to it; its rejection
    // must not surface as an unhandled one.
    const returned: unknown = meter(call);
    if (returned instanceof Promise) returned.catch(() => {});
  } catch {
    // Metering is best effort. The source's own result stands.
  }
}

/** The clock's reading, or the wall clock's when the injected clock throws or returns no real date. */
function readClock(clock: () => Date): Date {
  try {
    const reading = clock();
    if (reading instanceof Date && Number.isFinite(reading.getTime())) return reading;
  } catch {
    // Fall through: a broken clock must not break the source being timed.
  }
  return new Date();
}

/**
 * Starts timing one request. Call the returned function exactly once, when
 * the request has answered or failed. Without a meter nothing is timed and
 * the clock is never read.
 *
 * Nothing here can throw: not a clock that throws, not a meter that throws.
 * Metering is an observer, and the source's own result always stands.
 */
export function beginCall(
  meter: Meter | undefined,
  now: (() => Date) | undefined,
  label: CallLabel,
): FinishCall {
  if (meter === undefined) return NOTHING;
  const clock = now ?? (() => new Date());
  const startedAt = readClock(clock);
  return (result = {}) => {
    try {
      const failed = result.error !== undefined;
      report(meter, {
        provider: label.provider,
        operation: label.operation,
        startedAt,
        durationMs: Math.max(0, readClock(clock).getTime() - startedAt.getTime()),
        outcome: failed ? "failed" : "ok",
        errorKind: failed ? errorKindOf(result.error) : null,
        httpStatus: statusOf(result),
        model: label.model ?? null,
        inputTokens: result.inputTokens ?? null,
        outputTokens: result.outputTokens ?? null,
        retailerSlug: label.retailerSlug,
      });
    } catch {
      // Best effort, as in report: whatever went wrong building the call, the source goes on.
    }
  };
}
