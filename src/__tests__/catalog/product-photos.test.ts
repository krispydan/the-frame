/**
 * Product-photo system: the canonical filename parser (pinned against
 * REAL names observed in the Drive folder), SKU routing across both
 * generations, bulk ingest with dedupe, and the coverage matrix.
 */
import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import sharp from "sharp";
import { getTestDb, resetTestDb } from "../setup";
import { parsePhotoFileName, PHOTO_KINDS } from "@/modules/catalog/lib/photo-kinds";
import { routePhotoFileName, ingestRoutedPhoto, photoCoverage, photoColorwayRoot } from "@/modules/catalog/lib/photo-ingest";

beforeAll(() => {
  process.env.IMAGES_PATH = mkdtempSync(path.join(tmpdir(), "photos-"));
});

describe("parsePhotoFileName — real Drive names", () => {
  const cases: Array<[string, { sku: string | null; kind: string; angle?: string; scope: string }]> = [
    ["JX1016-S-BLK_SQUARE_F8F9FA.jpg", { sku: "JX1016-S-BLK", kind: "square", scope: "sku" }],
    ["JX1019-R-BLK-SIDE_SQUARE_F8F9FA.jpg", { sku: "JX1019-R-BLK", kind: "square", angle: "SIDE", scope: "sku" }],
    ["JX1015-S-GRN-SIDE_SQUARE_F8F9FA.jpg", { sku: "JX1015-S-GRN", kind: "square", angle: "SIDE", scope: "sku" }],
    ["JX4008-BRW_NO_BG.png", { sku: "JX4008-BRW", kind: "no_bg", scope: "sku" }],
    ["JX3004-TOR_WHITE_BG.jpg", { sku: "JX3004-TOR", kind: "white_bg", scope: "sku" }],
    ["JX3004-TGN_CROPPED.png", { sku: "JX3004-TGN", kind: "cropped", scope: "sku" }],
    ["JX4011-BLK_google.png", { sku: "JX4011-BLK", kind: "google_hero", scope: "sku" }],
    ["JX4011-TOR_google.png", { sku: "JX4011-TOR", kind: "google_hero", scope: "sku" }],
    ["JX4011_case.png", { sku: null, kind: "case", scope: "product" }],
    ["JX4011_collage.png", { sku: null, kind: "collage", scope: "product" }],
    ["JX4011_collage2.png", { sku: null, kind: "collage", scope: "product" }],
    ["JX4011_lens.png", { sku: null, kind: "lens", scope: "product" }],
    ["JX4011_materials.png", { sku: null, kind: "materials", scope: "product" }],
    ["JX4011_dimensions.png", { sku: null, kind: "dimensions", scope: "product" }],
    ["JX2006-BLK.jpg", { sku: "JX2006-BLK", kind: "original", scope: "sku" }],
    ["JX2006-S-YLW.webp", { sku: "JX2006-S-YLW", kind: "original", scope: "sku" }],
    // Legacy archive naming maps to canonical kinds.
    ["JX3003-BLK_NOBG.png", { sku: "JX3003-BLK", kind: "no_bg", scope: "sku" }],
    ["JX3003-BLK_WHITEBG_SQUARE.jpg", { sku: "JX3003-BLK", kind: "square", scope: "sku" }],
    // Lifestyle escapes the pipeline by name, at either scope.
    ["JX4001-BLK_lifestyle_beach.jpg", { sku: "JX4001-BLK", kind: "lifestyle", scope: "sku" }],
  ];

  for (const [name, want] of cases) {
    it(`parses ${name}`, () => {
      const got = parsePhotoFileName(name);
      expect(got).not.toBeNull();
      expect(got!.sku).toBe(want.sku);
      expect(got!.kind).toBe(want.kind);
      expect(got!.scope).toBe(want.scope);
      if (want.angle) expect(got!.angle).toBe(want.angle);
    });
  }

  it("swallows a reader power suffix into the SKU (files named per power still parse)", () => {
    const got = parsePhotoFileName("JX1019-R-BLK-100_NO_BG.png");
    expect(got).toMatchObject({ sku: "JX1019-R-BLK-100", kind: "no_bg" });
    // Power + angle together, in the canonical order.
    const both = parsePhotoFileName("JX1019-R-BLK-100-SIDE_SQUARE_F8F9FA.jpg");
    expect(both).toMatchObject({ sku: "JX1019-R-BLK-100", kind: "square", angle: "SIDE" });
  });

  it("collapses reader powers to the colourway root — one photo per colourway", () => {
    expect(photoColorwayRoot("JX1019-R-BLK-100")).toBe("JX1019-R-BLK");
    expect(photoColorwayRoot("JX1019-R-BLK-300")).toBe("JX1019-R-BLK");
    // Sunglasses and bare reader colourways pass through untouched.
    expect(photoColorwayRoot("JX1016-S-BLK")).toBe("JX1016-S-BLK");
    expect(photoColorwayRoot("JX1019-R-BLK")).toBe("JX1019-R-BLK");
  });

  it("refuses names that don't follow the convention (manual bucket, not guesses)", () => {
    expect(parsePhotoFileName("IMG_5938.jpg")).toBeNull();
    expect(parsePhotoFileName("JX4009-BLK - FRONT - COLOR MOCKUP.jpg")).toBeNull();
    expect(parsePhotoFileName("Gemini_Generated_Image_abc.png")).toBeNull();
  });

  it("registry: exactly the platform-critical kinds are required", () => {
    expect(PHOTO_KINDS.filter((k) => k.required).map((k) => k.slug).sort())
      .toEqual(["no_bg", "original", "square"]);
  });
});

function seed() {
  const d = getTestDb();
  d.prepare(`INSERT INTO catalog_products (id, name, sku_prefix) VALUES ('p1', 'Windsor', 'JX1005')`).run();
  d.prepare(`INSERT INTO catalog_skus (id, product_id, sku, color_name) VALUES ('s1', 'p1', 'JX1005-S-TOR', 'Tortoise')`).run();
  d.prepare(`INSERT INTO catalog_skus (id, product_id, sku, color_name) VALUES ('s2', 'p1', 'JX1005-S-BLK', 'Black')`).run();
  // A reader style: one colourway, three power SKUs (real catalog shape).
  d.prepare(`INSERT INTO catalog_products (id, name, sku_prefix) VALUES ('p2', 'Circuit Readers', 'JX1019')`).run();
  for (const power of ["100", "150", "200"]) {
    d.prepare(`INSERT INTO catalog_skus (id, product_id, sku, color_name) VALUES ('r${power}', 'p2', 'JX1019-R-BLK-${power}', 'Black')`).run();
  }
}
beforeEach(() => {
  resetTestDb();
  seed();
});

describe("routing against the catalog", () => {
  it("routes current-generation names straight to the SKU", () => {
    const r = routePhotoFileName("JX1005-S-TOR_SQUARE_F8F9FA.jpg");
    expect(r.target).toMatchObject({ sku: "JX1005-S-TOR", kind: "square", angleSlug: "front" });
  });

  it("routes LEGACY names to the current-generation SKU (Drive predates -S-)", () => {
    const r = routePhotoFileName("JX1005-TOR_NO_BG.png");
    expect(r.target).toMatchObject({ sku: "JX1005-S-TOR", kind: "no_bg" });
  });

  it("routes product-scope assets to a representative SKU", () => {
    const r = routePhotoFileName("JX1005_collage.png");
    expect(r.target).toMatchObject({ sku: "JX1005-S-BLK", productScope: true, kind: "collage" });
  });

  it("names the failure for unknown SKUs", () => {
    const r = routePhotoFileName("JX9999-ZZZ_NO_BG.png");
    expect(r.error).toContain("JX9999-ZZZ");
  });
});

describe("ingest + coverage", () => {
  const png = () =>
    sharp({ create: { width: 64, height: 64, channels: 3, background: "#888" } }).png().toBuffer();

  it("uploads, stamps kind + angle, dedupes on re-upload", async () => {
    const bytes = await png();
    const first = await ingestRoutedPhoto({ bytes, fileName: "JX1005-S-TOR-SIDE_SQUARE_F8F9FA.jpg" });
    expect(first.status).toBe("uploaded");
    expect(first.kind).toBe("square");
    expect(first.angle).toBe("side");

    const row = getTestDb().prepare(
      `SELECT i.source, t.slug AS angle FROM catalog_images i LEFT JOIN catalog_image_types t ON t.id = i.image_type_id WHERE i.id = ?`,
    ).get(first.imageId) as { source: string; angle: string };
    expect(row.source).toBe("square");
    expect(row.angle).toBe("side"); // angle type row auto-created

    const again = await ingestRoutedPhoto({ bytes, fileName: "JX1005-S-TOR-SIDE_SQUARE_F8F9FA.jpg" });
    expect(again.status).toBe("deduped");
    expect(again.imageId).toBe(first.imageId);
  });

  it("explicit sku/kind overrides beat the filename", async () => {
    const r = await ingestRoutedPhoto({
      bytes: await png(),
      fileName: "whatever.png",
      sku: "JX1005-BLK", // legacy spelling resolves too
      kind: "lifestyle",
    });
    expect(r.status).toBe("uploaded");
    expect(r.sku).toBe("JX1005-S-BLK");
    expect(r.kind).toBe("lifestyle");
  });

  it("reader powers are ONE coverage row and one photo serves all of them", async () => {
    // File named per colourway (no power) routes via the representative.
    const up = await ingestRoutedPhoto({ bytes: await png(), fileName: "JX1019-R-BLK_SQUARE_F8F9FA.jpg" });
    expect(up.status).toBe("uploaded");
    expect(up.sku).toBe("JX1019-R-BLK"); // reported at colourway level

    const rows = photoCoverage({ search: "Circuit" });
    expect(rows).toHaveLength(1); // NOT three rows for three powers
    expect(rows[0].sku).toBe("JX1019-R-BLK");
    expect(rows[0].variantCount).toBe(3);
    expect(rows[0].kinds.square.count).toBe(1);
    expect(rows[0].missingRequired).not.toContain("square");

    // A file named with an explicit power lands on the same colourway.
    const powered = await ingestRoutedPhoto({
      bytes: await sharp({ create: { width: 40, height: 40, channels: 3, background: "#456" } }).png().toBuffer(),
      fileName: "JX1019-R-BLK-200_NO_BG.png",
    });
    expect(powered.status).toBe("uploaded");
    const after = photoCoverage({ search: "Circuit" });
    expect(after).toHaveLength(1);
    expect(after[0].kinds.no_bg.count).toBe(1);

    // Same BYTES under a different power name → dedupe across the
    // colourway, not a second copy.
    const dupe = await ingestRoutedPhoto({ bytes: await png(), fileName: "JX1019-R-BLK-150_SQUARE_F8F9FA.jpg" });
    expect(dupe.status).toBe("deduped");
  });

  it("coverage: per-SKU kinds, product-scope roll-up, missing required", async () => {
    await ingestRoutedPhoto({ bytes: await png(), fileName: "JX1005-S-TOR_SQUARE_F8F9FA.jpg" });
    await ingestRoutedPhoto({
      bytes: await sharp({ create: { width: 32, height: 32, channels: 3, background: "#123" } }).png().toBuffer(),
      fileName: "JX1005_collage.png",
    });

    const rows = photoCoverage({ search: "Windsor" });
    expect(rows).toHaveLength(2);
    const tor = rows.find((r) => r.sku === "JX1005-S-TOR")!;
    const blk = rows.find((r) => r.sku === "JX1005-S-BLK")!;

    expect(tor.kinds.square.count).toBe(1);
    expect(tor.kinds.square.url).toBeTruthy();
    // The collage was attached to BLK (representative) but covers BOTH.
    expect(tor.kinds.collage.count).toBe(1);
    expect(blk.kinds.collage.count).toBe(1);
    // TOR still needs original + no_bg; BLK all three.
    expect(tor.missingRequired.sort()).toEqual(["no_bg", "original"]);
    expect(blk.missingRequired.sort()).toEqual(["no_bg", "original", "square"]);
  });
});
