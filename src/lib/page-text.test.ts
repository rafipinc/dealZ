import { describe, expect, it } from "vitest";
import {
  TRIM_DEFAULTS,
  TRIM_SEPARATOR,
  decodeEntities,
  trimAroundPrices,
  visibleText,
} from "./page-text";

describe("decodeEntities", () => {
  it("decodes named, decimal and hex entities", () => {
    expect(decodeEntities("Tom &amp; Jerry &quot;live&quot; &#39;now&#39;")).toBe(
      "Tom & Jerry \"live\" 'now'",
    );
    expect(decodeEntities("&#36;4,158.00 &#x24;5 &pound;1 &nbsp;x")).toBe("$4,158.00 $5 £1  x");
  });

  it("decodes each entity once, so an escaped entity stays escaped", () => {
    expect(decodeEntities("&amp;#36;")).toBe("&#36;");
  });

  it("leaves an unknown entity as written", () => {
    expect(decodeEntities("&bogus; &#xZZ;")).toBe("&bogus; &#xZZ;");
  });
});

describe("visibleText", () => {
  it("drops scripts, styles, noscript blocks, comments and tags", () => {
    const html = `<html><head><title>A TV</title>
      <script type="application/ld+json">{"price": "9999"}</script>
      <style>.price { color: red }</style></head>
      <body><!-- $1 hidden --><noscript>Enable JS $2</noscript>
      <h1>Samsung 65" TV</h1><p class="price">$2,795.00</p></body></html>`;
    const text = visibleText(html);
    expect(text).toBe('A TV Samsung 65" TV $2,795.00');
    expect(text).not.toContain("9999");
    expect(text).not.toContain("color");
    expect(text).not.toContain("hidden");
    expect(text).not.toContain("Enable JS");
  });

  it("decodes entities, including numeric ones, and collapses whitespace", () => {
    const html = "<p>Samsung 65&quot; OLED</p>\n\n<p>&#36;4,158.00\t&amp; free delivery</p>";
    expect(visibleText(html)).toBe('Samsung 65" OLED $4,158.00 & free delivery');
  });

  it("separates text that tags separated, so a symbol in its own span stays readable", () => {
    expect(visibleText("<bdi><span>&#36;</span>4,158</bdi>")).toBe("$ 4,158");
  });

  it("is case-insensitive about block tag names", () => {
    expect(visibleText("<SCRIPT>var x = '$1';</SCRIPT><B>$2</B>")).toBe("$2");
  });
});

describe("trimAroundPrices", () => {
  const filler = (n: number, char = "x") => char.repeat(n);

  it("keeps the whole of a short text without a separator", () => {
    expect(trimAroundPrices("Samsung TV $2,795.00")).toBe("Samsung TV $2,795.00");
  });

  it("keeps the head and a window around a price far into the text", () => {
    const text = `${filler(2500)}${filler(5000, "y")}Sale $2,795.00 now${filler(5000, "z")}`;
    const trimmed = trimAroundPrices(text);
    const parts = trimmed.split(TRIM_SEPARATOR);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe(filler(2500));
    expect(parts[1]).toContain("Sale $2,795.00 now");
    expect(parts[1].length).toBe(2 * TRIM_DEFAULTS.window);
    expect(trimmed).not.toContain("x".repeat(2501));
  });

  it("merges overlapping windows so a fragment is sent once", () => {
    const text = `${filler(3000)}Was $3,295 now $2,795${filler(3000, "y")}`;
    const trimmed = trimAroundPrices(text);
    expect(trimmed.split(TRIM_SEPARATOR)).toHaveLength(2);
    expect(trimmed.match(/\$3,295/g)).toHaveLength(1);
    expect(trimmed.match(/\$2,795/g)).toHaveLength(1);
  });

  it("joins the head and an adjoining window without repeating text", () => {
    const text = `${filler(2600)}$99${filler(1000, "y")}`;
    const trimmed = trimAroundPrices(text);
    expect(trimmed).not.toContain(TRIM_SEPARATOR);
    expect(trimmed).toBe(text.slice(0, 2600 + 250));
  });

  it("respects the cap", () => {
    const pieces: string[] = [];
    for (let i = 0; i < 60; i += 1) pieces.push(`${filler(600, "y")}$${i}`);
    const trimmed = trimAroundPrices(pieces.join(""));
    expect(trimmed.length).toBe(TRIM_DEFAULTS.cap);
  });

  it("honours custom head, window and cap", () => {
    const text = `${filler(100)}$5${filler(100, "y")}`;
    expect(trimAroundPrices(text, { headChars: 10, window: 3 })).toBe(
      `${filler(10)}${TRIM_SEPARATOR}xxx$5y`,
    );
    expect(trimAroundPrices(text, { headChars: 10, window: 3, cap: 12 })).toBe(`${filler(10)}\n.`);
  });

  it("keeps the window for a page whose only price was written as &#36;4,158.00", () => {
    const html = `<html><body><p>${filler(4000, "a")}</p><p class="price">&#36;4,158.00</p><p>${filler(4000, "b")}</p></body></html>`;
    const trimmed = trimAroundPrices(visibleText(html));
    expect(trimmed).toContain("$4,158.00");
    expect(trimmed.length).toBeLessThan(4000);
  });

  it("treats a currency code as a symbol when asked", () => {
    const text = `${filler(3000)}Price AUD 4,158.00 inc GST${filler(3000, "y")}`;
    expect(trimAroundPrices(text)).not.toContain("4,158.00");
    expect(trimAroundPrices(text, { currencySymbols: ["$", "AUD"] })).toContain(
      "Price AUD 4,158.00 inc GST",
    );
  });

  it("returns an empty string for empty text", () => {
    expect(trimAroundPrices("")).toBe("");
  });
});
