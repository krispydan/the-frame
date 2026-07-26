/**
 * Video strategy backbone — the audience profile + content pillars must
 * be injected into EVERY video copy generation. This asserts the block
 * builder pulls both docs (from the live store, falling back to the
 * shipped .md defaults) so hooks/captions are always written to a real
 * person in a deliberate pillar.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { resetTestDb } from "../setup";
import { videoStrategyBlock } from "@/modules/marketing/lib/video/video-ai";

describe("videoStrategyBlock", () => {
  beforeEach(() => resetTestDb());

  it("injects the audience profile and content pillars", () => {
    const block = videoStrategyBlock();
    expect(block).toContain("VIDEO STRATEGY");
    // audience-profile.md content
    expect(block).toContain("AUDIENCE");
    expect(block).toContain("More frames. Less shame.");
    // content-pillars.md content
    expect(block).toContain("CONTENT PILLARS");
    expect(block).toMatch(/Fit Check|Shape Hero|content pillar/i);
  });
});
