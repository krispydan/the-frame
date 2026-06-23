import { describe, it, expect } from "vitest";
import { lintCopy, lintGeneratedCopy, type LintableCopy } from "@/modules/marketing/lib/copy-quality";

const clean: LintableCopy = {
  subject: "the Sunday Drive is back",
  preheader: "Three honey-toned frames for your slow mornings and the long way home",
  heroHeadline: "Back in your favorite honey",
  heroSubtitle: "You asked, so here you are.",
  heroCtaLabel: "Shop the drive",
  heroCtaUrl: "https://getjaxy.com/sunday-drive",
  sectionAHeading: "for your golden hour",
  sectionABody:
    "You know the feeling when the light goes amber and everything slows down. " +
    "These frames were made for that exact moment — when you want to look like " +
    "yourself, only easier. Slip them on for the porch, the drive, the walk you " +
    "keep meaning to take. They go where you go.",
  sectionBHeading: "your three to choose from",
  sectionBBody:
    "Honey is the one everyone reaches for first, warm and a little nostalgic. " +
    "If you lean cooler, the slate keeps things calm and quiet. And the classic " +
    "tortoise still does what it always has, which is go with everything you own. " +
    "Pick the one that sounds the most like your week, or grab the pair you keep " +
    "coming back to. Either way, you will reach for them daily.",
  sectionBCtaLabel: "See all three",
  sectionBCtaUrl: "https://getjaxy.com/collections/sunday-drive",
};

describe("copy-quality linter", () => {
  it("passes clean retail copy with no errors", () => {
    const r = lintCopy(clean, "retail");
    expect(r.errors, JSON.stringify(r.errors)).toHaveLength(0);
    expect(r.ok).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(90);
  });

  it("flags banned brand phrases", () => {
    const r = lintCopy({ ...clean, sectionABody: "Our curated, premium collection will elevate your look." }, "retail");
    const codes = r.errors.map((e) => e.code);
    expect(codes).toContain("banned_phrase");
    expect(r.ok).toBe(false);
  });

  it("flags an over-long subject", () => {
    const r = lintCopy({ ...clean, subject: "this subject line is definitely far too long for any inbox to show" }, "retail");
    expect(r.errors.map((e) => e.code)).toContain("subject_too_long");
  });

  it("flags cliché subject openers", () => {
    const r = lintCopy({ ...clean, subject: "Introducing the new drive" }, "retail");
    expect(r.errors.map((e) => e.code)).toContain("subject_cliche_opener");
  });

  it("flags emoji", () => {
    const r = lintCopy({ ...clean, heroHeadline: "back in honey 😎" }, "retail");
    expect(r.errors.map((e) => e.code)).toContain("emoji");
  });

  it("flags more than one exclamation mark", () => {
    const r = lintCopy({ ...clean, heroSubtitle: "You asked! So here you are!" }, "retail");
    expect(r.errors.map((e) => e.code)).toContain("too_many_exclamations");
  });

  it("flags a preheader that duplicates the subject", () => {
    const r = lintCopy({ ...clean, preheader: clean.subject! }, "retail");
    expect(r.errors.map((e) => e.code)).toContain("preheader_dupes_subject");
  });

  it("flags a hero headline over six words", () => {
    const r = lintCopy({ ...clean, heroHeadline: "this hero headline is way too many words long" }, "retail");
    expect(r.errors.map((e) => e.code)).toContain("hero_headline_long");
  });

  it("flags an ALL CAPS cta label", () => {
    const r = lintCopy({ ...clean, heroCtaLabel: "SHOP NOW" }, "retail");
    expect(r.errors.map((e) => e.code)).toContain("cta_all_caps");
  });

  it("flags an invalid cta url", () => {
    const r = lintCopy({ ...clean, heroCtaUrl: "not-a-url" }, "retail");
    expect(r.errors.map((e) => e.code)).toContain("cta_url_invalid");
  });

  it("warns when wholesale copy has no number", () => {
    const noNumber: LintableCopy = {
      ...clean,
      subject: "what is moving at stores like yours",
      preheader: "the frames boutique buyers keep reordering this season for their floors",
      sectionABody: "Buyers like you keep reaching for these. Your customers respond to warm, wearable frames they can style a dozen ways. Put them on your floor and watch them move.",
      sectionBBody: "These are the frames that earn their spot in your case. They photograph well, they fit a lot of faces, and your shoppers find them approachable. Reorder the ones that go, skip the ones that do not, and keep your mix tight. Your floor, your call.",
    };
    const r = lintCopy(noNumber, "wholesale");
    expect(r.warnings.map((w) => w.code)).toContain("wholesale_no_number");
  });

  it("maps generated-copy field names (heroCtaUrlSuggestion)", () => {
    const r = lintGeneratedCopy(
      { subject: clean.subject, heroCtaUrlSuggestion: "not-a-url", heroHeadline: clean.heroHeadline },
      "retail",
    );
    expect(r.errors.map((e) => e.code)).toContain("cta_url_invalid");
  });
});
