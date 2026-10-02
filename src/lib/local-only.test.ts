import { describe, expect, it } from "vitest";
import { isLocalDevelopment } from "./local-only";

describe("isLocalDevelopment", () => {
  it.each([
    ["development", true],
    ["production", false],
    ["test", false],
    ["", false],
    ["Development", false],
    [undefined, false],
  ])("%j is %s", (nodeEnv, expected) => {
    expect(isLocalDevelopment(nodeEnv)).toBe(expected);
  });
});
