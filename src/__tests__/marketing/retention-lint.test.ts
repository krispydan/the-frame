/**
 * Retention linter — deterministic checks that flag watch-time killers.
 */
import { describe, it, expect } from "vitest";
import { lintRetention } from "@/modules/marketing/lib/video/retention-lint";

describe("lintRetention", () => {
  it("flags a missing hook", () => {
    const codes = lintRetention({ hook: "" }).map((i) => i.code);
    expect(codes).toContain("no-hook");
  });

  it("flags an over-long hook", () => {
    const codes = lintRetention({ hook: "x".repeat(80), onScreenTextCount: 1 }).map((i) => i.code);
    expect(codes).toContain("hook-too-long");
  });

  it("flags a static clip that runs past the cut window", () => {
    const codes = lintRetention({ hook: "Nice hook", onScreenTextCount: 1, clipDurations: [2, 6, 3] }).map((i) => i.code);
    expect(codes).toContain("static-clip");
  });

  it("is clean for a tight, hooked, captioned video", () => {
    const issues = lintRetention({
      hook: "This shape has no business being $25",
      onScreenTextCount: 2,
      clipDurations: [2, 3, 2.5],
      totalDurationSec: 18,
      captionLength: 90,
    });
    expect(issues.filter((i) => i.level === "warn")).toHaveLength(0);
  });
});
