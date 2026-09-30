// limiter: admits at most `limit` async jobs at once, first come first
// served. A source keeps one per external host as a politeness guard so a
// burst of pages does not become a burst of requests. Pure: no I/O.

export interface Limiter {
  /** Runs `fn` once a slot is free and frees the slot when it settles, resolved or rejected. */
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createLimiter(limit: number): Limiter {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`Limiter needs a positive integer limit, got ${limit}`);
  }
  let active = 0;
  const waiting: Array<() => void> = [];

  return {
    async run(fn) {
      if (active < limit) {
        active += 1;
      } else {
        await new Promise<void>((admit) => waiting.push(admit));
      }
      try {
        return await fn();
      } finally {
        // Hand the slot straight to the next in line, or give it back.
        const next = waiting.shift();
        if (next === undefined) active -= 1;
        else next();
      }
    },
  };
}
