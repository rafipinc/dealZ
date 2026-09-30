import { describe, expect, it } from "vitest";
import { createLimiter } from "./limiter";

/** A promise whose settlement the test controls. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets queued microtasks run. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("createLimiter", () => {
  it("rejects a limit that is not a positive integer", () => {
    expect(() => createLimiter(0)).toThrowError(RangeError);
    expect(() => createLimiter(1.5)).toThrowError(RangeError);
  });

  it("admits the limit at once and queues the rest", async () => {
    const gate = createLimiter(2);
    const jobs = [deferred<string>(), deferred<string>(), deferred<string>()];
    const started: number[] = [];
    const results = jobs.map((job, i) =>
      gate.run(() => {
        started.push(i);
        return job.promise;
      }),
    );
    await tick();
    expect(started).toEqual([0, 1]);

    jobs[0].resolve("a");
    await tick();
    expect(started).toEqual([0, 1, 2]);

    jobs[1].resolve("b");
    jobs[2].resolve("c");
    expect(await Promise.all(results)).toEqual(["a", "b", "c"]);
  });

  it("releases the slot when a job rejects", async () => {
    const gate = createLimiter(1);
    const first = deferred<never>();
    let secondRan = false;
    const a = gate.run(() => first.promise);
    const b = gate.run(async () => {
      secondRan = true;
      return "ok";
    });
    await tick();
    expect(secondRan).toBe(false);

    first.reject(new Error("boom"));
    await expect(a).rejects.toThrow("boom");
    expect(await b).toBe("ok");
    expect(secondRan).toBe(true);
  });

  it("releases the slot when a job throws before returning a promise", async () => {
    const gate = createLimiter(1);
    const a = gate.run(() => {
      throw new Error("sync");
    });
    await expect(a).rejects.toThrow("sync");
    expect(await gate.run(async () => 1)).toBe(1);
  });

  it("admits queued jobs in the order they were submitted", async () => {
    const gate = createLimiter(1);
    const blocker = deferred<void>();
    const order: number[] = [];
    const running = [
      gate.run(() => blocker.promise),
      ...[1, 2, 3, 4].map((i) =>
        gate.run(async () => {
          order.push(i);
        }),
      ),
    ];
    await tick();
    expect(order).toEqual([]);
    blocker.resolve();
    await Promise.all(running);
    expect(order).toEqual([1, 2, 3, 4]);
  });
});
