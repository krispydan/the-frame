import { describe, it, expect } from "vitest";
import { matchFilenameToProducts } from "@/modules/marketing/lib/video/sku-match";
import type { ReferenceSku } from "@/modules/marketing/lib/video/sku-reference";

const ref = (sku: string, productId: string, productName: string, colorName = "Black"): ReferenceSku => ({
  skuId: `sid-${sku}`,
  sku,
  productId,
  productName,
  colorName,
  imagePath: `${sku}.jpg`,
});

// A slice of the real catalog — includes the exact collision from prod:
// a "Studio" product vs a "studio" shoot descriptor.
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

  it("works for photoshoot image names too", () => {
    const r = matchFilenameToProducts("lifestyle_eclipse_beach_007.jpg", CATALOG);
    expect(r.strong).toBe(true);
    expect(r.candidates[0].productId).toBe("p-eclipse");
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
