import { describe, it, expect } from "vitest";
import {
  mapCandidates,
  matchFilenameToProducts,
  mergeCandidates,
  type MatchCandidate,
} from "@/modules/marketing/lib/video/sku-match";
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

// A slice of the real catalog for filename tests — includes the exact
// collision from prod: a "Studio" product vs a "studio" shoot descriptor.
const CATALOG: ReferenceSku[] = [
  ref("JX1006-BRW", "p-solstice", "Solstice", "Brown"),
  ref("JX1011-BLK", "p-velvet", "Velvet Hour"),
  ref("JX4003-BLU", "p-studio", "Studio", "Blue"),
  ref("JX1009-BLK", "p-regent", "The Regent"),
  ref("JX2001-BLK", "p-eclipse", "Eclipse"),
];

describe("matchFilenameToProducts", () => {
  it("pulls the product from a real shoot filename, ignoring the 'studio' descriptor", () => {
    const r = matchFilenameToProducts("05_21_26_studio_Solstice_02__10.mp4", CATALOG);
    expect(r.strong).toBe(true);
    expect(r.candidates.map((c) => c.productId)).toEqual(["p-solstice"]); // NOT p-studio
    expect(r.candidates[0]).toMatchObject({ confidence: 90, via: "filename" });
  });

  it("matches multi-word names and names with a leading 'the'", () => {
    expect(matchFilenameToProducts("VelvetHour_take3.mp4", CATALOG).candidates[0].productId).toBe("p-velvet");
    expect(matchFilenameToProducts("shoot_The_Regent_v2.mov", CATALOG).candidates[0].productId).toBe("p-regent");
    expect(matchFilenameToProducts("Regent-final.mp4", CATALOG).candidates[0].productId).toBe("p-regent");
  });

  it("returns a weak match when only a shoot-descriptor product name is present", () => {
    const r = matchFilenameToProducts("2026_studio_bts_final.mp4", CATALOG);
    expect(r.strong).toBe(false);
    expect(r.candidates[0]).toMatchObject({ productId: "p-studio", confidence: 55 });
  });

  it("no match on an opaque filename", () => {
    expect(matchFilenameToProducts("ac58f307-4068a1529688cdd0_v1.mp4", CATALOG).candidates).toHaveLength(0);
    expect(matchFilenameToProducts(null, CATALOG).candidates).toHaveLength(0);
  });
});

describe("mergeCandidates", () => {
  const fn: MatchCandidate[] = [
    { productId: "p-solstice", productName: "Solstice", sku: "JX1006-BRW", skuId: "x", colorName: "Brown", confidence: 90, via: "filename" },
  ];
  const vision: MatchCandidate[] = [
    { productId: "p-velvet", productName: "Velvet Hour", sku: "JX1011-BLK", skuId: "y", colorName: "Black", confidence: 85, via: "vision" },
    { productId: "p-solstice", productName: "Solstice", sku: "JX1006-TOR", skuId: "z", colorName: "Tortoise", confidence: 40, via: "vision" },
  ];
  it("ranks the filename match above a confident-but-wrong vision guess", () => {
    const out = mergeCandidates(fn, vision);
    expect(out[0].productId).toBe("p-solstice"); // filename wins over Velvet Hour 85
    expect(out[0].via).toBe("both"); // vision also saw it (weakly)
    expect(out[0].confidence).toBe(90);
    expect(out.map((c) => c.productId)).toContain("p-velvet"); // still shown as an option
  });
});

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
