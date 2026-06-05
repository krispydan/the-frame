/**
 * Vitest coverage for the Phase 4 extended-metafields builder. Asserts
 * the metafieldsSet payload includes the new fields (Custom Labels
 * 0-4, style_era, collection_batch, deterministic SEO) and the price-
 * tier + era classification logic is correct.
 *
 * Pure function — no DB, no GraphQL mocks.
 */

import { describe, it, expect } from "vitest";
import {
  buildExtendedMetafields,
  type ProductForExtendedMetafields,
} from "@/modules/catalog/lib/shopify-metafields/extended-metafields";

const PRODUCT_GID = "gid://shopify/Product/42";

function basicSnapshot(
  overrides: Partial<ProductForExtendedMetafields> = {},
): ProductForExtendedMetafields {
  return {
    productName: "Havana Haze",
    frameShape: "round",
    styleTags: ["vintage"],
    gender: "unisex",
    frameColor: "tortoise",
    frameMaterial: "acetate",
    lensType: "polarized",
    description: "A round acetate sunglass.",
    collectionBatch: "SS26",
    retailPrice: 45,
    ...overrides,
  };
}

function byKey(
  out: ReadonlyArray<{ namespace: string; key: string; value: string }>,
  namespace: string,
  key: string,
): string | undefined {
  return out.find((m) => m.namespace === namespace && m.key === key)?.value;
}

describe("buildExtendedMetafields", () => {
  it("emits deterministic SEO title + description", () => {
    const out = buildExtendedMetafields(PRODUCT_GID, basicSnapshot());
    expect(byKey(out, "global", "title_tag")).toBe(
      "Vintage Round Sunglasses — Havana Haze | Jaxy",
    );
    const desc = byKey(out, "global", "description_tag");
    expect(desc).toContain("Havana Haze");
    expect(desc).toContain("by Jaxy");
    expect(desc!.length).toBeLessThanOrEqual(160);
  });

  it("Custom Label 0 = shape, 1 = era, 2 = gender, 4 = collection_batch", () => {
    const out = buildExtendedMetafields(PRODUCT_GID, basicSnapshot());
    expect(byKey(out, "global", "custom_label_0")).toBe("Round");
    expect(byKey(out, "global", "custom_label_1")).toBe("vintage");
    expect(byKey(out, "global", "custom_label_2")).toBe("Unisex");
    expect(byKey(out, "global", "custom_label_4")).toBe("SS26");
  });

  it("Custom Label 3 price tiers — under_30 / 30_50 / 50_plus", () => {
    const cheap = buildExtendedMetafields(PRODUCT_GID, basicSnapshot({ retailPrice: 25 }));
    expect(byKey(cheap, "global", "custom_label_3")).toBe("under_30");
    const mid = buildExtendedMetafields(PRODUCT_GID, basicSnapshot({ retailPrice: 35 }));
    expect(byKey(mid, "global", "custom_label_3")).toBe("30_50");
    const exp = buildExtendedMetafields(PRODUCT_GID, basicSnapshot({ retailPrice: 65 }));
    expect(byKey(exp, "global", "custom_label_3")).toBe("50_plus");
  });

  it("Custom Label 3 omitted when no retail price", () => {
    const out = buildExtendedMetafields(PRODUCT_GID, basicSnapshot({ retailPrice: null }));
    expect(byKey(out, "global", "custom_label_3")).toBeUndefined();
  });

  it("custom.style_era mirrors comma-joined era tags", () => {
    const out = buildExtendedMetafields(
      PRODUCT_GID,
      basicSnapshot({ styleTags: ["oversized", "vintage", "classic"] }),
    );
    // ERA_TAGS includes all three. Order preserved from input.
    expect(byKey(out, "custom", "style_era")).toBe("oversized,vintage,classic");
    // custom_label_1 takes the primary (first) era only.
    expect(byKey(out, "global", "custom_label_1")).toBe("oversized");
  });

  it("gender label defaults to Unisex when unknown", () => {
    const out = buildExtendedMetafields(
      PRODUCT_GID,
      basicSnapshot({ gender: null }),
    );
    expect(byKey(out, "global", "custom_label_2")).toBe("Unisex");
  });

  it("custom.collection_batch mirrors custom_label_4 when set", () => {
    const out = buildExtendedMetafields(PRODUCT_GID, basicSnapshot({ collectionBatch: "FW26" }));
    expect(byKey(out, "global", "custom_label_4")).toBe("FW26");
    expect(byKey(out, "custom", "collection_batch")).toBe("FW26");
  });

  it("omits collection_batch fields when null", () => {
    const out = buildExtendedMetafields(
      PRODUCT_GID,
      basicSnapshot({ collectionBatch: null }),
    );
    expect(byKey(out, "global", "custom_label_4")).toBeUndefined();
    expect(byKey(out, "custom", "collection_batch")).toBeUndefined();
  });

  it("DOES NOT emit the retired custom.frame_shape (Phase 4 retirement)", () => {
    const out = buildExtendedMetafields(PRODUCT_GID, basicSnapshot());
    expect(byKey(out, "custom", "frame_shape")).toBeUndefined();
  });

  it("all outputs are targeted at the correct productGid", () => {
    const out = buildExtendedMetafields(PRODUCT_GID, basicSnapshot());
    for (const m of out) {
      expect(m.ownerId).toBe(PRODUCT_GID);
    }
  });

  it("women & men gender labels are title-cased without 's'", () => {
    const w = buildExtendedMetafields(PRODUCT_GID, basicSnapshot({ gender: "womens" }));
    expect(byKey(w, "global", "custom_label_2")).toBe("Women");
    const m = buildExtendedMetafields(PRODUCT_GID, basicSnapshot({ gender: "mens" }));
    expect(byKey(m, "global", "custom_label_2")).toBe("Men");
  });

  it("wayfarer shape label is scrubbed to Square (TM)", () => {
    const out = buildExtendedMetafields(
      PRODUCT_GID,
      basicSnapshot({ frameShape: "wayfarer" }),
    );
    expect(byKey(out, "global", "custom_label_0")).toBe("Square");
  });
});
