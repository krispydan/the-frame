import { describe, it, expect } from "vitest";
import {
  clipWeight,
  composeCandidate,
  FALLBACK_RECIPE_ID,
  permutationHash,
  pickRecipe,
  recipeSatisfiable,
  resolveAudio,
  type ComposerClip,
  type ComposerContext,
} from "@/modules/marketing/lib/video/composer";
import type { VideoRecipe } from "@/modules/marketing/schema";

// Deterministic RNG (mulberry32) so sequences are pinned per seed.
function seededRand(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let clipCounter = 0;
function makeClip(overrides: Partial<ComposerClip> = {}): ComposerClip {
  clipCounter++;
  return {
    id: `clip-${clipCounter}`,
    categoryId: "cat",
    categorySlug: "flat_lay",
    audioMode: "mute",
    durationSec: 6,
    boost: 0,
    timesUsed: 0,
    lastUsedAt: null,
    skuIds: [],
    ...overrides,
  };
}

function makeRecipe(overrides: Partial<VideoRecipe> = {}): VideoRecipe {
  return {
    id: "recipe-1",
    name: "Test recipe",
    description: null,
    patternJson: JSON.stringify([{ categories: ["flat_lay"], min: 3, max: 5 }]),
    audioPolicy: "silent",
    durationTargetMin: 15,
    durationTargetMax: 30,
    weight: 1,
    enabled: 1,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  } as VideoRecipe;
}

function makeContext(clips: ComposerClip[], recipes: VideoRecipe[], seed = 42): ComposerContext {
  return {
    clips,
    recipes,
    skuSignals: new Map(),
    events: [],
    recentSkuFeatures: new Map(),
    forDate: "2026-07-08",
    rand: seededRand(seed),
  };
}

describe("Video composer", () => {
  it("honors the recipe pattern — an all-flat-lay recipe never picks other categories", () => {
    const clips = [
      ...Array.from({ length: 8 }, () => makeClip({ categorySlug: "flat_lay" })),
      ...Array.from({ length: 8 }, () => makeClip({ categorySlug: "ugc_unboxing" })),
    ];
    const byId = new Map(clips.map((c) => [c.id, c]));
    for (let seed = 1; seed <= 20; seed++) {
      const result = composeCandidate(makeContext(clips, [makeRecipe()], seed));
      expect(result).not.toBeNull();
      for (const id of result!.clipIds) {
        expect(byId.get(id)!.categorySlug).toBe("flat_lay");
      }
    }
  });

  it("respects slot min/max counts and duration bounds", () => {
    const clips = Array.from({ length: 12 }, () => makeClip({ durationSec: 5 }));
    const recipe = makeRecipe({
      patternJson: JSON.stringify([{ categories: ["flat_lay"], min: 4, max: 6 }]),
    });
    for (let seed = 1; seed <= 20; seed++) {
      const result = composeCandidate(makeContext(clips, [recipe], seed));
      expect(result).not.toBeNull();
      expect(result!.clipIds.length).toBeGreaterThanOrEqual(4);
      expect(result!.clipIds.length).toBeLessThanOrEqual(6);
      expect(result!.durationSec).toBeGreaterThanOrEqual(15);
      // min-count enforcement may push slightly past max; never wildly
      expect(result!.durationSec).toBeLessThanOrEqual(35);
    }
  });

  it("walks multi-slot patterns in order (unboxing first, then b-roll)", () => {
    const unboxing = Array.from({ length: 3 }, () => makeClip({ categorySlug: "ugc_unboxing", durationSec: 8 }));
    const broll = Array.from({ length: 6 }, () => makeClip({ categorySlug: "broll", durationSec: 5 }));
    const byId = new Map([...unboxing, ...broll].map((c) => [c.id, c]));
    const recipe = makeRecipe({
      patternJson: JSON.stringify([
        { categories: ["ugc_unboxing"], min: 1, max: 1 },
        { categories: ["broll"], min: 2, max: 3 },
      ]),
    });
    const result = composeCandidate(makeContext([...unboxing, ...broll], [recipe], 7));
    expect(result).not.toBeNull();
    expect(byId.get(result!.clipIds[0])!.categorySlug).toBe("ugc_unboxing");
    for (const id of result!.clipIds.slice(1)) {
      expect(byId.get(id)!.categorySlug).toBe("broll");
    }
  });

  it("never reuses a clip within one video", () => {
    const clips = Array.from({ length: 6 }, () => makeClip());
    for (let seed = 1; seed <= 20; seed++) {
      const result = composeCandidate(makeContext(clips, [makeRecipe()], seed));
      expect(new Set(result!.clipIds).size).toBe(result!.clipIds.length);
    }
  });

  describe("audio resolution", () => {
    const recipeFor = (policy: VideoRecipe["audioPolicy"]) => makeRecipe({ audioPolicy: policy });
    const keep = makeClip({ audioMode: "keep" });
    const mute1 = makeClip({ audioMode: "mute" });
    const mute2 = makeClip({ audioMode: "mute" });
    const clipsById = new Map([keep, mute1, mute2].map((c) => [c.id, c]));

    it("silent policy mutes everything", () => {
      const { audibleClipIds, audioTreatment } = resolveAudio(recipeFor("silent"), [keep.id, mute1.id], clipsById);
      expect(audibleClipIds).toEqual([]);
      expect(audioTreatment).toBe("silent");
    });

    it("original policy keeps only keep-flagged clips", () => {
      const { audibleClipIds, audioTreatment } = resolveAudio(
        recipeFor("original"), [keep.id, mute1.id, mute2.id], clipsById,
      );
      expect(audibleClipIds).toEqual([keep.id]);
      expect(audioTreatment).toBe("partial");
    });

    it("original policy over all-keep clips is full", () => {
      const keep2 = makeClip({ audioMode: "keep" });
      const map = new Map([keep, keep2].map((c) => [c.id, c]));
      const { audioTreatment } = resolveAudio(recipeFor("original"), [keep.id, keep2.id], map);
      expect(audioTreatment).toBe("full");
    });

    it("lead_clip_only keeps just the first clip, and only when flagged", () => {
      const lead = resolveAudio(recipeFor("lead_clip_only"), [keep.id, mute1.id], clipsById);
      expect(lead.audibleClipIds).toEqual([keep.id]);
      expect(lead.audioTreatment).toBe("partial");

      const muteLead = resolveAudio(recipeFor("lead_clip_only"), [mute1.id, keep.id], clipsById);
      expect(muteLead.audibleClipIds).toEqual([]);
      expect(muteLead.audioTreatment).toBe("silent");
    });
  });

  it("permutation hash is order-sensitive and audio-sensitive", () => {
    const a = permutationHash("r1", ["c1", "c2", "c3"], "silent");
    const b = permutationHash("r1", ["c2", "c1", "c3"], "silent");
    const c = permutationHash("r1", ["c1", "c2", "c3"], "partial");
    const d = permutationHash("r2", ["c1", "c2", "c3"], "silent");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    expect(permutationHash("r1", ["c1", "c2", "c3"], "silent")).toBe(a);
  });

  it("skips recipes the library cannot satisfy", () => {
    const clips = Array.from({ length: 5 }, () => makeClip({ categorySlug: "flat_lay" }));
    const impossible = makeRecipe({
      id: "impossible",
      patternJson: JSON.stringify([{ categories: ["in_car"], min: 2, max: 3 }]),
    });
    expect(recipeSatisfiable(impossible, clips)).toBe(false);
    // pickRecipe falls back to the satisfiable one
    const possible = makeRecipe({ id: "possible" });
    const picked = pickRecipe(makeContext(clips, [impossible, possible]), seededRand(1));
    expect(picked?.id).toBe("possible");
    // ...and returns null when nothing works
    expect(pickRecipe(makeContext(clips, [impossible]), seededRand(1))).toBeNull();
  });

  it("returns null only when fewer than 2 clips exist", () => {
    expect(composeCandidate(makeContext([], [makeRecipe()]))).toBeNull();
    expect(composeCandidate(makeContext([makeClip()], [makeRecipe()]))).toBeNull(); // 1 clip
  });

  it("falls back to a freestyle mix when no recipe can be satisfied", () => {
    // Recipe needs 3 clips of a category we don't have; still get a video.
    const clips = [makeClip(), makeClip(), makeClip()]; // makeRecipe min is 3, wrong category
    const recipe = makeRecipe({ patternJson: JSON.stringify([{ categories: ["nonexistent"], min: 3, max: 3 }]) });
    for (let seed = 1; seed <= 5; seed++) {
      const result = composeCandidate(makeContext(clips, [recipe], seed));
      expect(result).not.toBeNull();
      expect(result!.recipeId).toBe(FALLBACK_RECIPE_ID);
      expect(result!.clipIds.length).toBeGreaterThanOrEqual(2);
      // No repeated clips within the edit.
      expect(new Set(result!.clipIds).size).toBe(result!.clipIds.length);
    }
  });

  it("guarantees focus-SKU coverage when the recipe allows it", () => {
    const focusClip = makeClip({ skuIds: ["sku-focus"] });
    const others = Array.from({ length: 9 }, () => makeClip());
    const ctx = makeContext([focusClip, ...others], [makeRecipe()], 3);
    // Heavy signal so the focus SKU always wins the weighted pick.
    ctx.skuSignals = new Map([["sku-focus", { skuId: "sku-focus", momentumScore: 100 }]]);
    for (let seed = 1; seed <= 10; seed++) {
      ctx.rand = seededRand(seed);
      const result = composeCandidate(ctx);
      expect(result).not.toBeNull();
      expect(result!.focusSkuIds).toContain("sku-focus");
      expect(result!.clipIds).toContain(focusClip.id);
    }
  });

  it("damps recently-used clips and long-run overuse", () => {
    const fresh = makeClip();
    const recent = makeClip({ lastUsedAt: "2026-07-06" }); // 2 days before forDate
    const overused = makeClip({ timesUsed: 40 });
    const wFresh = clipWeight(fresh, [], "2026-07-08");
    const wRecent = clipWeight(recent, [], "2026-07-08");
    const wOverused = clipWeight(overused, [], "2026-07-08");
    expect(wRecent).toBeLessThan(wFresh * 0.2);
    expect(wOverused).toBeLessThan(wFresh);
    // boost pushes the other way
    const boosted = makeClip({ boost: 2 });
    expect(clipWeight(boosted, [], "2026-07-08")).toBeGreaterThan(wFresh);
  });
});
