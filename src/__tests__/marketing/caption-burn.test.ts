/**
 * Hook burn-in — wrap logic (pure) + a REAL ffmpeg end-to-end that bakes
 * a hook onto a rendered post and asserts a derived burned file is
 * produced, is idempotent, and clears when the hook/toggle goes away.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFile } from "child_process";
import { mkdtempSync } from "fs";
import { mkdir } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { getTestDb, resetTestDb } from "../setup";
import { wrapHook, burnHookIntoRender } from "@/modules/marketing/lib/video/caption-burn";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
function sh(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => execFile(FFMPEG, args, { timeout: 60_000 }, (e) => (e ? reject(e) : resolve())));
}

describe("wrapHook", () => {
  it("wraps to <= maxLines and ellipsises overflow", () => {
    expect(wrapHook("Short one")).toBe("Short one");
    const two = wrapHook("This shape has no business being $25");
    expect(two.split("\n").length).toBeLessThanOrEqual(3);
    const long = wrapHook("word ".repeat(40).trim());
    expect(long.split("\n").length).toBe(3);
    expect(long.endsWith("…")).toBe(true);
  });
});

let videosRoot: string;
beforeAll(async () => {
  videosRoot = mkdtempSync(path.join(tmpdir(), "burn-test-"));
  process.env.VIDEOS_PATH = videosRoot;
  await mkdir(path.join(videosRoot, "renders/2026-07"), { recursive: true });
  await sh([
    "-y",
    "-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=30:duration=3",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest",
    path.join(videosRoot, "renders/2026-07/post1.mp4"),
  ]);
}, 60_000);

function seedPost(hook: string | null, burnHook = 1) {
  const d = getTestDb();
  const instructions = hook ? JSON.stringify({ hook }) : JSON.stringify({});
  d.prepare(
    `INSERT INTO marketing_video_posts (id, permutation_hash, clip_ids, status, file_path, instructions, burn_hook)
     VALUES ('post1', 'h1', '["c1"]', 'ready', 'renders/2026-07/post1.mp4', ?, ?)`,
  ).run(instructions, burnHook);
}

describe("burnHookIntoRender (real ffmpeg)", () => {
  it("bakes the hook into a derived file, idempotently", async () => {
    resetTestDb();
    seedPost("This shape has no business being $25");

    const r1 = await burnHookIntoRender("post1");
    expect(r1.burned).toBe(true);
    expect(r1.burnedPath).toMatch(/_hook\.mp4$/);

    const row = getTestDb().prepare(`SELECT file_path, burned_path, burned_hook FROM marketing_video_posts WHERE id='post1'`).get() as {
      file_path: string; burned_path: string; burned_hook: string;
    };
    expect(row.burned_path).toBe(r1.burnedPath);
    expect(row.file_path).toBe("renders/2026-07/post1.mp4"); // clean render untouched
    expect(row.burned_hook).toContain("This shape");

    // Same hook again → idempotent skip.
    const r2 = await burnHookIntoRender("post1");
    expect(r2.skipped).toBe(true);
  }, 120_000);

  it("clears the burned pointer when burn is disabled or no hook", async () => {
    resetTestDb();
    seedPost("Some hook line", 0); // burn disabled
    const r = await burnHookIntoRender("post1");
    expect(r.burned).toBe(false);
    const row = getTestDb().prepare(`SELECT burned_path FROM marketing_video_posts WHERE id='post1'`).get() as { burned_path: string | null };
    expect(row.burned_path).toBeNull();
  }, 60_000);
});
