import { describe, expect, it } from "vitest";
import { REDACTED, redactSecrets } from "./redact";

const KEY = "sk-test-0123456789abcdef";
const DB_URL = "postgresql://postgres:hunter2@127.0.0.1:54322/postgres";

describe("redactSecrets", () => {
  it("replaces every occurrence of every secret", () => {
    expect(
      redactSecrets(`connect to ${DB_URL} failed; key ${KEY}; again ${KEY}`, [KEY, DB_URL]),
    ).toBe(`connect to ${REDACTED} failed; key ${REDACTED}; again ${REDACTED}`);
  });

  it("leaves text without a secret as it is", () => {
    expect(redactSecrets("connect ECONNREFUSED 127.0.0.1:54322", [KEY])).toBe(
      "connect ECONNREFUSED 127.0.0.1:54322",
    );
    expect(redactSecrets("anything", [])).toBe("anything");
  });

  it("ignores undefined, blank and very short values", () => {
    expect(redactSecrets("a b c ok", [undefined, "", "   ", "a", "ok"])).toBe("a b c ok");
  });

  it("matches a secret given with whitespace around it", () => {
    expect(redactSecrets(`key ${KEY}`, [`  ${KEY}\n`])).toBe(`key ${REDACTED}`);
  });

  it("removes the longer of two overlapping secrets whole", () => {
    const password = "hunter2-long";
    const url = `postgresql://postgres:${password}@db`;
    expect(redactSecrets(`failed for ${url}`, [password, url])).toBe(`failed for ${REDACTED}`);
  });

  it("treats a secret as text, not as a pattern", () => {
    expect(redactSecrets("cost a.b+c and axb+c", ["a.b+c"])).toBe(`cost ${REDACTED} and axb+c`);
  });
});
