/**
 * Non-destructive clip trims — the pure model behind in/out points.
 *
 * The property that actually matters here is ALIGNMENT: trims are stored
 * index-parallel to a post's clipIds, so a parse that returns a shifted
 * or short array would cut the wrong clip. Those cases assert all-nulls,
 * not a best-effort guess.
 */
import { describe, it, expect } from "vitest";
import {
  parseClipTrims,
  serializeClipTrims,
  validateTrim,
  effectiveDuration,
  isNoOpTrim,
  MIN_TRIM_SEC,
  type ClipTrim,
} from "@/modules/marketing/lib/video/clip-trims";

describe("parseClipTrims", () => {
  it("returns all-nulls for an unset column", () => {
    expect(parseClipTrims(null, 3)).toEqual([null, null, null]);
    expect(parseClipTrims("", 2)).toEqual([null, null]);
    expect(parseClipTrims(undefined, 1)).toEqual([null]);
  });

  it("round-trips a real trim", () => {
    const json = JSON.stringify([null, { inSec: 1, outSec: 3.5 }, null]);
    expect(parseClipTrims(json, 3)).toEqual([null, { inSec: 1, outSec: 3.5 }, null]);
  });

  it("drops EVERYTHING when the length doesn't match clipIds", () => {
    // A clip was added/removed without rewriting trims: every position
    // after the edit is now off by one. Losing the trims is recoverable;
    // cutting the wrong clip is not.
    const json = JSON.stringify([{ inSec: 1, outSec: 3 }, null]);
    expect(parseClipTrims(json, 3)).toEqual([null, null, null]);
    expect(parseClipTrims(json, 1)).toEqual([null]);
  });

  it("survives malformed JSON and non-array payloads", () => {
    expect(parseClipTrims("{not json", 2)).toEqual([null, null]);
    expect(parseClipTrims(JSON.stringify({ 0: { inSec: 1, outSec: 2 } }), 2)).toEqual([null, null]);
  });

  it("nulls out individual entries that aren't a usable range", () => {
    const json = JSON.stringify([
      { inSec: 2, outSec: 1 },      // inverted
      { inSec: -1, outSec: 3 },     // negative in
      { inSec: 1, outSec: 1 },      // zero length
      { inSec: "a", outSec: 3 },    // not numeric
      { inSec: 0.5, outSec: 2 },    // fine
    ]);
    expect(parseClipTrims(json, 5)).toEqual([null, null, null, null, { inSec: 0.5, outSec: 2 }]);
  });
});

describe("serializeClipTrims", () => {
  it("stores NULL when nothing is trimmed", () => {
    expect(serializeClipTrims([null, null])).toBeNull();
    expect(serializeClipTrims([])).toBeNull();
  });

  it("keeps the null padding so positions stay aligned", () => {
    const json = serializeClipTrims([null, { inSec: 1, outSec: 2 }, null]);
    expect(json).toBe('[null,{"inSec":1,"outSec":2},null]');
    expect(parseClipTrims(json, 3)).toEqual([null, { inSec: 1, outSec: 2 }, null]);
  });
});

describe("validateTrim", () => {
  it("accepts a sane range", () => {
    const v = validateTrim({ inSec: 1, outSec: 4 }, 6);
    expect(v.ok).toBe(true);
    expect(v.trim).toEqual({ inSec: 1, outSec: 4 });
  });

  it("clamps an out point that overshoots the probed duration", () => {
    // The UI lets you drag to "the end"; probed durations are floats, so
    // the out point can land a few ms past it. Clamp, don't reject.
    const v = validateTrim({ inSec: 1, outSec: 6.04 }, 6);
    expect(v.ok).toBe(true);
    expect(v.trim).toEqual({ inSec: 1, outSec: 6 });
  });

  it("rejects an inverted or too-short range", () => {
    expect(validateTrim({ inSec: 3, outSec: 3 }, 6).ok).toBe(false);
    expect(validateTrim({ inSec: 4, outSec: 2 }, 6).ok).toBe(false);
    const short = validateTrim({ inSec: 1, outSec: 1 + MIN_TRIM_SEC / 2 }, 6);
    expect(short.ok).toBe(false);
    expect(short.error).toContain(`${MIN_TRIM_SEC}s`);
  });

  it("rejects a range left too short BY the clamp", () => {
    // out=9 clamped to 5 leaves 5-4.5 = 0.5s, under the floor.
    expect(validateTrim({ inSec: 4.5, outSec: 9 }, 5).ok).toBe(false);
  });

  it("rejects an in point past the end", () => {
    const v = validateTrim({ inSec: 7, outSec: 9 }, 6);
    expect(v.ok).toBe(false);
    expect(v.error).toContain("past the clip's end");
  });

  it("rejects non-numeric input", () => {
    expect(validateTrim({ inSec: NaN, outSec: 3 }, 6).ok).toBe(false);
    expect(validateTrim({ inSec: 0, outSec: Infinity }, 6).ok).toBe(false);
  });

  it("skips duration checks when the clip hasn't been probed", () => {
    const v = validateTrim({ inSec: 1, outSec: 4 }, null);
    expect(v.ok).toBe(true);
    expect(v.trim).toEqual({ inSec: 1, outSec: 4 });
  });

  it("rounds to milliseconds", () => {
    const v = validateTrim({ inSec: 1.00049, outSec: 4.99951 }, 6);
    expect(v.trim).toEqual({ inSec: 1, outSec: 5 });
  });
});

describe("effectiveDuration", () => {
  const trim: ClipTrim = { inSec: 1, outSec: 4 };

  it("is the full duration when untrimmed", () => {
    expect(effectiveDuration(6, null)).toBe(6);
    expect(effectiveDuration(null, null)).toBe(0);
  });

  it("is the trimmed window when trimmed", () => {
    expect(effectiveDuration(6, trim)).toBe(3);
  });

  it("clamps against the real duration rather than trusting the trim", () => {
    // Stale trim on a re-normalized (shorter) clip: never report more
    // than the clip can supply, or the render's duration check trips.
    expect(effectiveDuration(2, trim)).toBe(1);
    expect(effectiveDuration(0.5, trim)).toBe(0);
  });
});

describe("isNoOpTrim", () => {
  it("treats a whole-clip range as untrimmed so render keeps the copy path", () => {
    expect(isNoOpTrim(null, 6)).toBe(true);
    expect(isNoOpTrim({ inSec: 0, outSec: 6 }, 6)).toBe(true);
    // Sub-millisecond slop from float drag maths still counts as whole.
    expect(isNoOpTrim({ inSec: 0.0005, outSec: 5.9995 }, 6)).toBe(true);
  });

  it("treats any real cut as a trim", () => {
    expect(isNoOpTrim({ inSec: 0.5, outSec: 6 }, 6)).toBe(false);
    expect(isNoOpTrim({ inSec: 0, outSec: 5 }, 6)).toBe(false);
  });

  it("honours the trim when the duration is unknown", () => {
    // Can't prove it covers the clip, so re-encode rather than silently
    // rendering the whole thing.
    expect(isNoOpTrim({ inSec: 0, outSec: 5 }, null)).toBe(false);
  });
});
