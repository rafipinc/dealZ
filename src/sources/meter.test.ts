import { describe, expect, it, vi } from "vitest";
import { beginCall, report, type CallLabel } from "./meter";
import { SourceError, type Meter, type SourceCall } from "./types";

const LABEL: CallLabel = { provider: "retailer", operation: "page", retailerSlug: "jb-hi-fi" };
const T0 = new Date("2026-10-01T00:00:00.000Z");

/** A clock that advances `stepMs` each time it is read. */
function steppingClock(stepMs: number): () => Date {
  let reads = 0;
  return () => new Date(T0.getTime() + stepMs * reads++);
}

function collecting(): { meter: Meter; calls: SourceCall[] } {
  const calls: SourceCall[] = [];
  return { meter: (call) => void calls.push(call), calls };
}

describe("beginCall", () => {
  it("reports an ok call with its start, duration and status", () => {
    const { meter, calls } = collecting();
    beginCall(meter, steppingClock(250), LABEL)({ httpStatus: 200 });
    expect(calls).toEqual([
      {
        provider: "retailer",
        operation: "page",
        startedAt: T0,
        durationMs: 250,
        outcome: "ok",
        errorKind: null,
        httpStatus: 200,
        model: null,
        inputTokens: null,
        outputTokens: null,
        retailerSlug: "jb-hi-fi",
      },
    ]);
  });

  it("reports an ok call with no result given", () => {
    const { meter, calls } = collecting();
    beginCall(meter, () => T0, LABEL)();
    expect(calls[0]).toMatchObject({ outcome: "ok", httpStatus: null, durationMs: 0 });
  });

  it("carries the model and token counts", () => {
    const { meter, calls } = collecting();
    const label: CallLabel = {
      provider: "gemini",
      operation: "generate_content",
      retailerSlug: null,
      model: "gemini-3.5-flash-lite",
    };
    beginCall(meter, () => T0, label)({ httpStatus: 200, inputTokens: 766, outputTokens: 180 });
    expect(calls[0]).toMatchObject({
      model: "gemini-3.5-flash-lite",
      inputTokens: 766,
      outputTokens: 180,
      retailerSlug: null,
    });
  });

  it("reports a SourceError as failed with its kind and status", () => {
    const { meter, calls } = collecting();
    const error = new SourceError("blocked", "jb-hi-fi", "no", { status: 403 });
    beginCall(meter, () => T0, LABEL)({ error });
    expect(calls[0]).toMatchObject({ outcome: "failed", errorKind: "blocked", httpStatus: 403 });
  });

  it("prefers the status of the response that arrived over the error's", () => {
    const { meter, calls } = collecting();
    const error = new SourceError("unparseable", "serpapi", "bad shape");
    beginCall(meter, () => T0, LABEL)({ error, httpStatus: 200 });
    expect(calls[0]).toMatchObject({ errorKind: "unparseable", httpStatus: 200 });
  });

  it("reports anything that is not a SourceError as a network failure with no status", () => {
    const { meter, calls } = collecting();
    beginCall(meter, () => T0, LABEL)({ error: new TypeError("boom") });
    expect(calls[0]).toMatchObject({ outcome: "failed", errorKind: "network", httpStatus: null });
  });

  it("never reports a negative duration when the clock goes backwards", () => {
    const { meter, calls } = collecting();
    beginCall(meter, steppingClock(-500), LABEL)();
    expect(calls[0].durationMs).toBe(0);
  });

  it("falls back to the wall clock when none is injected", () => {
    const { meter, calls } = collecting();
    beginCall(meter, undefined, LABEL)();
    expect(calls[0].startedAt).toBeInstanceOf(Date);
    expect(calls[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("does nothing, and never reads the clock, without a meter", () => {
    const now = vi.fn(() => T0);
    beginCall(undefined, now, LABEL)({ httpStatus: 200 });
    expect(now).not.toHaveBeenCalled();
  });

  it("survives a clock that throws when the call starts, and still reports the call", () => {
    const { meter, calls } = collecting();
    const now = () => {
      throw new Error("clock broke");
    };
    expect(() => beginCall(meter, now, LABEL)({ httpStatus: 200 })).not.toThrow();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ outcome: "ok", httpStatus: 200 });
    expect(calls[0].startedAt).toBeInstanceOf(Date);
    expect(calls[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("survives a clock that throws only when the call finishes", () => {
    const { meter, calls } = collecting();
    let reads = 0;
    const now = () => {
      if (reads++ > 0) throw new Error("clock broke");
      return T0;
    };
    const finish = beginCall(meter, now, LABEL);
    expect(() => finish({ httpStatus: 200 })).not.toThrow();
    expect(calls).toHaveLength(1);
    expect(calls[0].startedAt).toBe(T0);
    expect(Number.isFinite(calls[0].durationMs)).toBe(true);
  });

  it("falls back to the wall clock when the injected clock returns no real date", () => {
    const { meter, calls } = collecting();
    const broken = [new Date(Number.NaN), "2026-10-01" as unknown as Date];
    for (const reading of broken) beginCall(meter, () => reading, LABEL)();
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(Number.isFinite(call.startedAt.getTime())).toBe(true);
      expect(Number.isFinite(call.durationMs)).toBe(true);
    }
  });

  it("survives a result whose fields throw when read", () => {
    const { meter, calls } = collecting();
    const result = Object.defineProperty({}, "error", {
      get() {
        throw new Error("hostile getter");
      },
    });
    expect(() => beginCall(meter, () => T0, LABEL)(result)).not.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("survives a meter that throws", () => {
    const meter: Meter = () => {
      throw new Error("ledger down");
    };
    expect(() => beginCall(meter, () => T0, LABEL)()).not.toThrow();
  });
});

describe("report", () => {
  it("swallows the rejection of an async meter", async () => {
    const unhandled = vi.fn();
    process.once("unhandledRejection", unhandled);
    const meter = (async () => {
      throw new Error("ledger down");
    }) as unknown as Meter;
    const { calls, meter: collect } = collecting();
    beginCall(collect, () => T0, LABEL)();
    report(meter, calls[0]);
    await new Promise((resolve) => setImmediate(resolve));
    process.removeListener("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
