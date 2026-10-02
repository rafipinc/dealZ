// A bound on how long a caller waits for a promise. The promise itself is not
// cancelled; the caller just stops waiting for it.

export class TimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number) {
    super(message);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Resolves or rejects as `promise` does when it settles within `timeoutMs`;
 * otherwise rejects with TimeoutError carrying `message`. The timer is
 * cleared either way. A late rejection of `promise` is swallowed, so it never
 * surfaces as an unhandled one.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(message, timeoutMs)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (reason: unknown) => {
        clearTimeout(timer);
        reject(reason);
      },
    );
  });
}
