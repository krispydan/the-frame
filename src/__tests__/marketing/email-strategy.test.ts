import { describe, it, expect } from "vitest";
import {
  recommendForSlot,
  recommendForWeek,
  computeSlotDate,
  LAYOUT_PROFILES,
} from "@/modules/marketing/lib/email-strategy";

describe("email strategy engine", () => {
  it("is deterministic — same input, same output", () => {
    const a = recommendForSlot("retail", "2026-07-06", 1);
    const b = recommendForSlot("retail", "2026-07-06", 1);
    expect(a).toEqual(b);
  });

  it("locks slot 1 to flat-lay and slot 2 to on-model (Daniel's spec)", () => {
    const s1 = recommendForSlot("retail", "2026-07-06", 1);
    const s2 = recommendForSlot("retail", "2026-07-06", 2);
    expect(s1.imageStyle).toBe("product_flatlay");
    expect(s2.imageStyle).toBe("on_model_lifestyle");
  });

  it("computes cadence send dates — retail Mon/Thu, wholesale Tue/Fri", () => {
    // 2026-07-06 is a Monday.
    expect(computeSlotDate("retail", "2026-07-06", 1)).toBe("2026-07-06"); // Mon
    expect(computeSlotDate("retail", "2026-07-06", 2)).toBe("2026-07-09"); // Thu
    expect(computeSlotDate("wholesale", "2026-07-06", 1)).toBe("2026-07-07"); // Tue
    expect(computeSlotDate("wholesale", "2026-07-06", 2)).toBe("2026-07-10"); // Fri
  });

  it("rotates layout by week", () => {
    const w0 = recommendForSlot("retail", "2026-01-05", 1).layoutProfile; // epoch week
    const w1 = recommendForSlot("retail", "2026-01-12", 1).layoutProfile;
    expect(w0).not.toBe(w1);
    expect(Object.keys(LAYOUT_PROFILES)).toContain(w0);
  });

  it("keeps both slots in a week on the same layout (visual coherence)", () => {
    const recs = recommendForWeek("wholesale", "2026-07-06");
    expect(recs).toHaveLength(2);
    expect(recs[0].layoutProfile).toBe(recs[1].layoutProfile);
  });

  it("returns a valid variant set matching the chosen layout profile", () => {
    const rec = recommendForSlot("retail", "2026-07-06", 1);
    const profile = LAYOUT_PROFILES[rec.layoutProfile];
    expect(rec.layoutVariants.heroVariant).toBe(profile.heroVariant);
    expect(rec.layoutVariants.secondaryImageVariant).toBe(profile.secondaryImageVariant);
  });
});
