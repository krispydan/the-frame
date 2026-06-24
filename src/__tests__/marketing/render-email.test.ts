/**
 * Render ("printing") engine smoke + regression tests.
 *
 * Guards the email HTML renderer (src/modules/marketing/lib/render-email.ts),
 * the code that turns a campaign into the HTML the preview iframe shows and
 * the client-side image export rasterizes.
 *
 * Born from the 2026-06-24 render audit (docs/marketing-email/
 * PRINT-ENGINE-ASSESSMENT.md), which found a critical bug: font stacks
 * with double quotes were interpolated into double-quoted style="…"
 * attributes, so the HTML parser terminated each style at `font-family:`
 * and silently dropped every later declaration (font-size/color on
 * headlines, padding/border-radius on CTA pills). These tests parse the
 * output with jsdom — the same WHATWG model a browser uses — so a
 * regression is caught at the parser level, not by eyeballing.
 */
import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import {
  renderEmailHtml,
  renderSectionHtml,
  type SectionKind,
} from "@/modules/marketing/lib/render-email";
import type { CampaignData } from "@/modules/marketing/lib/email-template-types";

const HERO_VARIANTS: CampaignData["heroVariant"][] = [
  "full_bleed_overlay",
  "image_75_solid",
  "split_50_50",
];
const SECTION_A_VARIANTS: CampaignData["sectionAVariant"][] = ["centered", "with_pullquote"];
const SECONDARY_VARIANTS: CampaignData["secondaryImageVariant"][] = [
  "full_bleed",
  "centered_75",
  "grid_2up",
];
const SECTION_B_VARIANTS: CampaignData["sectionBVariant"][] = [
  "centered_with_cta",
  "two_column_with_cta",
];

function base(overrides: Partial<CampaignData> = {}): CampaignData {
  return {
    heroVariant: "full_bleed_overlay",
    heroScrim: "dark",
    heroImagePath: "marketing/hero.jpg",
    heroImageAlt: "A model wearing readers",
    heroHeadline: "The honey colorway is back",
    heroSubtitle: "Warm amber tortoise, limited run for fall.",
    heroCtaLabel: "Shop honey",
    heroCtaUrl: "https://getjaxy.com/honey",
    sectionAVariant: "centered",
    sectionAHeading: "Why people keep coming back",
    sectionABody:
      "Lightweight acetate that doesn't pinch. Lenses that cut the glare. A fit that holds up all day long.",
    secondaryImageVariant: "full_bleed",
    secondaryImagePath: "marketing/detail.jpg",
    secondaryImageAlt: "Close-up of the temple detail",
    secondaryImagePath2: "marketing/detail2.jpg",
    secondaryImageAlt2: "Second colorway",
    sectionBVariant: "centered_with_cta",
    sectionBHeading: "Find your strength",
    sectionBBody: "Take the 30-second fit quiz.\n\nFree shipping both ways, always.",
    sectionBCtaLabel: "Take the quiz",
    sectionBCtaUrl: "https://getjaxy.com/quiz",
    ...overrides,
  };
}

/** Count the truncation signature: a closed style attribute immediately
 *  followed by a letter (the spilled CSS the parser turns into attrs). */
function truncationSignatures(html: string): number {
  return (html.match(/style="[^"]*"[A-Za-z]/g) || []).length;
}

/** Parse and return the <body> element via jsdom. */
function parse(html: string) {
  return new JSDOM(html).window.document;
}

describe("render-email — critical: inline styles are never truncated", () => {
  it("uses single-quoted font stacks (no double-quote can break a style attr)", () => {
    const html = renderEmailHtml(base());
    expect(html).not.toContain(`font-family:"`); // double quote = truncation bug
    expect(html).toContain(`font-family:'`); // single quote = safe
  });

  it("produces zero truncation signatures across every variant combination", () => {
    for (const heroVariant of HERO_VARIANTS) {
      for (const sectionAVariant of SECTION_A_VARIANTS) {
        for (const secondaryImageVariant of SECONDARY_VARIANTS) {
          for (const sectionBVariant of SECTION_B_VARIANTS) {
            const html = renderEmailHtml(
              base({ heroVariant, sectionAVariant, secondaryImageVariant, sectionBVariant }),
            );
            expect(
              truncationSignatures(html),
              `truncation in ${heroVariant}/${sectionAVariant}/${secondaryImageVariant}/${sectionBVariant}`,
            ).toBe(0);
          }
        }
      }
    }
  });

  it("keeps the hero <h1> style fully intact after a real parser sees it", () => {
    const doc = parse(renderEmailHtml(base()));
    const h1 = doc.querySelector("h1.jx-hero-headline")!;
    // The bug spilled the dropped CSS into ~13 stray attributes; a clean
    // parse has exactly class + style.
    expect(h1.getAttributeNames().sort()).toEqual(["class", "style"]);
    const style = h1.getAttribute("style") ?? "";
    expect(style).toContain("font-size:44px");
    expect(style).toContain("color:#FFFDF0");
    expect(style).toContain("margin:");
  });

  it("keeps the CTA pill's padding + border-radius after parsing", () => {
    const doc = parse(renderEmailHtml(base()));
    const cta = doc.querySelector("a.jx-cta-pill")!;
    expect(cta.getAttributeNames().sort()).toEqual(["class", "href", "style"]);
    const style = cta.getAttribute("style") ?? "";
    expect(style).toContain("padding:13px 28px");
    expect(style).toContain("border-radius:999px");
  });
});

describe("render-email — CTAs never render dead", () => {
  it("omits the hero CTA when the URL is missing", () => {
    const doc = parse(renderEmailHtml(base({ heroCtaUrl: null, heroCtaLabel: null })));
    // Only the section-B CTA (which has a URL) should remain.
    const ctas = doc.querySelectorAll("a.jx-cta-pill");
    expect(ctas.length).toBe(1);
    expect(ctas[0].getAttribute("href")).toBe("https://getjaxy.com/quiz");
  });

  it('omits a CTA whose URL is just "#"', () => {
    const doc = parse(renderEmailHtml(base({ heroCtaUrl: "#", sectionBCtaUrl: "#" })));
    expect(doc.querySelectorAll("a.jx-cta-pill").length).toBe(0);
  });

  it("never emits an anchor pointing at #", () => {
    const html = renderEmailHtml(base({ heroCtaUrl: "", sectionBCtaUrl: "" }));
    expect(html).not.toContain('href="#"');
  });
});

describe("render-email — pullquote layout degrades gracefully", () => {
  it("falls back to centered on a single-sentence body (no lone floating quote)", () => {
    const html = renderEmailHtml(
      base({ sectionAVariant: "with_pullquote", sectionABody: "Everything is on sale." }),
    );
    expect(html).not.toContain("&ldquo;"); // no pull-quote glyphs
  });

  it("renders a pull quote WITH supporting copy on a multi-sentence body", () => {
    const html = renderEmailHtml(
      base({
        sectionAVariant: "with_pullquote",
        sectionABody:
          "Short opener. This is comfortably the longest sentence and makes a great pull quote. A closing line.",
      }),
    );
    expect(html).toContain("&ldquo;");
    expect(html).toContain("&rdquo;");
    // The quote is the longest sentence…
    expect(html).toContain("comfortably the longest sentence");
    // …and the remaining sentences still appear as supporting body copy.
    expect(html).toContain("Short opener.");
  });
});

describe("render-email — section visibility", () => {
  it("omits a disabled section entirely", () => {
    const html = renderEmailHtml(
      base({ secondaryDisabled: true, secondaryImagePath: "marketing/should-not-render.jpg" }),
    );
    expect(html).not.toContain("should-not-render");
  });

  it("renders all four blocks when none are disabled", () => {
    const html = renderEmailHtml(base());
    expect(html).toContain("marketing/hero.jpg");
    expect(html).toContain("Why people keep coming back");
    expect(html).toContain("marketing/detail.jpg");
    expect(html).toContain("Find your strength");
  });
});

describe("render-email — copy is always HTML-escaped", () => {
  it("escapes angle brackets, ampersands and quotes in copy + alt text", () => {
    const html = renderEmailHtml(
      base({
        heroHeadline: "Sale: glasses & <readers> this weekend",
        heroImageAlt: 'The "big" sale & more',
      }),
    );
    expect(html).toContain("glasses &amp; &lt;readers&gt;");
    expect(html).toContain("&quot;big&quot; sale &amp; more");
    // The raw, unescaped forms must NOT appear in text content.
    expect(html).not.toContain("<readers>");
  });
});

describe("render-email — full-bleed hero legibility", () => {
  it("vertically centers the overlay content", () => {
    const html = renderEmailHtml(base({ heroVariant: "full_bleed_overlay" }));
    expect(html).toContain("vertical-align:middle");
  });

  it("always shadows text that sits over an image, even with scrim none", () => {
    const html = renderEmailHtml(
      base({ heroVariant: "full_bleed_overlay", heroScrim: "none", heroImagePath: "marketing/hero.jpg" }),
    );
    expect(html).toContain("text-shadow:0 1px 3px");
  });
});

describe("render-email — structural integrity", () => {
  it("emits a valid document shell with balanced tables for every combo", () => {
    for (const heroVariant of HERO_VARIANTS) {
      for (const secondaryImageVariant of SECONDARY_VARIANTS) {
        const html = renderEmailHtml(base({ heroVariant, secondaryImageVariant }));
        expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
        expect(html).toContain('name="viewport"');
        expect((html.match(/<table\b/g) || []).length).toBe((html.match(/<\/table>/g) || []).length);
        expect((html.match(/<tr\b/g) || []).length).toBe((html.match(/<\/tr>/g) || []).length);
      }
    }
  });

  it("entity-encodes the ampersands in the Google Fonts URL", () => {
    const html = renderEmailHtml(base());
    expect(html).toContain("&amp;family=Syne");
    expect(html).not.toContain("700&family=Syne"); // raw & would be malformed
  });
});

describe("render-email — section export shell", () => {
  it("renders each section in isolation without truncation", () => {
    const kinds: SectionKind[] = ["hero", "sectionA", "secondary", "sectionB"];
    for (const kind of kinds) {
      const html = renderSectionHtml(base(), kind);
      expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
      expect(truncationSignatures(html)).toBe(0);
      expect(html).not.toContain(`font-family:"`);
    }
  });
});
