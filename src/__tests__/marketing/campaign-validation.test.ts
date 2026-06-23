import { describe, it, expect } from "vitest";
import { validateCampaignPatch } from "@/modules/marketing/lib/campaign-validation";

describe("campaign write-time validation", () => {
  it("accepts a valid patch", () => {
    expect(
      validateCampaignPatch({
        heroVariant: "split_50_50",
        heroScrim: "light",
        heroCtaUrl: "https://getjaxy.com/x",
        scheduledDate: "2026-07-06",
      }),
    ).toHaveLength(0);
  });

  it("rejects an invalid enum value", () => {
    const e = validateCampaignPatch({ heroVariant: "banana" });
    expect(e.length).toBe(1);
    expect(e[0]).toContain("heroVariant");
  });

  it("rejects a non-http CTA url but allows empty / #", () => {
    expect(validateCampaignPatch({ heroCtaUrl: "javascript:alert(1)" }).length).toBe(1);
    expect(validateCampaignPatch({ heroCtaUrl: "" })).toHaveLength(0);
    expect(validateCampaignPatch({ sectionBCtaUrl: "#" })).toHaveLength(0);
  });

  it("rejects a malformed scheduledDate", () => {
    expect(validateCampaignPatch({ scheduledDate: "07/06/2026" }).length).toBe(1);
  });

  it("rejects pathologically long fields", () => {
    expect(validateCampaignPatch({ subject: "x".repeat(200) }).length).toBe(1);
  });

  it("ignores fields it doesn't govern", () => {
    expect(validateCampaignPatch({ heroHeadline: "Back in honey", designerNotes: "anything" })).toHaveLength(0);
  });
});
