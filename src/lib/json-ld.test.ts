import { describe, expect, it } from "vitest";
import { extractJsonLd, findProduct, offerFromHtml, readProductOffer } from "./json-ld";

function ldBlock(value: unknown, attributes = 'type="application/ld+json"'): string {
  return `<script ${attributes}>${JSON.stringify(value)}</script>`;
}

const organisation = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "JB Hi-Fi",
};

const product = {
  "@context": "https://schema.org",
  "@type": "Product",
  name: "Samsung 65 inch S85H OLED 4K Smart TV",
  brand: { "@type": "Brand", name: "Samsung" },
  sku: "QA65S85HAWXXY",
  gtin13: "8806097962670",
  mpn: "QA65S85HAWXXY",
  model: "S85H",
  offers: {
    "@type": "Offer",
    price: "2795.00",
    priceCurrency: "aud",
    availability: "https://schema.org/InStock",
    itemCondition: "https://schema.org/NewCondition",
    priceSpecification: {
      "@type": "UnitPriceSpecification",
      priceType: "https://schema.org/StrikethroughPrice",
      price: 3999,
      priceCurrency: "AUD",
    },
  },
};

describe("extractJsonLd", () => {
  it("returns every ld+json block in document order, with the Product second", () => {
    const html = `<html><head>${ldBlock(organisation)}<script src="app.js"></script>${ldBlock(product)}</head></html>`;
    const nodes = extractJsonLd(html);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({ "@type": "Organization" });
    expect(nodes[1]).toMatchObject({ "@type": "Product" });
  });

  it("matches the script tag regardless of attribute order and quoting", () => {
    const html = [
      ldBlock(organisation, `data-x="1" type='application/ld+json'`),
      ldBlock(product, `type=application/ld+json id="p"`),
      ldBlock({ "@type": "Thing" }, `TYPE="APPLICATION/LD+JSON"`),
    ].join("\n");
    expect(extractJsonLd(html)).toHaveLength(3);
  });

  it("ignores scripts that are not ld+json", () => {
    const html = `<script type="text/javascript">var a = 1;</script><script>{"@type":"Product"}</script><script type="application/json">{"@type":"Product"}</script>`;
    expect(extractJsonLd(html)).toEqual([]);
  });

  it("flattens a @graph and drops the wrapper", () => {
    const html = ldBlock({ "@context": "https://schema.org", "@graph": [organisation, product] });
    const nodes = extractJsonLd(html);
    expect(nodes).toHaveLength(2);
    expect(nodes.some((n) => typeof n === "object" && n !== null && "@graph" in n)).toBe(false);
    expect(nodes[1]).toMatchObject({ "@type": "Product" });
  });

  it("flattens a top-level array, expanding any @graph inside it", () => {
    const html = ldBlock([organisation, { "@graph": [product] }]);
    const nodes = extractJsonLd(html);
    expect(nodes).toHaveLength(2);
    expect(nodes[1]).toMatchObject({ "@type": "Product" });
  });

  it("skips a block with junk JSON and keeps the rest", () => {
    const html = `<script type="application/ld+json">{ not json </script>${ldBlock(product)}<script type="application/ld+json"></script>`;
    const nodes = extractJsonLd(html);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ "@type": "Product" });
  });

  it("returns an empty list for a page with no scripts", () => {
    expect(extractJsonLd("<html><body><p>hello</p></body></html>")).toEqual([]);
  });

  it("keeps scalar nodes as they are", () => {
    expect(extractJsonLd(ldBlock("just a string"))).toEqual(["just a string"]);
  });
});

describe("findProduct", () => {
  it("returns the first node typed Product", () => {
    expect(findProduct([organisation, product])).toBe(product);
  });

  it("matches a node whose @type is an array containing Product", () => {
    const multi = { "@type": ["Thing", "Product"], name: "x" };
    expect(findProduct([organisation, multi])).toBe(multi);
  });

  it("ignores @type arrays with non-string entries", () => {
    expect(findProduct([{ "@type": [1, null] }])).toBeNull();
  });

  it("ignores nodes with a non-string @type", () => {
    expect(findProduct([{ "@type": 42 }, { "@type": { name: "Product" } }])).toBeNull();
  });

  it("ignores nodes that are not objects", () => {
    expect(findProduct(["Product", 1, null, undefined, ["Product"]])).toBeNull();
  });

  it("returns null when no Product is present", () => {
    expect(findProduct([organisation])).toBeNull();
    expect(findProduct([])).toBeNull();
  });
});

describe("readProductOffer", () => {
  it("reads every field from a full Product with an Offer", () => {
    expect(readProductOffer(product)).toEqual({
      name: "Samsung 65 inch S85H OLED 4K Smart TV",
      brand: "Samsung",
      sku: "QA65S85HAWXXY",
      gtin: "08806097962670",
      mpn: "QA65S85HAWXXY",
      model: "S85H",
      priceCents: 279500,
      currency: "AUD",
      strikethroughCents: 399900,
      shippingCents: null,
      availability: "in_stock",
      condition: "new",
    });
  });

  it("reads the Product found in a page with two ld+json blocks", () => {
    const html = `${ldBlock(organisation)}${ldBlock(product)}`;
    const offer = readProductOffer(findProduct(extractJsonLd(html)));
    expect(offer.priceCents).toBe(279500);
  });

  it("returns all nulls and unknown availability for a non-object", () => {
    const empty = {
      name: null,
      brand: null,
      sku: null,
      gtin: null,
      mpn: null,
      model: null,
      priceCents: null,
      currency: null,
      strikethroughCents: null,
      shippingCents: null,
      availability: "unknown",
      condition: "unknown",
    };
    expect(readProductOffer(null)).toEqual(empty);
    expect(readProductOffer("Product")).toEqual(empty);
    expect(readProductOffer([product])).toEqual(empty);
  });

  it("reads a brand given as a string", () => {
    expect(readProductOffer({ brand: "LG" }).brand).toBe("LG");
  });

  it("returns null for a brand object without a name or a brand of the wrong type", () => {
    expect(readProductOffer({ brand: { "@type": "Brand" } }).brand).toBeNull();
    expect(readProductOffer({ brand: 7 }).brand).toBeNull();
  });

  it("returns null for identifiers of the wrong type", () => {
    const offer = readProductOffer({ name: 1, sku: {}, mpn: [], model: false });
    expect(offer.name).toBeNull();
    expect(offer.sku).toBeNull();
    expect(offer.mpn).toBeNull();
    expect(offer.model).toBeNull();
  });

  it.each([
    ["gtin14", { gtin14: "08806097962670", gtin13: "0000000000000" }],
    ["gtin13", { gtin13: "8806097962670", gtin12: "0000000000000" }],
    ["gtin12", { gtin12: "036000291452", gtin8: "0000000000000" }],
    ["gtin8", { gtin8: "96385074", gtin: "0000000000000" }],
    ["gtin", { gtin: "8806097962670" }],
  ])("takes the GTIN from %s ahead of the fields after it", (_field, input) => {
    expect(readProductOffer(input).gtin).toMatch(/^\d{14}$/);
  });

  it("normalises a numeric GTIN to 14 digits", () => {
    expect(readProductOffer({ gtin13: 8806097962670 }).gtin).toBe("08806097962670");
  });

  it("returns null for a GTIN with a bad check digit", () => {
    expect(readProductOffer({ gtin13: "8806097962671" }).gtin).toBeNull();
  });

  it("returns null for a GTIN of the wrong type", () => {
    expect(readProductOffer({ gtin13: { value: "8806097962670" } }).gtin).toBeNull();
  });

  it("returns a null GTIN when none is present", () => {
    expect(readProductOffer({ name: "x" }).gtin).toBeNull();
  });

  it("leaves price, currency, strikethrough and availability empty when there are no offers", () => {
    const html = ldBlock({ "@type": "Product", name: "No offers", sku: "S1" });
    const offer = readProductOffer(findProduct(extractJsonLd(html)));
    expect(offer).toMatchObject({
      name: "No offers",
      sku: "S1",
      priceCents: null,
      currency: null,
      strikethroughCents: null,
      availability: "unknown",
      condition: "unknown",
    });
  });

  it("treats an empty offers array and a non-object offer as no offer", () => {
    expect(readProductOffer({ offers: [] }).priceCents).toBeNull();
    expect(readProductOffer({ offers: "2795" }).priceCents).toBeNull();
  });

  it("uses the first offer of an offers array", () => {
    const offer = readProductOffer({
      offers: [
        { "@type": "Offer", price: 2795, priceCurrency: "AUD" },
        { "@type": "Offer", price: 2999, priceCurrency: "AUD" },
      ],
    });
    expect(offer.priceCents).toBe(279500);
  });

  it("reads lowPrice from an AggregateOffer", () => {
    const html = ldBlock({
      "@type": "Product",
      name: "Aggregate",
      offers: {
        "@type": "AggregateOffer",
        lowPrice: "2,695.00",
        highPrice: "2999",
        price: "9999",
        priceCurrency: "AUD",
        offerCount: 3,
      },
    });
    const offer = readProductOffer(findProduct(extractJsonLd(html)));
    expect(offer.priceCents).toBe(269500);
    expect(offer.currency).toBe("AUD");
  });

  it("returns a null price when an AggregateOffer has no lowPrice", () => {
    expect(
      readProductOffer({ offers: { "@type": "AggregateOffer", price: "9999" } }).priceCents,
    ).toBeNull();
  });

  it("accepts a numeric price and a numeric string price", () => {
    expect(readProductOffer({ offers: { price: 2795 } }).priceCents).toBe(279500);
    expect(readProductOffer({ offers: { price: "$2,795.00" } }).priceCents).toBe(279500);
  });

  it("returns a null price for a price of the wrong type", () => {
    expect(readProductOffer({ offers: { price: { value: 1 } } }).priceCents).toBeNull();
  });

  it("uppercases the currency and returns null when it is missing", () => {
    expect(readProductOffer({ offers: { priceCurrency: "aud" } }).currency).toBe("AUD");
    expect(readProductOffer({ offers: { price: 1 } }).currency).toBeNull();
    expect(readProductOffer({ offers: { priceCurrency: 36 } }).currency).toBeNull();
  });

  it.each([
    ["a full https schema.org URL", "https://schema.org/InStock", "in_stock"],
    ["a full http schema.org URL", "http://schema.org/OutOfStock", "out_of_stock"],
    ["a bare token", "InStock", "in_stock"],
    ["a bare lower-camel token", "inStock", "in_stock"],
    ["a padded token", "  OutOfStock  ", "out_of_stock"],
    ["InStoreOnly", "https://schema.org/InStoreOnly", "in_stock"],
    ["OnlineOnly", "https://schema.org/OnlineOnly", "in_stock"],
    ["LimitedAvailability", "https://schema.org/LimitedAvailability", "in_stock"],
    ["PreSale", "https://schema.org/PreSale", "in_stock"],
    ["SoldOut", "https://schema.org/SoldOut", "out_of_stock"],
    ["Discontinued", "https://schema.org/Discontinued", "out_of_stock"],
    ["BackOrder", "https://schema.org/BackOrder", "unknown"],
    ["PreOrder", "PreOrder", "unknown"],
    ["an empty string", "", "unknown"],
  ])("maps availability given as %s", (_label, availability, expected) => {
    expect(readProductOffer({ offers: { availability } }).availability).toBe(expected);
  });

  it("reads a bare inStock availability token from a page", () => {
    const html = ldBlock({
      "@type": "Product",
      offers: { "@type": "Offer", price: "2795", availability: "inStock" },
    });
    expect(readProductOffer(findProduct(extractJsonLd(html))).availability).toBe("in_stock");
  });

  it("returns unknown availability when the field is missing or not a string", () => {
    expect(readProductOffer({ offers: { price: 1 } }).availability).toBe("unknown");
    expect(readProductOffer({ offers: { availability: true } }).availability).toBe("unknown");
  });

  it("reads the strikethrough price from a priceSpecification array", () => {
    const html = ldBlock({
      "@type": "Product",
      offers: {
        "@type": "Offer",
        price: "2795",
        priceSpecification: [
          {
            "@type": "UnitPriceSpecification",
            priceType: "https://schema.org/SalePrice",
            price: "2795",
          },
          { "@type": "UnitPriceSpecification", priceType: "StrikethroughPrice", price: "3,999.00" },
        ],
      },
    });
    expect(readProductOffer(findProduct(extractJsonLd(html))).strikethroughCents).toBe(399900);
  });

  it("returns a null strikethrough when the specification is absent, malformed or has no strikethrough entry", () => {
    expect(readProductOffer({ offers: { price: 1 } }).strikethroughCents).toBeNull();
    expect(
      readProductOffer({ offers: { priceSpecification: "3999" } }).strikethroughCents,
    ).toBeNull();
    expect(
      readProductOffer({ offers: { priceSpecification: [{ price: "3999" }] } }).strikethroughCents,
    ).toBeNull();
    expect(
      readProductOffer({
        offers: {
          priceSpecification: { priceType: "https://schema.org/ListPrice", price: "3999" },
        },
      }).strikethroughCents,
    ).toBeNull();
  });

  it("reads the shipping rate from shippingDetails, taking the first of an array", () => {
    const rate = (value: unknown) => ({ "@type": "OfferShippingDetails", shippingRate: { value } });
    expect(
      readProductOffer({ offers: { price: 1, shippingDetails: rate("59.00") } }).shippingCents,
    ).toBe(5900);
    expect(readProductOffer({ offers: { price: 1, shippingDetails: rate(0) } }).shippingCents).toBe(
      0,
    );
    expect(
      readProductOffer({ offers: { price: 1, shippingDetails: [rate(10), rate(20)] } })
        .shippingCents,
    ).toBe(1000);
  });

  it("returns null shipping when shippingDetails is absent, malformed or has no rate", () => {
    expect(readProductOffer({ offers: { price: 1 } }).shippingCents).toBeNull();
    expect(
      readProductOffer({ offers: { price: 1, shippingDetails: "free" } }).shippingCents,
    ).toBeNull();
    expect(
      readProductOffer({ offers: { price: 1, shippingDetails: { deliveryTime: {} } } })
        .shippingCents,
    ).toBeNull();
    expect(
      readProductOffer({ offers: { price: 1, shippingDetails: { shippingRate: "cheap" } } })
        .shippingCents,
    ).toBeNull();
    expect(
      readProductOffer({
        offers: { price: 1, shippingDetails: { shippingRate: { value: "n/a" } } },
      }).shippingCents,
    ).toBeNull();
  });

  it("returns a null strikethrough when the entry has no usable price", () => {
    expect(
      readProductOffer({
        offers: { priceSpecification: { priceType: "StrikethroughPrice" } },
      }).strikethroughCents,
    ).toBeNull();
  });

  it.each([
    ["a full https schema.org URL", "https://schema.org/NewCondition", "new"],
    ["a full http schema.org URL", "http://schema.org/UsedCondition", "used"],
    ["a bare token", "RefurbishedCondition", "refurbished"],
    ["a bare lower-camel token", "newCondition", "new"],
    ["a padded token", "  UsedCondition  ", "used"],
    ["DamagedCondition", "https://schema.org/DamagedCondition", "used"],
    ["an unknown token", "https://schema.org/MintCondition", "unknown"],
    ["an empty string", "", "unknown"],
  ])("maps itemCondition given as %s", (_label, itemCondition, expected) => {
    expect(readProductOffer({ offers: { itemCondition } }).condition).toBe(expected);
  });

  it("returns unknown condition when itemCondition is missing or not a string", () => {
    expect(readProductOffer({ offers: { price: 1 } }).condition).toBe("unknown");
    expect(readProductOffer({ offers: { itemCondition: 1 } }).condition).toBe("unknown");
    expect(readProductOffer({ name: "no offers" }).condition).toBe("unknown");
  });
});

describe("offerFromHtml", () => {
  it("returns the Product node and its offer for a page with one", () => {
    const html = `<html><head>${ldBlock(organisation)}${ldBlock(product)}</head></html>`;
    const result = offerFromHtml(html);
    expect(result).not.toBeNull();
    expect(result?.product).toEqual(product);
    expect(result?.offer.priceCents).toBe(279500);
    expect(result?.offer.condition).toBe("new");
  });

  it("returns null for a page without a Product", () => {
    expect(offerFromHtml(`<html>${ldBlock(organisation)}</html>`)).toBeNull();
    expect(offerFromHtml("<html><body>nothing</body></html>")).toBeNull();
  });
});
