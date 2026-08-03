/**
 * Splitter geometry — the pure functions behind the drag.
 *
 * These are what stop a drag from producing a segment the cut would
 * reject, and what makes snapping land on a shot boundary instead of
 * near one.
 */
import { describe, it, expect } from "vitest";
import {
  clampSegment,
  snapTo,
  segmentTone,
  MIN_SEGMENT_SEC,
  TARGET_MAX_SEC,
} from "@/modules/marketing/components/videos/clip-splitter";
import { tileCountFor } from "@/modules/marketing/lib/video/filmstrip";
import { MIN_SEGMENT_SEC as SERVER_MIN } from "@/modules/marketing/lib/video/split-review";

describe("clampSegment", () => {
  it("keeps a segment inside the clip", () => {
    expect(clampSegment({ startSec: -5, endSec: 4 }, 20)).toEqual({ startSec: 0, endSec: 4 });
    expect(clampSegment({ startSec: 16, endSec: 99 }, 20)).toEqual({ startSec: 16, endSec: 20 });
  });

  it("never returns a segment the cut would reject as too short", () => {
    const s = clampSegment({ startSec: 5, endSec: 5.05 }, 20);
    expect(s.endSec - s.startSec).toBeGreaterThanOrEqual(MIN_SEGMENT_SEC - 1e-9);
  });

  it("pins a drag past the end back inside the clip", () => {
    const s = clampSegment({ startSec: 25, endSec: 30 }, 20);
    expect(s.startSec).toBeLessThanOrEqual(20 - MIN_SEGMENT_SEC);
    expect(s.endSec).toBeLessThanOrEqual(20);
  });

  it("rounds to a tenth so the numbers match what's displayed", () => {
    const s = clampSegment({ startSec: 1.23456, endSec: 6.98765 }, 20);
    expect(s).toEqual({ startSec: 1.2, endSec: 7 });
  });
});

describe("snapTo", () => {
  const cuts = [3.0, 8.5, 14.2];

  it("snaps to a nearby scene cut", () => {
    expect(snapTo(3.1, cuts)).toBe(3.0);
    expect(snapTo(8.4, cuts)).toBe(8.5);
  });

  it("leaves a value alone when no cut is close", () => {
    expect(snapTo(6.0, cuts)).toBe(6.0);
    expect(snapTo(3.9, cuts)).toBe(3.9);
  });

  it("picks the nearest of two candidates", () => {
    expect(snapTo(3.2, [3.0, 3.35])).toBe(3.35);
  });

  it("can be turned off (alt-drag) and handles no cuts", () => {
    expect(snapTo(3.05, cuts, false)).toBe(3.05);
    expect(snapTo(3.05, [])).toBe(3.05);
  });
});

describe("segmentTone", () => {
  it("flags a segment too short to cut", () => {
    expect(segmentTone(0.5)).toBe("bad");
  });

  it("accepts the composer's sweet spot", () => {
    expect(segmentTone(3)).toBe("good");
    expect(segmentTone(4.5)).toBe("good");
  });

  it("warns past the length the composer likes for one beat", () => {
    expect(segmentTone(TARGET_MAX_SEC + 2)).toBe("warn");
  });
});

describe("client and server agree", () => {
  it("uses the same minimum segment length on both sides", () => {
    // The UI blocks it, the route rejects it, and trim.ts throws on it.
    // A drift here would let the reviewer draw cuts that silently fail.
    expect(MIN_SEGMENT_SEC).toBe(SERVER_MIN);
  });
});

describe("tileCountFor", () => {
  it("scales the filmstrip to the clip's length", () => {
    expect(tileCountFor(12)).toBeLessThan(tileCountFor(40));
  });

  it("stays within sane bounds for very short and very long clips", () => {
    expect(tileCountFor(2)).toBeGreaterThanOrEqual(6);
    expect(tileCountFor(600)).toBeLessThanOrEqual(24);
  });
});
