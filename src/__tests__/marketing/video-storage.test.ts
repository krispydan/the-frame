import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import {
  getVideoFullPath,
  videosRoot,
  rawClipPath,
  normalizedClipPath,
  mutedClipPath,
  clipPosterPath,
  renderPath,
  tmpPath,
  videoUrl,
} from "@/lib/storage/videos";

describe("Video storage path helpers", () => {
  beforeEach(() => {
    process.env.VIDEOS_PATH = "/data/videos-test";
  });

  it("resolves relative paths inside the root", () => {
    expect(getVideoFullPath("clips/raw/abc.mp4")).toBe(
      path.resolve("/data/videos-test/clips/raw/abc.mp4"),
    );
    // leading slashes are treated as relative
    expect(getVideoFullPath("/clips/raw/abc.mp4")).toBe(
      path.resolve("/data/videos-test/clips/raw/abc.mp4"),
    );
  });

  it("rejects path traversal", () => {
    expect(() => getVideoFullPath("../etc/passwd")).toThrow(/traversal/i);
    expect(() => getVideoFullPath("clips/../../etc/passwd")).toThrow(/traversal/i);
    expect(() => getVideoFullPath("clips/raw/../../../../etc/passwd")).toThrow(/traversal/i);
  });

  it("falls back to <cwd>/data/videos without VIDEOS_PATH", () => {
    delete process.env.VIDEOS_PATH;
    expect(videosRoot()).toBe(path.join(process.cwd(), "data", "videos"));
  });

  it("builds the documented volume layout", () => {
    expect(rawClipPath("abc123", "mov")).toBe("clips/raw/abc123.mov");
    expect(rawClipPath("abc123", ".mp4")).toBe("clips/raw/abc123.mp4");
    expect(normalizedClipPath("abc123", 1)).toBe("clips/normalized/abc123_v1.mp4");
    expect(mutedClipPath("abc123", 2)).toBe("clips/normalized/abc123_v2_muted.mp4");
    expect(clipPosterPath("abc123")).toBe("clips/posters/abc123.jpg");
    expect(renderPath("post-1", "2026-07", "mp4")).toBe("renders/2026-07/post-1.mp4");
    expect(renderPath("post-1", "2026-07", "jpg")).toBe("renders/2026-07/post-1.jpg");
    expect(tmpPath("post-1.txt")).toBe("tmp/post-1.txt");
  });

  it("builds public URLs under /api/videos", () => {
    expect(videoUrl("renders/2026-07/post-1.mp4")).toBe("/api/videos/renders/2026-07/post-1.mp4");
    expect(videoUrl("/clips/posters/abc.jpg")).toBe("/api/videos/clips/posters/abc.jpg");
  });
});
