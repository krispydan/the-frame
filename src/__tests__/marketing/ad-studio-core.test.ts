/**
 * Ad Studio foundations: naming convention round-trip, crop engine,
 * recipe layout merging, and the sharp card builder producing real
 * pixels at the geometry it reports.
 */
import { describe, it, expect } from "vitest";
import sharp from "sharp";
import {
  buildAdName, parseAdName, renderFileName, talentCode, colorCodeFromSku,
} from "@/modules/marketing/lib/ads/ad-naming";
import { AD_RATIOS, cropWindow, DEFAULT_RATIOS } from "@/modules/marketing/lib/ads/ratios";
import { PCARD, effectiveLayout, parseLayoutOverrides, listAdRecipes } from "@/modules/marketing/lib/ads/recipes";
import { buildCard } from "@/modules/marketing/lib/ads/card";

describe("ad naming", () => {
  const input = {
    recipe: "pcard",
    kind: "video" as const,
    productName: "Boulevard",
    sku: "JX4011-S-BLK",
    talent: "missjademonet",
    copyVariant: "C03",
    version: 2,
  };

  it("builds the convention shape", () => {
    expect(buildAdName(input)).toBe("JX_PCARD_VID_BOULEVARD-BLK_JADE_C03_v02");
  });

  it("round-trips through parse — the property the metrics report relies on", () => {
    const name = buildAdName(input);
    expect(parseAdName(name)).toEqual({
      recipe: "PCARD", format: "VID", product: "BOULEVARD", color: "BLK",
      model: "JADE", copyVariant: "C03", version: 2,
    });
  });

  it("parses render FILE names too, ratio included", () => {
    const file = renderFileName(buildAdName(input), "9x16", "video");
    expect(file).toBe("JX_PCARD_VID_BOULEVARD-BLK_JADE_C03_v02_9x16.mp4");
    expect(parseAdName(file)?.ratio).toBe("9x16");
  });

  it("sanitizes product names that would break the separators", () => {
    // Spaces and dashes inside a segment would make parse ambiguous.
    const name = buildAdName({ ...input, productName: "Take It-All 2" });
    expect(name).toContain("_TAKEITALL2-BLK_");
    expect(parseAdName(name)).not.toBeNull();
  });

  it("maps known models and falls back for new ones", () => {
    expect(talentCode("missjademonet")).toBe("JADE");
    expect(talentCode("Shianne Bateman")).toBe("SHIA");
    expect(talentCode(null)).toBe("NONE");
    expect(talentCode("Alexandra Nova")).toBe("ALEXAN");
  });

  it("derives the colour from the SKU's own suffix", () => {
    expect(colorCodeFromSku("JX4011-S-BLK")).toBe("BLK");
    expect(colorCodeFromSku("JX2006-TOR")).toBe("TOR");
  });

  it("defaults copy to C00 and rejects malformed codes", () => {
    expect(buildAdName({ ...input, copyVariant: undefined })).toContain("_C00_");
    expect(buildAdName({ ...input, copyVariant: "nope" })).toContain("_C00_");
  });

  it("rejects hand-typed garbage", () => {
    expect(parseAdName("my cool ad")).toBeNull();
    expect(parseAdName("JX_PCARD_GIF_A-B_X_C00_v01")).toBeNull();
  });
});

describe("crop engine", () => {
  it("keeps full width when cutting a 9:16 source to 4:5", () => {
    const w = cropWindow(1080, 1920, "4x5");
    expect(w.width).toBe(1080);
    expect(w.height).toBe(1350);
  });

  it("anchors upper-centre, not dead centre, on vertical slack", () => {
    const w = cropWindow(1080, 1920, "1x1");
    const centered = (1920 - 1080) / 2;
    expect(w.y).toBeLessThan(centered); // biased toward the face zone
    expect(w.y).toBeGreaterThanOrEqual(0);
  });

  it("offset nudges within the slack and clamps at the edges", () => {
    const base = cropWindow(1080, 1920, "1x1", 0, 0);
    const up = cropWindow(1080, 1920, "1x1", 0, -0.5);
    const down = cropWindow(1080, 1920, "1x1", 0, 0.5);
    expect(up.y).toBeLessThanOrEqual(base.y);
    expect(down.y).toBeGreaterThanOrEqual(base.y);
    expect(down.y + down.height).toBeLessThanOrEqual(1920);
  });

  it("emits even dimensions for every ratio (H.264 requirement)", () => {
    for (const ratio of Object.keys(AD_RATIOS) as Array<keyof typeof AD_RATIOS>) {
      const w = cropWindow(1919, 1079, ratio);
      expect(w.width % 2).toBe(0);
      expect(w.height % 2).toBe(0);
    }
  });
});

describe("recipe layouts", () => {
  it("registers pcard with defaults for every ratio", () => {
    expect(listAdRecipes().map((r) => r.slug)).toContain("pcard");
    for (const ratio of DEFAULT_RATIOS) {
      const l = PCARD.defaults[ratio];
      expect(l.cardW).toBeGreaterThan(0);
      expect(l.cardX).toBeCloseTo((1 - l.cardW) / 2, 5); // centered
    }
  });

  it("merges overrides over defaults and clamps garbage", () => {
    const l = effectiveLayout(PCARD, "4x5", { cardY: 0.8, cardW: 99 });
    expect(l.cardY).toBe(0.8);
    expect(l.cardW).toBe(1.5);                       // clamped, not 99
    expect(l.cardX).toBe(PCARD.defaults["4x5"].cardX); // untouched default
  });

  it("survives malformed override JSON from the DB", () => {
    expect(parseLayoutOverrides(null)).toEqual({});
    expect(parseLayoutOverrides("not json")).toEqual({});
    expect(parseLayoutOverrides('{"4x5":{"cardY":0.7}}')).toEqual({ "4x5": { cardY: 0.7 } });
  });
});

describe("card builder", () => {
  it("renders a real card whose pixels match its reported geometry", async () => {
    // A stand-in product cutout: red square on transparency.
    const dir = process.env.SCRATCHPAD_DIR ?? "/tmp";
    const productPath = `${dir}/ad-card-test-product.png`;
    await sharp({
      create: { width: 400, height: 200, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 1 } },
    }).png().toFile(productPath);

    const card = await buildCard({
      recipe: PCARD,
      ratio: "4x5",
      layout: effectiveLayout(PCARD, "4x5", undefined),
      productImage: productPath,
    });

    expect(card.width).toBe(Math.round(0.86 * 1080));
    expect(card.height).toBe(Math.round(card.width / PCARD.cardAspect));
    const meta = await sharp(card.png).metadata();
    expect(meta.width).toBe(card.width);
    expect(meta.height).toBe(card.height);
    expect(meta.channels).toBe(4); // transparency for the rounded corners

    // Text band sits inside the card's frame-absolute footprint.
    expect(card.text.y).toBeGreaterThan(card.y);
    expect(card.text.y + card.text.height).toBeLessThanOrEqual(card.y + card.height);
    expect(card.text.fontSize).toBeGreaterThan(10);

    // Centre pixel of the image area is the product (red), corners are
    // transparent (rounded), centre-top of the card is white.
    const raw = await sharp(card.png).raw().toBuffer();
    const px = (xx: number, yy: number) => {
      const i = (yy * card.width + xx) * 4;
      return [raw[i], raw[i + 1], raw[i + 2], raw[i + 3]];
    };
    expect(px(Math.round(card.width / 2), Math.round(card.height * 0.4))[0]).toBeGreaterThan(150); // red
    expect(px(1, 1)[3]).toBe(0); // rounded corner → transparent
  });
});
