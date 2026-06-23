import { describe, it, expect } from "vitest";
import { renderEmailHtml } from "@/modules/marketing/lib/render-email";
import type { CampaignData } from "@/modules/marketing/lib/email-template-types";

function base(overrides: Partial<CampaignData> = {}): CampaignData {
  return {
    heroVariant: "full_bleed_overlay",
    heroHeadline: "Back in honey",
    heroSubtitle: "Three new colorways.",
    heroCtaLabel: "Shop the drive",
    heroCtaUrl: "https://getjaxy.com/x",
    heroScrim: "dark",
    sectionAVariant: "centered",
    sectionAHeading: "for golden hour",
    sectionABody: "You know the feeling.",
    secondaryImageVariant: "full_bleed",
    sectionBVariant: "centered_with_cta",
    sectionBHeading: "your three",
    sectionBBody: "Honey, slate, tortoise.",
    sectionBCtaLabel: "See all three",
    sectionBCtaUrl: "https://getjaxy.com/all",
    ...overrides,
  };
}

describe("render-email (preview)", () => {
  it("renders a full HTML document with the logo", () => {
    const html = renderEmailHtml(base());
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain(">Jaxy<");
    expect(html).toContain("Back in honey");
  });

  it("applies the dark scrim gradient on full_bleed_overlay", () => {
    const html = renderEmailHtml(base({ heroScrim: "dark", heroImagePath: "email/x/hero.jpg" }));
    expect(html).toContain("rgba(0,0,0,0.45)");
  });

  it("omits the scrim gradient when scrim is none", () => {
    const html = renderEmailHtml(base({ heroScrim: "none", heroImagePath: "email/x/hero.jpg" }));
    expect(html).not.toContain("rgba(0,0,0,0.45)");
  });

  it("HTML-escapes user content", () => {
    const html = renderEmailHtml(base({ heroHeadline: "<script>alert(1)</script>" }));
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("transforms stored image paths into URLs", () => {
    const html = renderEmailHtml(base({ heroVariant: "image_75_solid", heroImagePath: "email/abc/hero.jpg" }));
    expect(html).toContain("email/abc/hero.jpg");
  });

  it("shows a placeholder block when an image is missing", () => {
    const html = renderEmailHtml(base({ heroVariant: "image_75_solid", heroImagePath: null }));
    expect(html).toContain("hero image");
  });

  it("renders every hero variant without throwing", () => {
    for (const v of ["full_bleed_overlay", "image_75_solid", "split_50_50"] as const) {
      const html = renderEmailHtml(base({ heroVariant: v }));
      expect(html.length).toBeGreaterThan(500);
    }
  });

  it("renders the grid_2up secondary with two cells", () => {
    const html = renderEmailHtml(
      base({ secondaryImageVariant: "grid_2up", secondaryImagePath: "email/x/s1.jpg", secondaryImagePath2: "email/x/s2.jpg" }),
    );
    expect(html).toContain("email/x/s1.jpg");
    expect(html).toContain("email/x/s2.jpg");
  });

  it("does not include Outlook conditionals in preview mode", () => {
    const html = renderEmailHtml(base());
    expect(html).not.toContain("[if mso]");
  });
});

describe("render-email (export)", () => {
  it("adds mso conditionals and a bulletproof VML button", () => {
    const html = renderEmailHtml(base(), { target: "export" });
    expect(html).toContain("[if mso]");
    expect(html).toContain("v:roundrect");
    expect(html).toContain("PixelsPerInch");
  });

  it("adds a VML hero background when an image is present", () => {
    const html = renderEmailHtml(base({ heroImagePath: "email/x/hero.jpg" }), { target: "export" });
    expect(html).toContain("v:rect");
    expect(html).toContain("v:fill");
  });

  it("injects hidden preheader preview text", () => {
    const html = renderEmailHtml(base(), { target: "export", preheader: "secret preview line" });
    expect(html).toContain("secret preview line");
    expect(html).toContain("display:none");
  });
});
