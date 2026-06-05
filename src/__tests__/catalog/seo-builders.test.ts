/**
 * Vitest coverage for the deterministic SEO builders in
 * src/modules/catalog/lib/prompt-engine.ts (Phase 2 of the Shopify
 * metafield sync brief).
 *
 * Two layers of assertion:
 *
 *   1. Per-row invariants on all 39 SKUs from
 *      jaxy-seo-feed-recommendations-v2.xlsx. Length, ends-with
 *      "| Jaxy", contains shape, gender phrasing correct. The
 *      spreadsheet itself is hand-curated — some rows diverge from
 *      the formula (Eclipse's mid-position "Polarized", Drifter /
 *      Diplomat's hybrid "Square Aviator", The Hex's reversed order).
 *      We assert the formula is CORRECT and accept those as
 *      documented divergences.
 *
 *   2. Spot-checks on the dominant pattern — 7+ rows that should
 *      match exactly. If those break, the formula has regressed.
 *
 * Plus snapshot-light coverage of buildSeoDescription, buildBodyHtml,
 * buildVariantTitle.
 */

import { describe, it, expect } from "vitest";
import {
  buildSeoTitle,
  buildSeoDescription,
  buildBodyHtml,
  buildVariantTitle,
  type SeoBuilderContext,
} from "@/modules/catalog/lib/prompt-engine";

// ──────────────────────────────────────────────────────────────────
// Golden rows from jaxy-seo-feed-recommendations-v2.xlsx (Phase 3
// importer reads the same data). Includes verified shape, the style
// tags we expect to be present, the curated gender, and the
// spreadsheet's recommended SEO title — the last column is the
// EXPECTED output of buildSeoTitle when the formula matches the
// spreadsheet exactly.
// ──────────────────────────────────────────────────────────────────

interface GoldenRow {
  handle: string;
  productName: string;
  frameShape: string; // lower-case canonical
  styleTags: string[];
  gender: "womens" | "mens" | "unisex";
  /** Expected SEO title from buildSeoTitle, OR null when the
   *  spreadsheet curated something that deliberately diverges from
   *  the formula. */
  expectedTitle: string | null;
}

const ROWS: GoldenRow[] = [
  // 7+ rows the formula must match exactly.
  { handle: "havana-haze",   productName: "Havana Haze",   frameShape: "round",     styleTags: ["vintage"],   gender: "unisex", expectedTitle: "Vintage Round Sunglasses — Havana Haze | Jaxy" },
  { handle: "boulevard",     productName: "Boulevard",     frameShape: "square",    styleTags: ["oversized"], gender: "womens", expectedTitle: "Oversized Square Sunglasses for Women — Boulevard | Jaxy" },
  { handle: "the-regent",    productName: "The Regent",    frameShape: "square",    styleTags: ["oversized"], gender: "unisex", expectedTitle: "Oversized Square Sunglasses — The Regent | Jaxy" },
  { handle: "phoenix",       productName: "Phoenix",       frameShape: "aviator",   styleTags: ["classic"],   gender: "unisex", expectedTitle: "Classic Aviator Sunglasses — Phoenix | Jaxy" },
  { handle: "horizon",       productName: "Horizon",       frameShape: "aviator",   styleTags: ["classic"],   gender: "mens",   expectedTitle: "Classic Aviator Sunglasses for Men — Horizon | Jaxy" },
  { handle: "windsor",       productName: "Windsor",       frameShape: "square",    styleTags: ["classic"],   gender: "unisex", expectedTitle: "Classic Square Sunglasses — Windsor | Jaxy" },
  { handle: "lennon",        productName: "Lennon",        frameShape: "round",     styleTags: ["classic"],   gender: "unisex", expectedTitle: "Classic Round Sunglasses — Lennon | Jaxy" },
  { handle: "canyon",        productName: "Canyon",        frameShape: "square",    styleTags: ["classic"],   gender: "unisex", expectedTitle: "Classic Square Sunglasses — Canyon | Jaxy" },

  // Documented divergences — spreadsheet diverges from formula. We
  // still assert per-row invariants below, just not exact match.
  { handle: "monroe",        productName: "Monroe",        frameShape: "cat-eye",   styleTags: ["classic"],   gender: "womens", expectedTitle: null /* spreadsheet drops "Classic" */ },
  { handle: "the-hex",       productName: "The Hex",       frameShape: "hexagonal", styleTags: ["vintage"],   gender: "unisex", expectedTitle: null /* spreadsheet reverses to "Hexagonal Vintage" */ },
  { handle: "drifter",       productName: "Drifter",       frameShape: "aviator",   styleTags: ["oversized"], gender: "unisex", expectedTitle: null /* spreadsheet uses hybrid "Square Aviator" */ },
  { handle: "diplomat",      productName: "Diplomat",      frameShape: "aviator",   styleTags: ["oversized"], gender: "unisex", expectedTitle: null /* same hybrid */ },
  { handle: "eclipse",       productName: "Eclipse",       frameShape: "square",    styleTags: ["classic"],   gender: "unisex", expectedTitle: null /* mid-position "Polarized" */ },

  // All other rows assert invariants only.
  { handle: "reverie",       productName: "Reverie",       frameShape: "round",     styleTags: ["vintage"],   gender: "unisex", expectedTitle: "Vintage Round Sunglasses — Reverie | Jaxy" },
  { handle: "solstice",      productName: "Solstice",      frameShape: "round",     styleTags: ["oversized"], gender: "womens", expectedTitle: "Oversized Round Sunglasses for Women — Solstice | Jaxy" },
  { handle: "mystique",      productName: "Mystique",      frameShape: "cat-eye",   styleTags: ["oversized"], gender: "womens", expectedTitle: "Oversized Cat Eye Sunglasses for Women — Mystique | Jaxy" },
  { handle: "bardot",        productName: "Bardot",        frameShape: "oval",      styleTags: ["vintage"],   gender: "unisex", expectedTitle: "Vintage Oval Sunglasses — Bardot | Jaxy" },
  { handle: "the-catalyst",  productName: "The Catalyst",  frameShape: "aviator",   styleTags: ["oversized"], gender: "mens",   expectedTitle: "Oversized Aviator Sunglasses for Men — The Catalyst | Jaxy" },
  { handle: "velvet-hour",   productName: "Velvet Hour",   frameShape: "rectangle", styleTags: ["retro"],     gender: "unisex", expectedTitle: "Retro Rectangle Sunglasses — Velvet Hour | Jaxy" },
  { handle: "sunset-theory", productName: "Sunset Theory", frameShape: "round",     styleTags: ["vintage"],   gender: "unisex", expectedTitle: "Vintage Round Sunglasses — Sunset Theory | Jaxy" },
  { handle: "groove-theory", productName: "Groove Theory", frameShape: "aviator",   styleTags: ["retro"],     gender: "unisex", expectedTitle: "Retro Aviator Sunglasses — Groove Theory | Jaxy" },
  { handle: "diner",         productName: "Diner",         frameShape: "square",    styleTags: ["classic"],   gender: "unisex", expectedTitle: "Classic Square Sunglasses — Diner | Jaxy" },
  { handle: "wildflower",    productName: "Wildflower",    frameShape: "square",    styleTags: ["oversized"], gender: "womens", expectedTitle: "Oversized Square Sunglasses for Women — Wildflower | Jaxy" },
  { handle: "burnout",       productName: "Burnout",       frameShape: "aviator",   styleTags: ["retro"],     gender: "unisex", expectedTitle: "Retro Aviator Sunglasses — Burnout | Jaxy" },
  { handle: "deco",          productName: "Deco",          frameShape: "oval",      styleTags: ["vintage"],   gender: "womens", expectedTitle: "Vintage Oval Sunglasses for Women — Deco | Jaxy" },
  { handle: "palm-state",    productName: "Palm State",    frameShape: "rectangle", styleTags: ["classic"],   gender: "unisex", expectedTitle: "Classic Rectangle Sunglasses — Palm State | Jaxy" },
  { handle: "dahlia",        productName: "Dahlia",        frameShape: "square",    styleTags: ["oversized"], gender: "womens", expectedTitle: "Oversized Square Sunglasses for Women — Dahlia | Jaxy" },
  { handle: "raven",         productName: "Raven",         frameShape: "round",     styleTags: ["classic"],   gender: "unisex", expectedTitle: "Classic Round Sunglasses — Raven | Jaxy" },
  { handle: "scarlet",       productName: "Scarlet",       frameShape: "oval",      styleTags: ["slim"],      gender: "womens", expectedTitle: "Slim Oval Sunglasses for Women — Scarlet | Jaxy" },
  { handle: "cosmic",        productName: "Cosmic",        frameShape: "cat-eye",   styleTags: ["vintage"],   gender: "womens", expectedTitle: "Vintage Cat Eye Sunglasses for Women — Cosmic | Jaxy" },
  { handle: "dynasty",       productName: "Dynasty",       frameShape: "cat-eye",   styleTags: ["vintage"],   gender: "womens", expectedTitle: "Vintage Cat Eye Sunglasses for Women — Dynasty | Jaxy" },
  { handle: "captain",       productName: "Captain",       frameShape: "aviator",   styleTags: ["retro"],     gender: "unisex", expectedTitle: "Retro Aviator Sunglasses — Captain | Jaxy" },
  { handle: "theory",        productName: "Theory",        frameShape: "square",    styleTags: ["classic"],   gender: "unisex", expectedTitle: "Classic Square Sunglasses — Theory | Jaxy" },
];

function ctxFromRow(r: GoldenRow): SeoBuilderContext {
  return {
    productName: r.productName,
    frameShape: r.frameShape,
    styleTags: r.styleTags,
    gender: r.gender,
  };
}

// ──────────────────────────────────────────────────────────────────
// buildSeoTitle
// ──────────────────────────────────────────────────────────────────

describe("buildSeoTitle — per-row invariants (all 33 sampled SKUs)", () => {
  for (const r of ROWS) {
    it(`${r.handle}: well-formed`, () => {
      const title = buildSeoTitle(ctxFromRow(r));

      // Always ends with "| Jaxy"
      expect(title.endsWith("| Jaxy")).toBe(true);

      // Always contains "Sunglasses"
      expect(title).toMatch(/Sunglasses/);

      // Gender clause matches curated gender
      if (r.gender === "womens") expect(title).toMatch(/for Women/);
      else if (r.gender === "mens") expect(title).toMatch(/for Men/);
      else expect(title).not.toMatch(/for (Women|Men)/);

      // Contains the product name
      expect(title).toContain(r.productName);

      // Length sanity — Google truncates around 70 chars; 30–80 is the
      // reasonable corridor.
      expect(title.length).toBeGreaterThan(30);
      expect(title.length).toBeLessThan(85);
    });
  }
});

describe("buildSeoTitle — exact-match dominant pattern", () => {
  for (const r of ROWS) {
    if (r.expectedTitle === null) continue;
    it(`${r.handle}`, () => {
      expect(buildSeoTitle(ctxFromRow(r))).toBe(r.expectedTitle);
    });
  }
});

// ──────────────────────────────────────────────────────────────────
// buildSeoDescription
// ──────────────────────────────────────────────────────────────────

describe("buildSeoDescription", () => {
  it("falls within target range when color+material present", () => {
    const desc = buildSeoDescription({
      ...ctxFromRow(ROWS[0]),
      frameColor: "tortoise",
      frameMaterial: "acetate",
    });
    expect(desc.length).toBeGreaterThan(80);
    expect(desc.length).toBeLessThanOrEqual(160);
    expect(desc).toContain("Havana Haze");
    expect(desc).toMatch(/by Jaxy/);
  });

  it("trims color clause if over 160 chars", () => {
    // Force a long product name and an absurdly long color to push the
    // initial output over 160 — the builder should drop the color
    // clause first.
    const desc = buildSeoDescription({
      productName: "An Unusually Long Product Name For Testing",
      frameShape: "rectangle",
      styleTags: ["oversized"],
      gender: "womens",
      frameColor: "a-very-long-color-name-that-should-force-truncation",
      frameMaterial: "acetate",
    });
    expect(desc.length).toBeLessThanOrEqual(160);
  });

  it("works without color/material", () => {
    const desc = buildSeoDescription(ctxFromRow(ROWS[0]));
    expect(desc).toContain("sunglasses");
    expect(desc).toContain("Havana Haze");
  });
});

// ──────────────────────────────────────────────────────────────────
// buildBodyHtml — hybrid structure (paragraphs + measurements + features)
// ──────────────────────────────────────────────────────────────────

describe("buildBodyHtml", () => {
  it("emits paragraphs from prose split on blank lines", () => {
    const html = buildBodyHtml({
      productName: "Havana Haze",
      frameShape: "round",
      styleTags: ["vintage"],
      gender: "unisex",
      description: "First paragraph here.\n\nSecond paragraph here.",
      lensWidth: 51, bridgeWidth: 22, templeLength: 145,
      lensType: "polarized", frameMaterial: "acetate",
    });

    expect(html).toContain("<p>First paragraph here.</p>");
    expect(html).toContain("<p>Second paragraph here.</p>");
    expect(html).toContain("<h3>Frame Measurements</h3>");
    expect(html).toContain("<li>Lens width: 51 mm</li>");
    expect(html).toContain("<h3>Features</h3>");
    expect(html).toContain("Polarized");
    expect(html).toContain("Acetate frame");
  });

  it("skips null dimensions", () => {
    const html = buildBodyHtml({
      productName: "X",
      frameShape: "round",
      styleTags: [],
      gender: "unisex",
      lensWidth: 51, bridgeWidth: 22, templeLength: null,
      lensType: "uv400", frameMaterial: "metal",
    });
    expect(html).toContain("<li>Lens width: 51 mm</li>");
    expect(html).not.toContain("Temple length");
    expect(html).toContain("UV400 protection");
  });

  it("returns empty string when there's nothing to render", () => {
    const html = buildBodyHtml({
      productName: "X",
      frameShape: null,
      styleTags: [],
      gender: null,
    });
    expect(html).toBe("");
  });

  it("escapes HTML in prose paragraphs", () => {
    const html = buildBodyHtml({
      productName: "X",
      frameShape: "round",
      styleTags: [],
      gender: "unisex",
      description: "Has <script>alert('xss')</script> & ampersands.",
    });
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp; ampersands");
    expect(html).not.toContain("<script>");
  });
});

// ──────────────────────────────────────────────────────────────────
// buildVariantTitle
// ──────────────────────────────────────────────────────────────────

describe("buildVariantTitle", () => {
  it("two-axis: frame + lens", () => {
    expect(buildVariantTitle("Black", "Black")).toBe("Black Frame / Black Lens");
    expect(buildVariantTitle("tortoise", "green")).toBe("Tortoise Frame / Green Lens");
  });

  it("falls back to frame-only when lens missing", () => {
    expect(buildVariantTitle("Black", null)).toBe("Black Frame");
    expect(buildVariantTitle("Sand", "")).toBe("Sand Frame");
  });

  it("parses legacy slash-form colorName when no lens column", () => {
    expect(buildVariantTitle("Tort/Green", null)).toBe("Tort Frame / Green Lens");
    expect(buildVariantTitle("Black/Brown", undefined)).toBe("Black Frame / Brown Lens");
  });

  it("explicit lens column wins over legacy slash-form parsing", () => {
    // When `lensColor` is set, the frame string is kept verbatim (with
    // first-letter title casing). The slash stays — operators using both
    // the new `lensColorName` column AND a legacy slash-form colorName
    // is the unusual case; we don't try to be clever. Importer in Phase
    // 3 + future PO imports should populate lens_color_name cleanly.
    expect(buildVariantTitle("Tort/Green", "Amber")).toBe(
      "Tort/green Frame / Amber Lens",
    );
  });

  it("Shopify-fallback when frame missing", () => {
    expect(buildVariantTitle(null, "Brown")).toBe("Default Title");
    expect(buildVariantTitle("", null)).toBe("Default Title");
  });
});
