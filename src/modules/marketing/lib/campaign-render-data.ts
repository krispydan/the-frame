/**
 * Map a marketing_email_campaigns row to the renderer's CampaignData.
 * Single source of truth for the field mapping — the preview route and
 * the Omnisend push both render from this, so a newly added render field
 * (e.g. heroTextPlacement) can't silently go missing in one consumer
 * (which is exactly what happened before this was extracted).
 */
import type { emailCampaigns } from "@/modules/marketing/schema";
import type { CampaignData } from "./email-template-types";

type CampaignRow = typeof emailCampaigns.$inferSelect;

export function campaignRowToData(row: CampaignRow): CampaignData {
  return {
    logoImagePath: row.logoImagePath,
    heroDisabled: row.heroDisabled,
    sectionADisabled: row.sectionADisabled,
    secondaryDisabled: row.secondaryDisabled,
    sectionBDisabled: row.sectionBDisabled,
    heroVariant: row.heroVariant as CampaignData["heroVariant"],
    heroImagePath: row.heroImagePath,
    heroImageAlt: row.heroImageAlt,
    heroHeadline: row.heroHeadline,
    heroSubtitle: row.heroSubtitle,
    heroCtaLabel: row.heroCtaLabel,
    heroCtaUrl: row.heroCtaUrl,
    heroScrim: row.heroScrim as CampaignData["heroScrim"],
    heroTextPlacement: row.heroTextPlacement as CampaignData["heroTextPlacement"],
    heroImageFocal: row.heroImageFocal,
    sectionAVariant: row.sectionAVariant as CampaignData["sectionAVariant"],
    sectionAHeading: row.sectionAHeading,
    sectionABody: row.sectionABody,
    secondaryImageVariant: row.secondaryImageVariant as CampaignData["secondaryImageVariant"],
    secondaryImagePath: row.secondaryImagePath,
    secondaryImagePath2: row.secondaryImagePath2,
    secondaryImageAlt: row.secondaryImageAlt,
    secondaryImageAlt2: row.secondaryImageAlt2,
    sectionBVariant: row.sectionBVariant as CampaignData["sectionBVariant"],
    sectionBHeading: row.sectionBHeading,
    sectionBBody: row.sectionBBody,
    sectionBCtaLabel: row.sectionBCtaLabel,
    sectionBCtaUrl: row.sectionBCtaUrl,
  };
}
