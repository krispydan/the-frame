/**
 * Product videos — deterministic per-product builds. Selection is pure
 * SQL + sort, so it's unit-testable without ffmpeg; the concat itself is
 * exercised by the real-ffmpeg build test at the bottom.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { execFile } from "child_process";
import { mkdtempSync } from "fs";
import { mkdir } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { getTestDb, resetTestDb } from "../setup";
import {
  selectClipsForProduct,
  buildProductVideo,
  listProductVideos,
  MAX_CLIPS,
} from "@/modules/marketing/lib/video/product-video";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
function sh(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => execFile(FFMPEG, args, { timeout: 60_000 }, (e) => (e ? reject(e) : resolve())));
}

let videosRoot: string;

beforeAll(async () => {
  videosRoot = mkdtempSync(path.join(tmpdir(), "pv-test-"));
  process.env.VIDEOS_PATH = videosRoot;
  await mkdir(path.join(videosRoot, "clips/muted"), { recursive: true });
  for (const n of ["a", "b"]) {
    await sh([
      "-y", "-f", "lavfi", "-i", `testsrc2=size=270x480:rate=30:duration=2`,
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      "-video_track_timescale", "15360", "-an",
      path.join(videosRoot, `clips/muted/${n}.mp4`),
    ]);
  }
}, 90_000);

function seed() {
  const d = getTestDb();
  d.prepare(`INSERT INTO marketing_video_clip_categories (id, slug, name, is_product_shot, sort_order) VALUES ('c-show','product-showcase','showcase',1,10)`).run();
  d.prepare(`INSERT INTO marketing_video_clip_categories (id, slug, name, is_product_shot, sort_order) VALUES ('c-detail','detail','Detail',1,20)`).run();
  d.prepare(`INSERT INTO marketing_video_clip_categories (id, slug, name, is_product_shot, sort_order) VALUES ('c-box','unboxing','unboxing',0,30)`).run();

  d.prepare(`INSERT INTO catalog_products (id, name) VALUES ('p1','Cannon')`).run();
  d.prepare(`INSERT INTO catalog_products (id, name) VALUES ('p2','Solstice')`).run();
  d.prepare(`INSERT INTO catalog_skus (id, product_id, sku) VALUES ('s1','p1','JX-CAN-BLK')`).run();
  d.prepare(`INSERT INTO catalog_skus (id, product_id, sku) VALUES ('s1b','p1','JX-CAN-TOR')`).run();
  d.prepare(`INSERT INTO catalog_skus (id, product_id, sku) VALUES ('s2','p2','JX-SOL-BLK')`).run();
}

function addClip(id: string, cat: string, dur: number, skus: string[], muted = "clips/muted/a.mp4") {
  const d = getTestDb();
  d.prepare(
    `INSERT INTO marketing_video_clips (id, file_name, checksum, raw_path, muted_path, normalized_path, duration_sec, status, category_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?)`,
  ).run(id, `${id}.mp4`, id, `raw/${id}.mp4`, muted, muted, dur, cat);
  for (const s of skus) {
    d.prepare(`INSERT INTO marketing_video_clip_products (id, clip_id, sku_id) VALUES (?, ?, ?)`).run(`t-${id}-${s}`, id, s);
  }
}

describe("selectClipsForProduct", () => {
  beforeEach(() => {
    resetTestDb();
    listProductVideos(); // lazily creates the table
    getTestDb().exec("DELETE FROM marketing_product_videos");
    seed();
  });

  it("puts product shots first, in the operator's category order", () => {
    addClip("box", "c-box", 5, ["s1"]);
    addClip("det", "c-detail", 5, ["s1"]);
    addClip("show", "c-show", 5, ["s1"]);
    const picked = selectClipsForProduct("p1").map((c) => c.id);
    expect(picked).toEqual(["show", "det", "box"]);
  });

  it("is deterministic — repeated calls give the identical edit", () => {
    for (const n of ["a", "b", "c", "d"]) addClip(n, "c-show", 4, ["s1"]);
    const runs = Array.from({ length: 5 }, () => selectClipsForProduct("p1").map((c) => c.id));
    for (const r of runs) expect(r).toEqual(runs[0]);
  });

  it("only uses this product's clips, and never one that also shows another product", () => {
    addClip("mine", "c-show", 5, ["s1"]);
    addClip("theirs", "c-show", 5, ["s2"]);
    addClip("shared", "c-show", 5, ["s1", "s2"]); // appears in both products
    const picked = selectClipsForProduct("p1").map((c) => c.id);
    expect(picked).toEqual(["mine"]);
  });

  it("counts a clip once when tagged to two colorways of the same product", () => {
    addClip("dual", "c-show", 5, ["s1", "s1b"]);
    expect(selectClipsForProduct("p1").map((c) => c.id)).toEqual(["dual"]);
  });

  it("varies shot types instead of stacking one (the 'Deco' case)", () => {
    const d = getTestDb();
    d.prepare(`INSERT INTO marketing_video_clip_categories (id, slug, name, is_product_shot, sort_order) VALUES ('c-life','lifestyle','Lifestyle',1,5)`).run();
    d.prepare(`INSERT INTO marketing_video_clip_categories (id, slug, name, is_product_shot, sort_order) VALUES ('c-model','on_model','On Model',1,15)`).run();
    // Deco's real mix: lots of lifestyle, some on-model, a couple flat-lay.
    for (let i = 0; i < 11; i++) addClip(`life${i}`, "c-life", 3, ["s1"]);
    for (let i = 0; i < 7; i++) addClip(`model${i}`, "c-model", 3, ["s1"]);
    for (let i = 0; i < 2; i++) addClip(`flat${i}`, "c-show", 3, ["s1"]);
    addClip("box0", "c-box", 3, ["s1"]);

    const picked = selectClipsForProduct("p1");
    const cats = picked.map((c) => c.categorySlug);
    // At least three different shot types in a 5-clip cut…
    expect(new Set(cats).size).toBeGreaterThanOrEqual(3);
    // …and no type used more than twice.
    for (const slug of new Set(cats)) {
      expect(cats.filter((c) => c === slug).length).toBeLessThanOrEqual(2);
    }
    // Never the same type twice in a row.
    for (let i = 1; i < cats.length; i++) expect(cats[i]).not.toBe(cats[i - 1]);
  });

  it("caps the edit length", () => {
    for (let i = 0; i < 10; i++) addClip(`c${i}`, "c-show", 4, ["s1"]);
    const picked = selectClipsForProduct("p1");
    expect(picked.length).toBeLessThanOrEqual(MAX_CLIPS);
    expect(picked.reduce((s, c) => s + c.durationSec, 0)).toBeLessThanOrEqual(20);
  });
});

describe("buildProductVideo", () => {
  beforeEach(() => {
    resetTestDb();
    listProductVideos(); // lazily creates the table
    getTestDb().exec("DELETE FROM marketing_product_videos");
    seed();
  });

  it("refuses when nothing shows the product", async () => {
    addClip("box", "c-box", 4, ["s1"]);
    const res = await buildProductVideo("p1");
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("no product shot");
    const row = listProductVideos().find((r) => r.productId === "p1")!;
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/product shot/i);
  });

  it("refuses when the product has no clips at all", async () => {
    const res = await buildProductVideo("p1");
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("no clips");
  });

  it("builds a silent master and is re-runnable in place (real ffmpeg)", async () => {
    addClip("show", "c-show", 2, ["s1"], "clips/muted/a.mp4");
    addClip("det", "c-detail", 2, ["s1"], "clips/muted/b.mp4");

    const res = await buildProductVideo("p1");
    expect(res.ok).toBe(true);
    expect(res.clipIds).toEqual(["show", "det"]);

    const row = listProductVideos().find((r) => r.productId === "p1")!;
    expect(row.status).toBe("ready");
    expect(row.filePath).toBe("products/p1.mp4");
    expect(row.posterPath).toBe("products/p1.jpg");
    expect(row.durationSec ?? 0).toBeGreaterThan(3);
    expect(row.videoUrl).toContain("?v="); // cache-busted, path is deterministic

    // Rebuild → same single row, same path (replaced, not duplicated).
    const again = await buildProductVideo("p1");
    expect(again.ok).toBe(true);
    expect(listProductVideos().filter((r) => r.productId === "p1")).toHaveLength(1);
  }, 120_000);
});
