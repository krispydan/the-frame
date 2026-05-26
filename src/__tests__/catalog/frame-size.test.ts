/**
 * Tests for the frame-size parser used to ingest factory dimension strings.
 * See src/modules/catalog/lib/frame-size.ts.
 */
import { describe, it, expect } from "vitest";
import { parseFrameSize, formatFrameSize } from "@/modules/catalog/lib/frame-size";

describe("parseFrameSize", () => {
  it("parses the canonical factory format with 口", () => {
    expect(parseFrameSize("51口22 145")).toEqual({
      lensWidth: 51,
      bridgeWidth: 22,
      templeLength: 145,
    });
  });

  it("parses with hyphen separators", () => {
    expect(parseFrameSize("52-20-148")).toEqual({
      lensWidth: 52,
      bridgeWidth: 20,
      templeLength: 148,
    });
  });

  it("parses with x separators (lowercase, uppercase, multiplication sign)", () => {
    expect(parseFrameSize("51x22x145")).toEqual({
      lensWidth: 51,
      bridgeWidth: 22,
      templeLength: 145,
    });
    expect(parseFrameSize("51X22X145")).toEqual({
      lensWidth: 51,
      bridgeWidth: 22,
      templeLength: 145,
    });
    expect(parseFrameSize("51×22×145")).toEqual({
      lensWidth: 51,
      bridgeWidth: 22,
      templeLength: 145,
    });
  });

  it("parses with plain whitespace separators", () => {
    expect(parseFrameSize("51 22 145")).toEqual({
      lensWidth: 51,
      bridgeWidth: 22,
      templeLength: 145,
    });
  });

  it("parses an optional 4th lens-height value", () => {
    expect(parseFrameSize("51 22 145 38")).toEqual({
      lensWidth: 51,
      bridgeWidth: 22,
      templeLength: 145,
      lensHeight: 38,
    });
  });

  it("tolerates a trailing 'mm' suffix", () => {
    expect(parseFrameSize("51-22-145 mm")).toEqual({
      lensWidth: 51,
      bridgeWidth: 22,
      templeLength: 145,
    });
  });

  it("returns null on garbage input", () => {
    expect(parseFrameSize("")).toBeNull();
    expect(parseFrameSize(null)).toBeNull();
    expect(parseFrameSize(undefined)).toBeNull();
    expect(parseFrameSize("foo bar")).toBeNull();
    expect(parseFrameSize("51")).toBeNull(); // not enough values
    expect(parseFrameSize("51 22 145 38 12")).toBeNull(); // too many values
  });

  it("returns null on out-of-range numbers (likely mis-parse)", () => {
    expect(parseFrameSize("999口22 145")).toBeNull(); // lens too wide
    expect(parseFrameSize("51口5 145")).toBeNull(); // bridge too narrow
    expect(parseFrameSize("51口22 50")).toBeNull(); // temple too short
    expect(parseFrameSize("51口22 145 200")).toBeNull(); // lens height too big
  });
});

describe("formatFrameSize", () => {
  it("formats a 3-dimension frame with 口", () => {
    expect(
      formatFrameSize({ lensWidth: 51, bridgeWidth: 22, templeLength: 145 }),
    ).toBe("51口22 145");
  });

  it("appends lens height with a slash when present", () => {
    expect(
      formatFrameSize({
        lensWidth: 51,
        bridgeWidth: 22,
        templeLength: 145,
        lensHeight: 38,
      }),
    ).toBe("51口22 145 / 38");
  });

  it("returns empty string on null/undefined", () => {
    expect(formatFrameSize(null)).toBe("");
    expect(formatFrameSize(undefined)).toBe("");
  });

  it("round-trips with parseFrameSize", () => {
    const original = { lensWidth: 51, bridgeWidth: 22, templeLength: 145 };
    expect(parseFrameSize(formatFrameSize(original))).toEqual(original);
  });
});
