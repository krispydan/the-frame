import { describe, it, expect } from "vitest";
import {
  ALLOWED_VIDEO_EXT,
  extFromName,
  contentTypeForExt,
  isValidChecksum,
  parseSkuIds,
} from "@/modules/marketing/lib/video/upload-shared";

describe("video upload-shared helpers", () => {
  it("extracts a lowercase extension, defaulting to .mp4", () => {
    expect(extFromName("Clip.MOV")).toBe(".mov");
    expect(extFromName("a.b.MP4")).toBe(".mp4");
    expect(extFromName("noext")).toBe(".mp4");
    expect(extFromName("")).toBe(".mp4");
  });

  it("accepts only known video extensions", () => {
    for (const ext of [".mp4", ".mov", ".m4v", ".webm", ".mkv"]) {
      expect(ALLOWED_VIDEO_EXT.has(ext)).toBe(true);
    }
    expect(ALLOWED_VIDEO_EXT.has(".exe")).toBe(false);
    expect(ALLOWED_VIDEO_EXT.has(".jpg")).toBe(false);
  });

  it("maps extensions to a signable content type", () => {
    expect(contentTypeForExt(".mp4")).toBe("video/mp4");
    expect(contentTypeForExt(".mov")).toBe("video/quicktime");
    expect(contentTypeForExt(".mkv")).toBe("video/x-matroska");
    expect(contentTypeForExt(".zip")).toBe("application/octet-stream");
  });

  it("validates the 16-hex content-address checksum", () => {
    expect(isValidChecksum("0123456789abcdef")).toBe(true);
    expect(isValidChecksum("0".repeat(16))).toBe(true);
    expect(isValidChecksum("0123456789ABCDEF")).toBe(false); // upper-case
    expect(isValidChecksum("0123456789abcde")).toBe(false); // 15 chars
    expect(isValidChecksum("0123456789abcdefff")).toBe(false); // 18 chars
    expect(isValidChecksum("")).toBe(false);
    expect(isValidChecksum(123 as unknown)).toBe(false);
  });

  it("parses sku ids from an array, JSON string, or comma list", () => {
    expect(parseSkuIds(["a", "b"])).toEqual(["a", "b"]);
    expect(parseSkuIds('["x","y"]')).toEqual(["x", "y"]);
    expect(parseSkuIds("p, q ,r")).toEqual(["p", "q", "r"]);
    expect(parseSkuIds("")).toEqual([]);
    expect(parseSkuIds(null)).toEqual([]);
    expect(parseSkuIds(undefined)).toEqual([]);
  });
});
