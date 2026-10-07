import { describe, expect, it } from "vitest";
import { rootCause } from "./errors";

/** How the query layer reports a failure: the SQL in the message, the driver's reason in the cause. */
function failedQuery(cause: unknown): Error {
  return new Error("Failed query: select count(*) from catalogue_candidate", { cause });
}

describe("rootCause", () => {
  it("walks a nested failure to its innermost Error", () => {
    const driver = new Error("connect ECONNREFUSED 127.0.0.1:54322");
    expect(rootCause(failedQuery(new Error("pool error", { cause: driver })))).toBe(driver);
  });

  it("gives an Error without a cause as it is", () => {
    const error = new Error("relation catalogue_candidate does not exist");
    expect(rootCause(error)).toBe(error);
  });

  it("gives the text when the innermost Error's cause is a string, not the SQL around it", () => {
    expect(rootCause(failedQuery("ECONNRESET"))).toBe("ECONNRESET");
    expect(rootCause(failedQuery(new Error("pool error", { cause: "ECONNRESET" })))).toBe(
      "ECONNRESET",
    );
  });

  it("keeps the innermost Error when its cause is a blank string", () => {
    const error = failedQuery("  ");
    expect(rootCause(error)).toBe(error);
  });

  it("keeps the innermost Error when its cause is neither an Error nor a string", () => {
    const error = failedQuery({ code: "ECONNRESET" });
    expect(rootCause(error)).toBe(error);
    const numbered = failedQuery(42);
    expect(rootCause(numbered)).toBe(numbered);
  });

  it("stops at the last new Error when a cause chain loops back on itself", () => {
    const outer = new Error("outer");
    const inner = new Error("inner", { cause: outer });
    outer.cause = inner;
    expect(rootCause(outer)).toBe(inner);

    const selfish = new Error("self");
    selfish.cause = selfish;
    expect(rootCause(selfish)).toBe(selfish);
  });

  it("gives a failure that is not an Error as it is", () => {
    expect(rootCause("pool closed")).toBe("pool closed");
    expect(rootCause(undefined)).toBeUndefined();
    const thrown = { message: "not an Error" };
    expect(rootCause(thrown)).toBe(thrown);
  });
});
