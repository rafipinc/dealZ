import { describe, expect, it } from "vitest";
import { ConflictError, NotFoundError, ValidationError } from "./errors";

describe("service errors", () => {
  it("names NotFoundError and codes it not_found", () => {
    const error = new NotFoundError("no such thing");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("NotFoundError");
    expect(error.code).toBe("not_found");
    expect(error.message).toBe("no such thing");
  });

  it("names ConflictError and codes it conflict", () => {
    const error = new ConflictError("already published");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ConflictError");
    expect(error.code).toBe("conflict");
  });

  it("names ValidationError, codes it validation and carries optional issues", () => {
    const bare = new ValidationError("bad input");
    expect(bare).toBeInstanceOf(Error);
    expect(bare.name).toBe("ValidationError");
    expect(bare.code).toBe("validation");
    expect(bare.issues).toBeUndefined();

    const issues = [{ path: ["slug"], message: "Expected a kebab-case slug" }];
    expect(new ValidationError("bad input", issues).issues).toBe(issues);
  });
});
