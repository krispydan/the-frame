/**
 * bustUrl — versions a deterministic render URL so a re-render never
 * serves stale cached bytes at the same path.
 */
import { describe, it, expect } from "vitest";
import { bustUrl } from "@/lib/storage/videos";

describe("bustUrl", () => {
  it("appends a sanitized version token", () => {
    expect(bustUrl("https://cdn/x/post.mp4", "2026-07-27 18:00:00")).toBe("https://cdn/x/post.mp4?v=20260727180000");
  });
  it("uses & when the url already has a query", () => {
    expect(bustUrl("/api/videos/post.mp4?foo=1", "2026-07-27T18:00:00Z")).toBe("/api/videos/post.mp4?foo=1&v=20260727T180000Z");
  });
  it("changes when the token changes (busts cache on re-render)", () => {
    const a = bustUrl("https://cdn/p.mp4", "2026-07-27 18:00:00");
    const b = bustUrl("https://cdn/p.mp4", "2026-07-27 18:05:00");
    expect(a).not.toBe(b);
  });
  it("passes null through and no-ops an empty token", () => {
    expect(bustUrl(null, "x")).toBeNull();
    expect(bustUrl("https://cdn/p.mp4", null)).toBe("https://cdn/p.mp4");
  });
});
