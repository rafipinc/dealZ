import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceCall } from "@/sources";
import { record } from "./usage";
import { USAGE_WRITE_TIMEOUT_MS, usageLedger, type UsageRecorder } from "./usage-ledger";

// The real recorder writes to the application database; no test here reaches one.
vi.mock("./usage", () => ({ record: vi.fn(async () => undefined) }));

const call = (operation: SourceCall["operation"]): SourceCall => ({
  provider: "retailer",
  operation,
  startedAt: new Date("2026-10-01T00:00:00.000Z"),
  durationMs: 10,
  outcome: "ok",
  errorKind: null,
  httpStatus: 200,
  model: null,
  inputTokens: null,
  outputTokens: null,
  retailerSlug: "jb-hi-fi",
});

describe("usageLedger", () => {
  beforeEach(() => {
    vi.mocked(record).mockClear();
  });

  it("writes nothing until flushed, then every collected call with the variant", async () => {
    const written: unknown[] = [];
    const ledger = usageLedger(async (entry) => void written.push(entry));
    ledger.meter(call("page"));
    ledger.meter(call("snapshot"));
    expect(written).toEqual([]);

    expect(await ledger.flush("samsung-s85h-65-au")).toEqual({ calls: 2, recorded: 2 });
    expect(written).toEqual([
      { ...call("page"), variantSlug: "samsung-s85h-65-au" },
      { ...call("snapshot"), variantSlug: "samsung-s85h-65-au" },
    ]);
  });

  it("writes a call once when flushed twice", async () => {
    const written: unknown[] = [];
    const ledger = usageLedger(async (entry) => void written.push(entry));
    ledger.meter(call("page"));

    expect(await ledger.flush(null)).toEqual({ calls: 1, recorded: 1 });
    expect(await ledger.flush(null)).toEqual({ calls: 0, recorded: 0 });
    expect(written).toHaveLength(1);
  });

  it("flushes an empty ledger without calling the recorder", async () => {
    const recordUsage = vi.fn(async () => undefined);
    expect(await usageLedger(recordUsage).flush(null)).toEqual({ calls: 0, recorded: 0 });
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("uses usage.record when no recorder is given", async () => {
    const ledger = usageLedger();
    ledger.meter(call("page"));
    expect(await ledger.flush(null)).toEqual({ calls: 1, recorded: 1 });
    expect(record).toHaveBeenCalledWith({ ...call("page"), variantSlug: null });
  });

  it("counts only the writes that succeed, whether the recorder rejects or throws", async () => {
    let seen = 0;
    const ledger = usageLedger((() => {
      seen += 1;
      if (seen === 1) throw new Error("synchronous failure");
      return seen === 2 ? Promise.reject(new Error("write failed")) : Promise.resolve();
    }) as UsageRecorder);
    for (let index = 0; index < 4; index += 1) ledger.meter(call("page"));
    expect(await ledger.flush(null)).toEqual({ calls: 4, recorded: 2 });
  });

  it("abandons without writing: the calls are counted and none is recorded", () => {
    const recordUsage = vi.fn(async () => undefined);
    const ledger = usageLedger(recordUsage);
    ledger.meter(call("page"));
    expect(ledger.abandon()).toEqual({ calls: 1, recorded: 0 });
    expect(recordUsage).not.toHaveBeenCalled();
  });

  describe("a recorder that never answers", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns once the bound passes, counting the writes confirmed by then", async () => {
      let seen = 0;
      const ledger = usageLedger(() => (++seen === 1 ? Promise.resolve() : new Promise(() => {})));
      ledger.meter(call("page"));
      ledger.meter(call("page"));

      let settled = false;
      const flushed = ledger.flush(null).then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(USAGE_WRITE_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await flushed).toEqual({ calls: 2, recorded: 1 });
    });
  });
});
