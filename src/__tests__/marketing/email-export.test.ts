import { describe, it, expect } from "vitest";
import {
  buildOmnisendHtml,
  buildFaireBlocks,
  exportReadiness,
  toExportable,
  type ExportableCampaign,
} from "@/modules/marketing/lib/email-export";

function full(): ExportableCampaign {
  return {
    subject: "the Sunday Drive is back",
    preheader: "three honey-toned frames for your slow mornings",
    audience: "retail",
    scheduledDate: "2026-07-06",
    utmCampaign: "2026-w28-retail",
    heroVariant: "full_bleed_overlay",
    heroImagePath: "email/x/hero.jpg",
    heroImageAlt: "honey frames on linen",
    heroHeadline: "Back in honey",
    heroSubtitle: "Three new colorways.",
    heroCtaLabel: "Shop the drive",
    heroCtaUrl: "https://getjaxy.com/x",
    heroScrim: "dark",
    sectionAVariant: "centered",
    sectionAHeading: "for golden hour",
    sectionABody: "You know the feeling.",
    secondaryImageVariant: "full_bleed",
    secondaryImagePath: "email/x/secondary.jpg",
    secondaryImageAlt: "on the porch",
    sectionBVariant: "centered_with_cta",
    sectionBHeading: "your three",
    sectionBBody: "Honey, slate, tortoise.",
    sectionBCtaLabel: "See all three",
    sectionBCtaUrl: "https://getjaxy.com/all",
  };
}

describe("email export — Omnisend", () => {
  it("produces a complete, client-hardened HTML document", () => {
    const html = buildOmnisendHtml(full());
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("Back in honey");
    expect(html).toContain("[if mso]"); // hardened
    expect(html).toContain("the Sunday Drive is back".length > 0 ? "honey-toned" : ""); // preheader injected
  });
});

describe("email export — Faire", () => {
  it("returns subject, preheader, ordered blocks, and plain text", () => {
    const f = buildFaireBlocks(full());
    expect(f.subject).toBe("the Sunday Drive is back");
    expect(f.preheader).toContain("honey-toned");
    expect(f.blocks.map((b) => b.type)).toEqual(["hero", "text", "image", "text_cta"]);
    expect(f.plainText).toContain("# Back in honey");
    expect(f.plainText).toContain("[Shop the drive]");
  });

  it("includes both grid images in the image block", () => {
    const f = buildFaireBlocks({
      ...full(),
      secondaryImageVariant: "grid_2up",
      secondaryImagePath2: "email/x/secondary2.jpg",
    });
    const imageBlock = f.blocks.find((b) => b.type === "image");
    expect(imageBlock && imageBlock.type === "image" && imageBlock.imageUrls.length).toBe(2);
  });
});

describe("export readiness", () => {
  it("is ready when all required fields + images exist", () => {
    expect(exportReadiness(full()).ready).toBe(true);
  });

  it("lists what's missing", () => {
    const r = exportReadiness({ ...full(), heroImagePath: null, subject: null });
    expect(r.ready).toBe(false);
    expect(r.missing).toContain("hero image");
    expect(r.missing).toContain("subject");
  });

  it("requires the second grid image for grid_2up", () => {
    const r = exportReadiness({ ...full(), secondaryImageVariant: "grid_2up", secondaryImagePath2: null });
    expect(r.missing).toContain("secondary image 2");
  });
});

describe("toExportable", () => {
  it("maps a row-shaped object with sensible defaults", () => {
    const c = toExportable({ subject: "hi", heroVariant: "split_50_50" });
    expect(c.subject).toBe("hi");
    expect(c.heroVariant).toBe("split_50_50");
    expect(c.secondaryImageVariant).toBe("full_bleed"); // default
  });
});
