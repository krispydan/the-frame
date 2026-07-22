import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../setup";
import { cropRect } from "@/modules/marketing/lib/video/frame-shape-vision";
import {
  loadFrameShapeVocabulary,
  productsByFrameShape,
  shapeCandidates,
} from "@/modules/marketing/lib/video/frame-shape";

// Seed a small catalog: products carry their frame shape via catalog_tags
// (the columns were dropped), each with one SKU.
function seedCatalog() {
  const d = getTestDb();
  const prod = d.prepare("INSERT INTO catalog_products (id, name) VALUES (?, ?)");
  const sku = d.prepare("INSERT INTO catalog_skus (id, product_id, sku, color_name) VALUES (?, ?, ?, ?)");
  const tag = d.prepare("INSERT INTO catalog_tags (id, product_id, tag_name, dimension, source) VALUES (?, ?, ?, ?, 'manual')");
  const rows: Array<[string, string, string, string, string]> = [
    // [productId, name, sku, color, frameShape]
    ["p-solstice", "Solstice", "JX1006-BRW", "Brown", "aviator"],
    ["p-velvet", "Velvet Hour", "JX1011-BLK", "Black", "cat-eye"],
    ["p-eclipse", "Eclipse", "JX2001-BLK", "Black", "aviator"],
    ["p-regent", "The Regent", "JX1009-BLK", "Black", "round"],
    ["p-studio", "Studio", "JX4003-BLU", "Blue", "square"],
  ];
  for (const [pid, name, s, color, shape] of rows) {
    prod.run(pid, name);
    sku.run(`sid-${s}`, pid, s, color);
    // dimension stored as camelCase in the app; the query normalizes it.
    tag.run(`t-${pid}`, pid, shape, "frameShape");
  }
  // A second colorway on Solstice — productsByFrameShape must pick ONE
  // representative SKU (alphabetically first), not duplicate the product.
  d.prepare("INSERT INTO catalog_skus (id, product_id, sku, color_name) VALUES (?, ?, ?, ?)")
    .run("sid-JX1006-BLK", "p-solstice", "JX1006-BLK", "Black");
}

beforeEach(() => {
  resetTestDb();
  seedCatalog();
});

describe("loadFrameShapeVocabulary", () => {
  it("returns the distinct shapes present in the catalog, lowercased + sorted", () => {
    expect(loadFrameShapeVocabulary()).toEqual(["aviator", "cat-eye", "round", "square"]);
  });

  it("falls back to the preset vocabulary when the catalog has no shape tags", () => {
    getTestDb().exec("DELETE FROM catalog_tags");
    const v = loadFrameShapeVocabulary();
    expect(v).toContain("aviator");
    expect(v).toContain("wayfarer");
    expect(v.length).toBeGreaterThan(5);
  });
});

describe("productsByFrameShape", () => {
  it("returns every product of a shape, one representative SKU each", () => {
    const aviators = productsByFrameShape(["aviator"]);
    expect(aviators.map((p) => p.productId).sort()).toEqual(["p-eclipse", "p-solstice"]);
    // Solstice has two colorways — the alphabetically-first SKU represents it.
    const solstice = aviators.find((p) => p.productId === "p-solstice")!;
    expect(solstice.sku).toBe("JX1006-BLK");
    expect(solstice.shape).toBe("aviator");
  });

  it("matches multiple shapes and is case-insensitive on the input", () => {
    const got = productsByFrameShape(["AVIATOR", "Round"]);
    expect(got.map((p) => p.productId).sort()).toEqual(["p-eclipse", "p-regent", "p-solstice"]);
  });

  it("returns nothing for an unknown shape or empty input", () => {
    expect(productsByFrameShape(["hexagonal"])).toEqual([]);
    expect(productsByFrameShape([])).toEqual([]);
  });
});

describe("shapeCandidates", () => {
  it("maps ranked shapes to products, carrying each shape's confidence", () => {
    const cands = shapeCandidates([
      { shape: "aviator", confidence: 82 },
      { shape: "round", confidence: 40 },
    ]);
    // Highest-confidence shape's products come first.
    expect(cands[0].confidence).toBe(82);
    expect(cands.map((c) => c.productId)).toContain("p-solstice");
    expect(cands.map((c) => c.productId)).toContain("p-regent");
    const regent = cands.find((c) => c.productId === "p-regent")!;
    expect(regent).toMatchObject({ confidence: 40, via: "frameshape", shape: "round" });
    // Every candidate has a usable SKU for downstream tagging.
    expect(cands.every((c) => c.skuId && c.sku)).toBe(true);
  });

  it("is empty when no shape matches the catalog", () => {
    expect(shapeCandidates([{ shape: "butterfly", confidence: 90 }])).toEqual([]);
  });
});

describe("cropRect (deterministic crop math)", () => {
  it("centers a near-full crop for landscape/product shots", () => {
    const r = cropRect(1000, 800);
    expect(r.width).toBe(860); // 0.86 * 1000
    expect(r.height).toBe(688); // 0.86 * 800
    expect(r.left).toBe(70); // centered
    expect(r.top).toBe(56); // centered (yAnchor 0.5)
  });

  it("anchors the band above center for portrait (worn) shots", () => {
    const r = cropRect(1080, 1920);
    // Portrait defaults: 0.92 w, 0.55 h, yAnchor 0.4 → band sits high.
    expect(r.width).toBe(Math.round(1080 * 0.92));
    expect(r.height).toBe(Math.round(1920 * 0.55));
    const centeredTop = (1920 - r.height) / 2;
    expect(r.top).toBeLessThan(centeredTop); // biased upward
    expect(r.top).toBeGreaterThanOrEqual(0);
  });

  it("never produces a rectangle that exceeds the source bounds", () => {
    for (const [w, h] of [[100, 100], [500, 291], [960, 720], [1080, 1920], [50, 200]] as const) {
      const r = cropRect(w, h, { widthFrac: 1.2, heightFrac: 1.2, yAnchor: 1 });
      expect(r.left).toBeGreaterThanOrEqual(0);
      expect(r.top).toBeGreaterThanOrEqual(0);
      expect(r.left + r.width).toBeLessThanOrEqual(w);
      expect(r.top + r.height).toBeLessThanOrEqual(h);
    }
  });
});
