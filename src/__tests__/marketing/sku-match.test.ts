import { describe, it, expect } from "vitest";
import { mapCandidates } from "@/modules/marketing/lib/video/sku-match";
import type { ReferenceSku } from "@/modules/marketing/lib/video/sku-reference";

const ref = (sku: string, productId: string, productName: string, colorName = "Black"): ReferenceSku => ({
  skuId: `sid-${sku}`,
  sku,
  productId,
  productName,
  colorName,
  imagePath: `${sku}.jpg`,
});

const SKUS: ReferenceSku[] = [
  ref("JX1005-BLK", "p-windsor", "Windsor"),
  ref("JX1005-OLV", "p-windsor", "Windsor", "Olive"),
  ref("JX1005-TOR", "p-windsor", "Windsor", "Tortoise"),
  ref("JX1008-BLK", "p-bardot", "Bardot"),
];

describe("mapCandidates", () => {
  it("folds colorway answers into parent products, max confidence wins", () => {
    const out = mapCandidates(
      [
        { sku: "JX1005-OLV", confidence: 62 },
        { sku: "JX1005-TOR", confidence: 81 }, // same product, higher
        { sku: "JX1008-BLK", confidence: 35 },
      ],
      SKUS,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ productId: "p-windsor", sku: "JX1005-TOR", confidence: 81 });
    expect(out[1]).toMatchObject({ productId: "p-bardot", confidence: 35 });
  });

  it("drops SKU codes the model invented + tolerates case/whitespace", () => {
    const out = mapCandidates(
      [
        { sku: " jx1005-blk ", confidence: 90 },
        { sku: "JX9999-FAKE", confidence: 99 }, // not on the sheets → dropped
      ],
      SKUS,
    );
    expect(out).toHaveLength(1);
    expect(out[0].sku).toBe("JX1005-BLK");
  });

  it("clamps confidence to 0-100 and survives junk rows", () => {
    const out = mapCandidates(
      [
        { sku: "JX1005-BLK", confidence: 250 },
        { sku: "JX1008-BLK", confidence: -5 },
        { sku: 42 as unknown as string, confidence: 80 },
        {} as { sku?: string; confidence?: number },
      ],
      SKUS,
    );
    expect(out.find((c) => c.productId === "p-windsor")?.confidence).toBe(100);
    expect(out.find((c) => c.productId === "p-bardot")?.confidence).toBe(0);
    expect(out).toHaveLength(2);
  });

  it("sorts best-first", () => {
    const out = mapCandidates(
      [
        { sku: "JX1008-BLK", confidence: 88 },
        { sku: "JX1005-BLK", confidence: 44 },
      ],
      SKUS,
    );
    expect(out.map((c) => c.productId)).toEqual(["p-bardot", "p-windsor"]);
  });
});
