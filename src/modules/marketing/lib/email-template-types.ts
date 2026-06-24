/**
 * Shared template types — the single source of truth for the shape of
 * data the email renderer + exporters consume.
 *
 * Previously this type lived inside a React component tree
 * (components/email-template/index.tsx). That tree was dead — Next 16 +
 * Turbopack rejected react-dom/server, so the string-template renderer
 * in lib/render-email.ts is what actually runs, and only this *type*
 * was imported from the tree. Moving it here lets the dead tree be
 * deleted and keeps exactly one definition.
 */

export interface CampaignData {
  // Per-campaign logo override (default = brand logo SVG)
  logoImagePath?: string | null;

  // Section visibility — true skips that block
  heroDisabled?: boolean | null;
  sectionADisabled?: boolean | null;
  secondaryDisabled?: boolean | null;
  sectionBDisabled?: boolean | null;

  // Hero
  heroVariant: "full_bleed_overlay" | "image_75_solid" | "split_50_50";
  heroImagePath?: string | null;
  heroImageAlt?: string | null;
  heroHeadline?: string | null;
  heroSubtitle?: string | null;
  heroCtaLabel?: string | null;
  heroCtaUrl?: string | null;
  heroScrim?: "dark" | "light" | "none" | null;

  // Section A
  sectionAVariant: "centered" | "with_pullquote";
  sectionAHeading?: string | null;
  sectionABody?: string | null;

  // Secondary image
  secondaryImageVariant: "full_bleed" | "centered_75" | "grid_2up";
  secondaryImagePath?: string | null;
  secondaryImagePath2?: string | null;
  secondaryImageAlt?: string | null;
  secondaryImageAlt2?: string | null;

  // Section B
  sectionBVariant: "centered_with_cta" | "two_column_with_cta";
  sectionBHeading?: string | null;
  sectionBBody?: string | null;
  sectionBCtaLabel?: string | null;
  sectionBCtaUrl?: string | null;
}
