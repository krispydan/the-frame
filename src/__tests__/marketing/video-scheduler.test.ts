import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../setup";
import {
  composeAndInsertPost,
  loadComposerContext,
  topUpVideoQueue,
  generateUnscheduled,
} from "@/modules/marketing/lib/video/scheduler";

function seedLibrary(clipCount = 10) {
  const db = getTestDb();
  db.prepare(
    `INSERT INTO marketing_video_clip_categories (id, slug, name) VALUES ('cat-flat', 'flat_lay', 'Flat Lay')`,
  ).run();
  const insertClip = db.prepare(`
    INSERT INTO marketing_video_clips (id, file_name, checksum, raw_path, normalized_path, muted_path, duration_sec, category_id, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'cat-flat', 'ready')
  `);
  for (let i = 0; i < clipCount; i++) {
    insertClip.run(`clip-${i}`, `clip-${i}.mp4`, `sum-${i}`, `clips/raw/sum-${i}.mp4`,
      `clips/normalized/sum-${i}_v1.mp4`, `clips/normalized/sum-${i}_v1_muted.mp4`, 6);
  }
  db.prepare(`
    INSERT INTO marketing_video_recipes (id, name, pattern_json, audio_policy, weight)
    VALUES ('recipe-flat', 'Flat-lay compilation', '[{"categories":["flat_lay"],"min":3,"max":5}]', 'silent', 2)
  `).run();
}

describe("Video scheduler", () => {
  beforeEach(() => resetTestDb());

  it("composes, inserts and enqueues a render job", () => {
    seedLibrary();
    const ctx = loadComposerContext("2026-07-08");
    const { post, warning } = composeAndInsertPost(ctx, { date: "2026-07-08", slot: "morning" });
    expect(warning).toBeUndefined();
    expect(post).not.toBeNull();

    const db = getTestDb();
    const row = db.prepare(`SELECT * FROM marketing_video_posts WHERE id = ?`).get(post!.postId) as Record<string, unknown>;
    expect(row.status).toBe("queued");
    expect(row.scheduled_slot).toBe("morning");
    expect(JSON.parse(String(row.clip_ids)).length).toBeGreaterThanOrEqual(3);

    const job = db.prepare(`SELECT * FROM jobs WHERE type = 'marketing.video.render-post'`).get() as Record<string, unknown>;
    expect(job).toBeTruthy();
    expect(JSON.parse(String(job.input)).postId).toBe(post!.postId);
  });

  it("warns instead of throwing when the library is empty", () => {
    const ctx = loadComposerContext("2026-07-08");
    const { post, warning } = composeAndInsertPost(ctx, { date: "2026-07-08", slot: "morning" });
    expect(post).toBeNull();
    expect(warning).toMatch(/no ready/i);
  });

  it("top-up fills every empty slot and is idempotent", () => {
    seedLibrary(14);
    const first = topUpVideoQueue({ startDate: "2026-07-08", horizonDays: 2, slotsPerDay: 3 });
    expect(first.created).toBe(6);

    const second = topUpVideoQueue({ startDate: "2026-07-08", horizonDays: 2, slotsPerDay: 3 });
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(0); // slots already taken → not even attempted

    const db = getTestDb();
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM marketing_video_posts`).get() as { n: number }).n;
    expect(count).toBe(6);
  });

  it("every generated post has a unique permutation hash", () => {
    seedLibrary(14);
    const result = generateUnscheduled(8);
    expect(result.created).toBeGreaterThan(0);
    const db = getTestDb();
    const rows = db.prepare(`SELECT permutation_hash FROM marketing_video_posts`).all() as Array<{ permutation_hash: string }>;
    expect(new Set(rows.map((r) => r.permutation_hash)).size).toBe(rows.length);
  });

  it("reports exhaustion on a tiny library instead of looping forever", () => {
    seedLibrary(3); // exactly one 3-clip combination per order — collapses fast
    const result = generateUnscheduled(30);
    expect(result.created).toBeLessThan(30);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
