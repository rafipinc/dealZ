// The bridge between a source's meter and the usage ledger, shared by every
// service that makes outbound calls (quotes, status). The meter only collects,
// so nothing a source does waits on the database; the calls are written at
// the end, best effort, with a bounded wait. A ledger that cannot be written
// never fails the work it was observing: the caller is told how many calls
// were made and how many were recorded, and reports that.

import { withTimeout } from "@/lib/timeout";
import type { Meter, SourceCall } from "@/sources";
import { record, type RecordUsageInput } from "./usage";

/** Writes one metered call to the usage ledger. usage.record is the real one. */
export type UsageRecorder = (call: RecordUsageInput) => Promise<unknown>;

/**
 * What became of the calls a piece of work made. `recorded` below `calls`
 * means the ledger could not be written, or did not confirm the write in time.
 */
export interface UsageRecording {
  /** Outbound requests the sources made. */
  calls: number;
  /** How many of them the ledger confirmed before the report was returned. */
  recorded: number;
}

/**
 * How long a caller waits for the ledger before returning without it. A
 * stopped database refuses at once; this bounds a host that accepts the
 * connection and then says nothing, so a request never hangs on the ledger.
 * A write still in flight is not cancelled and may land later; it is not
 * counted, because nothing confirmed it.
 */
export const USAGE_WRITE_TIMEOUT_MS = 2_000;

export interface UsageLedger {
  /** Hand this to every source call. */
  meter: Meter;
  /** Writes every collected call with the variant it was made for. Never throws. */
  flush: (variantSlug: string | null) => Promise<UsageRecording>;
  /** For a caller that already knows the ledger cannot be written: counts the calls, writes none. */
  abandon: () => UsageRecording;
}

export function usageLedger(recordUsage: UsageRecorder = record): UsageLedger {
  const calls: SourceCall[] = [];
  return {
    meter: (call) => {
      calls.push(call);
    },
    flush: async (variantSlug) => {
      // Counted as each write confirms, so a timeout reports exactly the
      // writes that had landed by then.
      let recorded = 0;
      // Taken out of the ledger, so a second flush never writes a call twice.
      const batch = calls.splice(0);
      const writes = Promise.allSettled(
        batch.map(async (call) => {
          // Inside an async function, so a recorder that throws synchronously is a rejection too.
          await recordUsage({ ...call, variantSlug });
          recorded += 1;
        }),
      );
      try {
        await withTimeout(writes, USAGE_WRITE_TIMEOUT_MS, "The usage ledger did not answer");
      } catch {
        // Only the timeout rejects; allSettled never does. The report goes out without the rest.
      }
      return { calls: batch.length, recorded };
    },
    abandon: () => ({ calls: calls.splice(0).length, recorded: 0 }),
  };
}
