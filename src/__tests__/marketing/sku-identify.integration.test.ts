/**
 * End-to-end test for filename-based SKU identification against a real
 * (in-memory) catalog: suggestion vs auto-apply, tag writing for clips
 * and images, idempotence, and the no-signal case staying in the manual
 * queue. No AI, no network — identification is pure string + SQL work.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../setup";
import {
  identifyMedia,
  confirmMediaProducts,
  saveMediaNotes,
} from "@/modules/marketing/lib/video/sku-match";

function seedCatalog() {
  const db = getTestDb();
  const prod = db.prepare(`INSERT INTO catalog_products (id, name) VALUES (?, ?)`);
  const sku = db.prepare(`INSERT INTO catalog_skus (id, product_id, sku, color_name) VALUES (?, ?, ?, ?)`);
  prod.run("p-windsor", "Windsor");
  sku.run("s-JX1005-BLK", "p-windsor", "JX1005-BLK", "Black");
  sku.run("s-JX1005-OLV", "p-windsor", "JX1005-OLV", "Olive");
  prod.run("p-solstice", "Solstice");
  sku.run("s-JX1006-BRW", "p-solstice", "JX1006-BRW", "Brown");
}

function seedClip(id: string, fileName: string) {
  getTestDb()
    .prepare(
      `INSERT INTO marketing_video_clips (id, file_name, checksum, raw_path, duration_sec, status)
       VALUES (?, ?, ?, ?, 5, 'ready')`,
    )
    .run(id, fileName, `sum-${id}`, `clips/raw/${id}.mp4`);
}

function clipSkus(clipId: string): string[] {
  return (getTestDb()
    .prepare(`SELECT sku_id AS s FROM marketing_video_clip_products WHERE clip_id = ? ORDER BY sku_id`)
    .all(clipId) as Array<{ s: string }>).map((r) => r.s);
}

function matchRow(mediaId: string): { status: string } | undefined {
  return getTestDb()
    .prepare(`SELECT status FROM marketing_media_matches WHERE media_id = ?`)
    .get(mediaId) as { status: string } | undefined;
}

describe("filename SKU identification", () => {
  beforeEach(() => {
    resetTestDb();
    seedCatalog();
  });

  it("auto-applies a strong filename match (tags written, confirmed)", () => {
    seedClip("clip-a", "05_21_26_studio_Windsor_02__10.mp4");
    const r = identifyMedia("clip", "clip-a", { apply: true });
    expect(r).toMatchObject({ status: "confirmed", applied: true });
    // Product-level tagging: every Windsor SKU.
    expect(clipSkus("clip-a")).toEqual(["s-JX1005-BLK", "s-JX1005-OLV"]);
    expect(matchRow("clip-a")?.status).toBe("confirmed");
  });

  it("stores a suggestion (no tags) when apply is off", () => {
    seedClip("clip-b", "Solstice_take2.mp4");
    const r = identifyMedia("clip", "clip-b", { apply: false });
    expect(r).toMatchObject({ status: "suggested", applied: false });
    expect(r.candidates[0].productId).toBe("p-solstice");
    expect(clipSkus("clip-b")).toEqual([]); // review still required
    expect(matchRow("clip-b")?.status).toBe("suggested");
  });

  it("leaves opaque filenames alone — stays in the manual queue", () => {
    seedClip("clip-c", "ac58f307-4068a1529688cdd0_v1.mp4");
    const r = identifyMedia("clip", "clip-c", { apply: true });
    expect(r).toMatchObject({ status: "none", applied: false });
    expect(matchRow("clip-c")).toBeUndefined(); // no row → still "not identified"
    expect(clipSkus("clip-c")).toEqual([]);
  });

  it("never overwrites a confirmed decision", () => {
    seedClip("clip-d", "Windsor_01.mp4");
    // Human confirms Solstice (overriding what the filename says).
    confirmMediaProducts("clip", "clip-d", ["p-solstice"]);
    expect(clipSkus("clip-d")).toEqual(["s-JX1006-BRW"]);
    // Re-running identify must not clobber the human's choice.
    const r = identifyMedia("clip", "clip-d", { apply: true });
    expect(r.status).toBe("confirmed");
    expect(r.applied).toBe(false);
    expect(clipSkus("clip-d")).toEqual(["s-JX1006-BRW"]);
  });

  it("reassigns a catalog image's SKU on confirm (photoshoot flow)", () => {
    const db = getTestDb();
    db.prepare(`INSERT INTO catalog_images (id, sku_id, file_path) VALUES ('img-1', 's-JX1005-BLK', 'raw/product_windsor_007.jpg')`).run();
    confirmMediaProducts("image", "img-1", ["p-solstice"]);
    const row = db.prepare(`SELECT sku_id AS s FROM catalog_images WHERE id = 'img-1'`).get() as { s: string };
    expect(row.s).toBe("s-JX1006-BRW");
    expect(matchRow("img-1")?.status).toBe("confirmed");
  });

  it("saves reviewer notes on clips and images (empty clears, undefined leaves)", () => {
    const db = getTestDb();
    seedClip("clip-n", "whatever.mp4");
    db.prepare(`INSERT INTO catalog_images (id, sku_id, file_path) VALUES ('img-n', 's-JX1005-BLK', 'x.jpg')`).run();

    saveMediaNotes("clip", "clip-n", "model spins, close-up on temple logo");
    saveMediaNotes("image", "img-n", "beach lifestyle, two products in frame");
    expect((db.prepare(`SELECT notes FROM marketing_video_clips WHERE id='clip-n'`).get() as { notes: string }).notes)
      .toBe("model spins, close-up on temple logo");
    expect((db.prepare(`SELECT notes FROM catalog_images WHERE id='img-n'`).get() as { notes: string }).notes)
      .toBe("beach lifestyle, two products in frame");

    saveMediaNotes("clip", "clip-n", undefined); // untouched
    expect((db.prepare(`SELECT notes FROM marketing_video_clips WHERE id='clip-n'`).get() as { notes: string }).notes)
      .toBe("model spins, close-up on temple logo");
    saveMediaNotes("clip", "clip-n", ""); // clears
    expect((db.prepare(`SELECT notes FROM marketing_video_clips WHERE id='clip-n'`).get() as { notes: string | null }).notes)
      .toBeNull();
  });

  it("identifies an image from its file path (lifestyle shoot naming)", () => {
    const db = getTestDb();
    db.prepare(`INSERT INTO catalog_images (id, sku_id, file_path) VALUES ('img-2', 's-JX1005-BLK', 'shoots/lifestyle_solstice_beach_01.jpg')`).run();
    const r = identifyMedia("image", "img-2", { apply: false });
    expect(r.status).toBe("suggested");
    expect(r.candidates[0].productId).toBe("p-solstice");
  });
});
