/**
 * Split review — the queue bookkeeping and the segment proposals.
 *
 * The proposal logic is what decides whether a reviewer nudges two
 * handles or redraws a whole timeline, so the fallbacks matter as much as
 * the happy path.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../setup";
import {
  evenWindows,
  reviewQueueStats,
  markReviewed,
  unmarkReviewed,
  LONG_CLIP_SEC,
  TARGET_MIN_SEC,
  TARGET_MAX_SEC,
  MIN_SEGMENT_SEC,
} from "@/modules/marketing/lib/video/split-review";

function seedClip(o: { id: string; sec: number | null; status?: string; reviewed?: boolean }) {
  getTestDb()
    .prepare(
      `INSERT INTO marketing_video_clips
         (id, file_name, checksum, raw_path, duration_sec, status, split_reviewed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      o.id,
      `${o.id}.mp4`,
      o.id.padEnd(16, "0").slice(0, 16),
      `clips/raw/${o.id}.mp4`,
      o.sec,
      o.status ?? "ready",
      o.reviewed ? "2026-08-01 10:00:00" : null,
    );
}

describe("evenWindows (the no-scene-changes fallback)", () => {
  it("splits a long continuous clip into target-length windows", () => {
    const w = evenWindows(20);
    expect(w.length).toBe(4);
    expect(w[0].startSec).toBe(0);
    expect(w[w.length - 1].endSec).toBe(20);
    // Contiguous, no gaps or overlaps.
    for (let i = 1; i < w.length; i++) expect(w[i].startSec).toBeCloseTo(w[i - 1].endSec, 1);
  });

  it("never proposes a window below the composer's minimum", () => {
    for (const d of [12, 17, 23, 31, 47]) {
      for (const seg of evenWindows(d)) {
        expect(seg.endSec - seg.startSec).toBeGreaterThanOrEqual(TARGET_MIN_SEC - 0.15);
      }
    }
  });

  it("keeps a barely-long clip whole rather than slicing it too fine", () => {
    // 5.5s / 5 = 1 window; splitting further would breach the minimum.
    const w = evenWindows(5.5);
    expect(w).toEqual([{ startSec: 0, endSec: 5.5 }]);
  });

  it("returns nothing for a zero/negative duration", () => {
    expect(evenWindows(0)).toEqual([]);
    expect(evenWindows(-3)).toEqual([]);
  });

  it("every proposed window clears the hard trim minimum", () => {
    for (const seg of evenWindows(33)) {
      expect(seg.endSec - seg.startSec).toBeGreaterThanOrEqual(MIN_SEGMENT_SEC);
    }
  });
});

describe("review queue", () => {
  beforeEach(() => resetTestDb());

  it("counts only ready clips at or over the threshold", () => {
    seedClip({ id: "long1", sec: 22 });
    seedClip({ id: "long2", sec: 11 });
    seedClip({ id: "short", sec: 4 });             // under the bar
    seedClip({ id: "unknown", sec: null });         // still processing
    seedClip({ id: "pending", sec: 30, status: "uploaded" }); // not ready

    const s = reviewQueueStats(LONG_CLIP_SEC);
    expect(s.pending).toBe(2);
    expect(s.reviewed).toBe(0);
    expect(s.longestSec).toBe(22);
    expect(s.pendingSec).toBe(33);
  });

  it("moves a clip out of pending once reviewed", () => {
    seedClip({ id: "a", sec: 15 });
    seedClip({ id: "b", sec: 25 });
    expect(markReviewed(["a"])).toBe(1);

    const s = reviewQueueStats();
    expect(s.pending).toBe(1);
    expect(s.reviewed).toBe(1);
    expect(s.pendingSec).toBe(25);
  });

  it("is idempotent — re-reviewing changes nothing", () => {
    seedClip({ id: "a", sec: 15 });
    expect(markReviewed(["a"])).toBe(1);
    expect(markReviewed(["a"])).toBe(0);
    expect(reviewQueueStats().reviewed).toBe(1);
  });

  it("can put a clip back in the queue", () => {
    seedClip({ id: "a", sec: 15, reviewed: true });
    expect(reviewQueueStats().pending).toBe(0);
    unmarkReviewed("a");
    expect(reviewQueueStats().pending).toBe(1);
  });

  it("respects a custom threshold", () => {
    seedClip({ id: "a", sec: 7 });
    seedClip({ id: "b", sec: 12 });
    expect(reviewQueueStats(10).pending).toBe(1);
    expect(reviewQueueStats(6).pending).toBe(2);
  });

  it("marking nothing is a no-op", () => {
    expect(markReviewed([])).toBe(0);
  });
});

describe("target lengths line up with the composer", () => {
  it("proposals aim at the 3-5s band", () => {
    expect(TARGET_MIN_SEC).toBe(3);
    expect(TARGET_MAX_SEC).toBe(5);
    expect(LONG_CLIP_SEC).toBeGreaterThan(TARGET_MAX_SEC);
  });
});
