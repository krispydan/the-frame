/**
 * Tests for the image upload system (Phases 1–6).
 *
 * Covers pure helpers and the sharp processing pipeline. The upload
 * route, bulk route, and serving route are integration-tested
 * end-to-end via the filesystem rather than mocked, so these tests
 * write to a temp dir.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

// Point IMAGES_PATH at a temp dir. local.ts reads this lazily at call
// time, so import ordering doesn't matter — but setting it up-front
// still guards against future refactors that cache the value.
const TEST_IMAGES_ROOT = mkdtempSync(path.join(tmpdir(), "frame-images-test-"));
process.env.IMAGES_PATH = TEST_IMAGES_ROOT;

import {
  matchSkuFromFilename,
  type UploaderSku,
} from "@/modules/catalog/lib/match-sku-filename";
import { catalogImageUrl } from "@/lib/storage/image-url";
import {
  getFullPath,
  saveImage,
  readImage,
  deleteImage,
  imageStat,
} from "@/lib/storage/local";
import {
  processImage,
  inspectImage,
  OUTPUT_SIZE,
  OUTPUT_MIME,
} from "@/lib/storage/image-processing";
import { findProductsMissingApprovedImages } from "@/modules/catalog/lib/export/image-precheck";
import sharp from "sharp";

afterAll(() => {
  try {
    rmSync(TEST_IMAGES_ROOT, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ─────────────────────────────────────────────────────────────────────
// matchSkuFromFilename
// ─────────────────────────────────────────────────────────────────────

describe("matchSkuFromFilename", () => {
  const skus: UploaderSku[] = [
    { id: "sku-1", sku: "84002", colorName: "Beige" },
    { id: "sku-2", sku: "84002", colorName: "Blue" },
    { id: "sku-3", sku: "84018", colorName: "Black" },
    { id: "sku-4", sku: "84018", colorName: "Tortoise Shell" },
    { id: "sku-5", sku: "90001", colorName: null },
  ];

  it("matches <sku>-<color>-<angle>.jpg", () => {
    expect(matchSkuFromFilename("84002-Beige-front.jpg", skus)).toBe("sku-1");
    expect(matchSkuFromFilename("84018-Black-side.jpg", skus)).toBe("sku-3");
  });

  it("matches when no angle suffix is present", () => {
    expect(matchSkuFromFilename("84002-Beige.jpg", skus)).toBe("sku-1");
  });

  it("is case-insensitive", () => {
    expect(matchSkuFromFilename("84002-BEIGE-front.jpg", skus)).toBe("sku-1");
    expect(matchSkuFromFilename("84002-beige-FRONT.JPG", skus)).toBe("sku-1");
  });

  it("normalizes underscores and spaces to hyphens", () => {
    expect(matchSkuFromFilename("84002_Beige_front.jpg", skus)).toBe("sku-1");
    expect(matchSkuFromFilename("84002 Beige front.jpg", skus)).toBe("sku-1");
  });

  it("matches multi-word colors with internal spaces", () => {
    expect(
      matchSkuFromFilename("84018-Tortoise Shell-front.jpg", skus),
    ).toBe("sku-4");
    expect(
      matchSkuFromFilename("84018_tortoise_shell.jpg", skus),
    ).toBe("sku-4");
  });

  it("matches bare SKUs when the SKU has no color", () => {
    expect(matchSkuFromFilename("90001.jpg", skus)).toBe("sku-5");
    expect(matchSkuFromFilename("90001-front.jpg", skus)).toBe("sku-5");
  });

  it("prefers the longest prefix match when multiple could apply", () => {
    // "84002-Beige-front" must win over "84002" alone — we'd never want
    // the SKU-only fallback if a color variant matches.
    const withBareSku: UploaderSku[] = [
      { id: "bare", sku: "84002", colorName: null },
      { id: "colored", sku: "84002", colorName: "Beige" },
    ];
    expect(matchSkuFromFilename("84002-Beige-front.jpg", withBareSku)).toBe(
      "colored",
    );
  });

  it("returns null when nothing matches", () => {
    expect(matchSkuFromFilename("random-filename.jpg", skus)).toBeNull();
    expect(matchSkuFromFilename("84002-Red.jpg", skus)).toBeNull(); // wrong color
    expect(matchSkuFromFilename("", skus)).toBeNull();
  });

  it("does not match partial SKU prefixes that aren't full segments", () => {
    // "84002X-foo.jpg" should NOT match 84002 because the segment
    // after "84002" is "X", not a SKU boundary.
    expect(matchSkuFromFilename("84002X-foo.jpg", skus)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// catalogImageUrl
// ─────────────────────────────────────────────────────────────────────

describe("catalogImageUrl", () => {
  const originalEnv = process.env.NEXT_PUBLIC_IMAGE_BASE_URL;
  afterAll(() => {
    if (originalEnv === undefined) {
      delete process.env.NEXT_PUBLIC_IMAGE_BASE_URL;
    } else {
      process.env.NEXT_PUBLIC_IMAGE_BASE_URL = originalEnv;
    }
  });

  it("returns null for null/undefined/empty", () => {
    expect(catalogImageUrl(null)).toBeNull();
    expect(catalogImageUrl(undefined)).toBeNull();
    expect(catalogImageUrl("")).toBeNull();
  });

  it("passes through absolute http/https URLs unchanged", () => {
    expect(catalogImageUrl("https://cdn.example.com/foo.jpg")).toBe(
      "https://cdn.example.com/foo.jpg",
    );
    expect(catalogImageUrl("http://example.com/bar.png")).toBe(
      "http://example.com/bar.png",
    );
  });

  it("uses the default base when NEXT_PUBLIC_IMAGE_BASE_URL is unset", () => {
    delete process.env.NEXT_PUBLIC_IMAGE_BASE_URL;
    expect(catalogImageUrl("sku-123/abc.jpg")).toBe(
      "https://theframe.getjaxy.com/api/images/sku-123/abc.jpg",
    );
  });

  it("strips the legacy data/images/ prefix from Gemini-generated rows", () => {
    delete process.env.NEXT_PUBLIC_IMAGE_BASE_URL;
    expect(catalogImageUrl("data/images/sku-123/front.png")).toBe(
      "https://theframe.getjaxy.com/api/images/sku-123/front.png",
    );
  });

  it("strips leading slashes", () => {
    delete process.env.NEXT_PUBLIC_IMAGE_BASE_URL;
    expect(catalogImageUrl("/sku-1/a.jpg")).toBe(
      "https://theframe.getjaxy.com/api/images/sku-1/a.jpg",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// Local storage helpers (+ path traversal guard)
// ─────────────────────────────────────────────────────────────────────

describe("storage/local", () => {
  it("getFullPath resolves under the root", () => {
    const full = getFullPath("sku-1/abc.jpg");
    expect(full.startsWith(TEST_IMAGES_ROOT)).toBe(true);
    expect(full.endsWith(`${path.sep}sku-1${path.sep}abc.jpg`)).toBe(true);
  });

  it("getFullPath rejects parent-directory traversal", () => {
    expect(() => getFullPath("../etc/passwd")).toThrow(/Path traversal/);
    expect(() => getFullPath("sku-1/../../secret")).toThrow(/Path traversal/);
    expect(() => getFullPath("../../../etc/passwd")).toThrow(/Path traversal/);
  });

  it("getFullPath strips leading slashes instead of treating paths as absolute", () => {
    const full = getFullPath("/sku-1/abc.jpg");
    expect(full.startsWith(TEST_IMAGES_ROOT)).toBe(true);
  });

  it("saveImage → readImage → deleteImage round-trip", async () => {
    const buf = Buffer.from("hello world", "utf-8");
    const rel = "test/round-trip.bin";

    await saveImage(buf, rel);

    const stat1 = await imageStat(rel);
    expect(stat1.exists).toBe(true);
    expect(stat1.size).toBe(buf.length);

    const read = await readImage(rel);
    expect(read.equals(buf)).toBe(true);

    await deleteImage(rel);
    const stat2 = await imageStat(rel);
    expect(stat2.exists).toBe(false);
  });

  it("deleteImage is idempotent when the file is already gone", async () => {
    await expect(deleteImage("does/not/exist.jpg")).resolves.toBeUndefined();
  });

  it("saveImage creates nested parent directories", async () => {
    const buf = Buffer.from([1, 2, 3]);
    const rel = "deeply/nested/path/file.bin";
    await saveImage(buf, rel);
    const stat = await imageStat(rel);
    expect(stat.exists).toBe(true);
    await deleteImage(rel);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Sharp processing pipeline
// ─────────────────────────────────────────────────────────────────────

describe("image-processing/processImage", () => {
  async function makeFixture(
    width: number,
    height: number,
    color: { r: number; g: number; b: number },
  ): Promise<Buffer> {
    return sharp({
      create: {
        width,
        height,
        channels: 3,
        background: color,
      },
    })
      .jpeg()
      .toBuffer();
  }

  it("produces a 2000×2000 JPEG with a sha256 checksum", async () => {
    const input = await makeFixture(3000, 2000, { r: 200, g: 100, b: 50 });
    const result = await processImage(input);

    expect(result.width).toBe(OUTPUT_SIZE);
    expect(result.height).toBe(OUTPUT_SIZE);
    expect(result.mimeType).toBe(OUTPUT_MIME);
    expect(result.size).toBeGreaterThan(0);
    expect(result.size).toBe(result.buffer.length);
    expect(result.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is deterministic: same bytes in → same checksum out", async () => {
    const input = await makeFixture(1500, 1500, { r: 50, g: 200, b: 100 });
    const a = await processImage(input);
    const b = await processImage(input);
    expect(a.checksum).toBe(b.checksum);
    expect(a.buffer.equals(b.buffer)).toBe(true);
  });

  it("center-crops portrait images to a square", async () => {
    const input = await makeFixture(1000, 3000, { r: 255, g: 0, b: 0 });
    const result = await processImage(input);
    expect(result.width).toBe(OUTPUT_SIZE);
    expect(result.height).toBe(OUTPUT_SIZE);
  });

  it("upscales images smaller than 2000×2000", async () => {
    const input = await makeFixture(500, 500, { r: 0, g: 128, b: 255 });
    const result = await processImage(input);
    expect(result.width).toBe(OUTPUT_SIZE);
    expect(result.height).toBe(OUTPUT_SIZE);
  });

  it("strips EXIF metadata from the output", async () => {
    const input = await sharp({
      create: { width: 800, height: 800, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .withExifMerge({
        IFD0: { Artist: "should-not-leak", Copyright: "secret" },
      })
      .jpeg()
      .toBuffer();

    const result = await processImage(input);
    const meta = await sharp(result.buffer).metadata();
    // After processing, EXIF should be gone (sharp reports undefined)
    expect(meta.exif).toBeUndefined();
  });

  it("rejects non-image input", async () => {
    const notAnImage = Buffer.from("this is plain text, not a PNG");
    await expect(processImage(notAnImage)).rejects.toThrow();
  });

  it("inspectImage returns dimensions for valid input", async () => {
    const input = await makeFixture(1234, 567, { r: 0, g: 0, b: 0 });
    const meta = await inspectImage(input);
    expect(meta).not.toBeNull();
    expect(meta!.width).toBe(1234);
    expect(meta!.height).toBe(567);
    expect(meta!.format).toBe("jpeg");
  });

  it("inspectImage returns null for invalid input", async () => {
    const meta = await inspectImage(Buffer.from("garbage"));
    expect(meta).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Export precheck
// ─────────────────────────────────────────────────────────────────────

describe("findProductsMissingApprovedImages", () => {
  const baseProduct = (
    id: string,
    name: string,
    images: Array<{ status: string | null }>,
  ) =>
    ({
      product: { id, name, skuPrefix: id },
      skus: [],
      images: images.map((img, i) => ({
        id: `${id}-img-${i}`,
        skuId: `${id}-sku`,
        filePath: "foo.jpg",
        width: null,
        height: null,
        status: img.status,
        isBest: false,
      })),
      tags: [],
      wholesalePrice: null,
      retailPrice: null,
      msrp: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

  it("returns empty array when every product has at least one approved image", () => {
    const products = [
      baseProduct("p1", "Alpha", [{ status: "approved" }, { status: "draft" }]),
      baseProduct("p2", "Beta", [{ status: "approved" }]),
    ];
    expect(findProductsMissingApprovedImages(products)).toEqual([]);
  });

  it("flags products with only draft/review/rejected images", () => {
    const products = [
      baseProduct("p1", "Alpha", [{ status: "draft" }, { status: "review" }]),
      baseProduct("p2", "Beta", [{ status: "approved" }]),
      baseProduct("p3", "Gamma", [{ status: "rejected" }]),
    ];
    const blockers = findProductsMissingApprovedImages(products);
    expect(blockers).toHaveLength(2);
    expect(blockers[0].productId).toBe("p1");
    expect(blockers[0].reason).toBe("no-approved-images");
    expect(blockers[0].totalCount).toBe(2);
    expect(blockers[0].approvedCount).toBe(0);
    expect(blockers[1].productId).toBe("p3");
  });

  it("reports no-images-at-all for products with zero images", () => {
    const products = [baseProduct("p1", "Alpha", [])];
    const blockers = findProductsMissingApprovedImages(products);
    expect(blockers).toHaveLength(1);
    expect(blockers[0].reason).toBe("no-images-at-all");
    expect(blockers[0].totalCount).toBe(0);
  });

  it("returns empty array for empty input", () => {
    expect(findProductsMissingApprovedImages([])).toEqual([]);
  });
});
