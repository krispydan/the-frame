/**
 * Clip trimming — REAL ffmpeg end-to-end: generates a test video, trims
 * a sub-range, and expects a new READY clip of the right length with the
 * parent's tags carried over. Runs the same code path production uses
 * (trim → content-address → normalize).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFile } from "child_process";
import { mkdtempSync } from "fs";
import { mkdir } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { getTestDb, resetTestDb } from "../setup";
import { trimClip, MIN_TRIM_SEC } from "@/modules/marketing/lib/video/trim";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

function sh(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG, args, { timeout: 60_000 }, (err) => (err ? reject(err) : resolve()));
  });
}

let videosRoot: string;

beforeAll(async () => {
  videosRoot = mkdtempSync(path.join(tmpdir(), "trim-test-"));
  process.env.VIDEOS_PATH = videosRoot;
  await mkdir(path.join(videosRoot, "clips/normalized"), { recursive: true });
  // 6s test video with audio — small but real.
  await sh([
    "-y",
    "-f", "lavfi", "-i", "testsrc=size=270x480:rate=30:duration=6",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest",
    path.join(videosRoot, "clips/normalized/parent_v1.mp4"),
  ]);
}, 60_000);

function seedParent() {
  const d = getTestDb();
  d.prepare(
    `INSERT INTO marketing_video_clips (id, file_name, checksum, raw_path, normalized_path, duration_sec, status)
     VALUES ('parent', 'shoot_take1.mp4', 'parentck', 'clips/raw/parent.mp4', 'clips/normalized/parent_v1.mp4', 6.0, 'ready')`,
  ).run();
  d.prepare(`INSERT INTO catalog_products (id, name) VALUES ('p1', 'Solstice')`).run();
  d.prepare(`INSERT INTO catalog_skus (id, product_id, sku) VALUES ('s1', 'p1', 'JX1006-BLK')`).run();
  d.prepare(
    `INSERT INTO marketing_video_clip_products (id, clip_id, sku_id) VALUES ('t1', 'parent', 's1')`,
  ).run();
}

describe("trimClip (real ffmpeg)", () => {
  it("cuts a sub-range into a new ready clip with tags carried over", async () => {
    resetTestDb();
    seedParent();
    const { clip, deduped } = await trimClip("parent", 1.0, 3.5);
    expect(deduped).toBe(false);
    expect(clip.id).not.toBe("parent");
    expect(clip.status).toBe("ready");
    expect(clip.fileName).toContain("__trim_1.0-3.5");
    expect(clip.durationSec ?? 0).toBeGreaterThan(2.2);
    expect(clip.durationSec ?? 0).toBeLessThan(2.8);
    expect(clip.normalizedPath).toBeTruthy();
    expect(clip.posterPath).toBeTruthy();

    // Parent untouched; tags copied.
    const parent = getTestDb().prepare(`SELECT status FROM marketing_video_clips WHERE id = 'parent'`).get() as { status: string };
    expect(parent.status).toBe("ready");
    const tags = getTestDb()
      .prepare(`SELECT sku_id AS skuId FROM marketing_video_clip_products WHERE clip_id = ?`)
      .all(clip.id) as Array<{ skuId: string }>;
    expect(tags.map((t) => t.skuId)).toEqual(["s1"]);

    // Same trim again → deduped to the existing clip.
    const again = await trimClip("parent", 1.0, 3.5);
    expect(again.deduped).toBe(true);
    expect(again.clip.id).toBe(clip.id);
  }, 120_000);

  it("rejects invalid ranges", async () => {
    resetTestDb();
    seedParent();
    await expect(trimClip("parent", 3, 2)).rejects.toThrow(/after startSec/);
    await expect(trimClip("parent", 0, MIN_TRIM_SEC - 0.5)).rejects.toThrow(/at least/);
    await expect(trimClip("parent", 1, 9)).rejects.toThrow(/past the clip/);
    await expect(trimClip("missing", 0, 2)).rejects.toThrow(/not found/i);
  });
});
