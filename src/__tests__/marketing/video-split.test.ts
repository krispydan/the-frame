import { describe, it, expect } from "vitest";
import { planWindows } from "@/modules/marketing/lib/video/split";

describe("Auto-clipper window planner", () => {
  it("carves a single-scene video into contiguous 3-5s windows", () => {
    const windows = planWindows([], 20);
    expect(windows.length).toBeGreaterThanOrEqual(4);
    for (const w of windows) {
      expect(w.duration).toBeGreaterThanOrEqual(3);
      expect(w.duration).toBeLessThanOrEqual(5.01);
    }
    // contiguous: each window starts where the previous ended
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i].start).toBeCloseTo(windows[i - 1].start + windows[i - 1].duration, 5);
    }
    // full coverage: last window reaches (close to) the end
    const last = windows[windows.length - 1];
    expect(last.start + last.duration).toBeGreaterThan(20 - 3);
  });

  it("never crosses a scene cut", () => {
    const cuts = [7.5, 14.2];
    const windows = planWindows(cuts, 21);
    for (const w of windows) {
      for (const cut of cuts) {
        const crosses = w.start < cut && w.start + w.duration > cut + 0.001;
        expect(crosses).toBe(false);
      }
    }
  });

  it("skips scenes shorter than the minimum clip length", () => {
    // scene 2 is only 1.5s (8 → 9.5) — nothing should start inside it
    const windows = planWindows([8, 9.5], 20);
    expect(windows.some((w) => w.start >= 8 && w.start < 9.5)).toBe(false);
  });

  it("trims scene heads to dodge transition frames when there's room", () => {
    const windows = planWindows([10], 20);
    const secondSceneFirst = windows.find((w) => w.start >= 10);
    expect(secondSceneFirst).toBeDefined();
    expect(secondSceneFirst!.start).toBeGreaterThan(10); // headTrim applied
  });

  it("absorbs short tails instead of stranding sub-minimum leftovers", () => {
    // 9.5s scene: naive 4s+4s leaves 1.5s stranded — planner should
    // instead produce windows that cover it (e.g. 4 + 5.5→capped)
    const windows = planWindows([], 9.5);
    const covered = windows.reduce((sum, w) => sum + w.duration, 0);
    expect(covered).toBeGreaterThan(9.5 - 3); // no >minLen gap left
    for (const w of windows) expect(w.duration).toBeGreaterThanOrEqual(3);
  });

  it("respects maxClips", () => {
    expect(planWindows([], 600, { maxClips: 10 })).toHaveLength(10);
  });

  it("is deterministic — same input, same cuts", () => {
    const a = planWindows([5, 12, 33.3], 60);
    const b = planWindows([5, 12, 33.3], 60);
    expect(a).toEqual(b);
  });

  it("returns [] for degenerate inputs", () => {
    expect(planWindows([], 0)).toEqual([]);
    expect(planWindows([], 2)).toEqual([]); // shorter than one clip
    expect(planWindows([], -5)).toEqual([]);
  });

  it("honors custom min/max lengths", () => {
    const windows = planWindows([], 30, { minLen: 4, maxLen: 6 });
    for (const w of windows) {
      expect(w.duration).toBeGreaterThanOrEqual(4);
      expect(w.duration).toBeLessThanOrEqual(6.01);
    }
  });
});
