import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimeoutError, withTimeout } from "./timeout";

describe("withTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the value of a promise that settles in time, and clears its timer", async () => {
    await expect(withTimeout(Promise.resolve(7), 1_000, "too slow")).resolves.toBe(7);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with the promise's own reason when it fails in time, and clears its timer", async () => {
    const reason = new Error("refused");
    await expect(withTimeout(Promise.reject(reason), 1_000, "too slow")).rejects.toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with a TimeoutError once the bound passes", async () => {
    const never = new Promise<number>(() => {});
    const bounded = withTimeout(never, 3_000, "The database did not answer");
    const caught = bounded.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(2_999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    const error = await caught;
    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as TimeoutError).message).toBe("The database did not answer");
    expect((error as TimeoutError).timeoutMs).toBe(3_000);
  });

  it("ignores a promise that settles after the bound", async () => {
    let fail: (reason: Error) => void = () => {};
    const late = new Promise<number>((_resolve, reject) => {
      fail = reject;
    });
    const caught = withTimeout(late, 10, "too slow").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    expect(await caught).toBeInstanceOf(TimeoutError);

    const unhandled = vi.fn();
    process.once("unhandledRejection", unhandled);
    fail(new Error("late failure"));
    await vi.advanceTimersByTimeAsync(0);
    process.removeListener("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
