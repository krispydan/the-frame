/**
 * Clip transforms — REAL ffmpeg end-to-end. Generates a test video and
 * runs each transform (reframe / punch / speed) through the production
 * path (transform → content-address → normalize), asserting a new READY
 * clip with the parent's tags carried over and the original untouched.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFile } from "child_process";
import { mkdtempSync } from "fs";
import { mkdir } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { getTestDb, resetTestDb } from "../setup";
import { transformClip } from "@/modules/marketing/lib/video/transform";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

function sh(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG, args, { timeout: 60_000 }, (err) => (err ? reject(err) : resolve()));
  });
}

let videosRoot: string;

beforeAll(async () => {
  videosRoot = mkdtempSync(path.join(tmpdir(), "xform-test-"));
  process.env.VIDEOS_PATH = videosRoot;
  await mkdir(path.join(videosRoot, "clips/normalized"), { recursive: true });
  await sh([
    "-y",
    "-f", "lavfi", "-i", "testsrc2=size=270x480:rate=30:duration=4",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest",
    path.join(videosRoot, "clips/normalized/parent_v1.mp4"),
  ]);
}, 60_000);

function seedParent() {
  const d = getTestDb();
  d.prepare(
    `INSERT INTO marketing_video_clips (id, file_name, checksum, raw_path, normalized_path, duration_sec, width, height, status)
     VALUES ('parent', 'shoot_take1.mp4', 'parentck', 'clips/raw/parent.mp4', 'clips/normalized/parent_v1.mp4', 4.0, 270, 480, 'ready')`,
  ).run();
  d.prepare(`INSERT INTO catalog_products (id, name) VALUES ('p1', 'Solstice')`).run();
  d.prepare(`INSERT INTO catalog_skus (id, product_id, sku) VALUES ('s1', 'p1', 'JX1006-BLK')`).run();
  d.prepare(
    `INSERT INTO marketing_video_clip_products (id, clip_id, sku_id) VALUES ('t1', 'parent', 's1')`,
  ).run();
}

describe("transformClip (real ffmpeg)", () => {
  it("reframe: crops tighter into a new ready clip, tags carried, dedupes", async () => {
    resetTestDb();
    seedParent();
    const { clip, deduped } = await transformClip("parent", { kind: "reframe", zoom: 1.5, x: 0.5, y: 0.4 });
    expect(deduped).toBe(false);
    expect(clip.id).not.toBe("parent");
    expect(clip.status).toBe("ready");
    expect(clip.fileName).toContain("__reframe_1.50");
    expect(clip.normalizedPath).toBeTruthy();
    expect(clip.posterPath).toBeTruthy();
    // roughly the same length as the source (crop doesn't change duration)
    expect(clip.durationSec ?? 0).toBeGreaterThan(3.5);

    const tags = getTestDb()
      .prepare(`SELECT sku_id AS skuId FROM marketing_video_clip_products WHERE clip_id = ?`)
      .all(clip.id) as Array<{ skuId: string }>;
    expect(tags.map((t) => t.skuId)).toEqual(["s1"]);

    const again = await transformClip("parent", { kind: "reframe", zoom: 1.5, x: 0.5, y: 0.4 });
    expect(again.deduped).toBe(true);
    expect(again.clip.id).toBe(clip.id);

    // Parent untouched.
    const parent = getTestDb().prepare(`SELECT status FROM marketing_video_clips WHERE id = 'parent'`).get() as { status: string };
    expect(parent.status).toBe("ready");
  }, 120_000);

  it("speed: slow-mo lengthens the clip", async () => {
    resetTestDb();
    seedParent();
    const { clip } = await transformClip("parent", { kind: "speed", factor: 0.5 });
    expect(clip.status).toBe("ready");
    expect(clip.fileName).toContain("__speed_0.50");
    // 4s at half speed ≈ 8s
    expect(clip.durationSec ?? 0).toBeGreaterThan(7);
  }, 120_000);

  it("punch: Ken Burns push-in keeps the clip length", async () => {
    resetTestDb();
    seedParent();
    const { clip } = await transformClip("parent", { kind: "punch" });
    expect(clip.status).toBe("ready");
    expect(clip.fileName).toContain("__punch");
    expect(clip.durationSec ?? 0).toBeGreaterThan(3.5);
  }, 120_000);

  it("rejects invalid params + missing clip", async () => {
    resetTestDb();
    seedParent();
    await expect(transformClip("parent", { kind: "reframe", zoom: 1, x: 0.5, y: 0.5 })).rejects.toThrow(/greater than 1/);
    await expect(transformClip("parent", { kind: "speed", factor: 0 })).rejects.toThrow(/positive/);
    await expect(transformClip("missing", { kind: "punch" })).rejects.toThrow(/not found/i);
  });
});
