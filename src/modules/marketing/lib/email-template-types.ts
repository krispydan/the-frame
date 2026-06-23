/**
 * Shared template types — the single source of truth for the shape of
 * data the email renderer + exporter consume.
 *
 * Previously this type lived inside the (now-deleted) React component
 * tree at components/email-template/index.tsx. The React renderer was
 * dead code (Next 16 + Turbopack rejected react-dom/server, so the
 * string-template renderer in lib/render-email.ts is what actually
 * runs). Keeping the type here means there is exactly one definition
 * and no dependency on a rendering framework.
 */

export type HeroVariant = "full_bleed_overlay" | "image_75_solid" | "split_50_50";
export type SectionAVariant = "centered" | "with_pullquote";
export type SecondaryVariant = "full_bleed" | "centered_75" | "grid_2up";
export type SectionBVariant = "centered_with_cta" | "two_column_with_cta";
export type Scrim = "dark" | "light" | "none";
export type Audience = "retail" | "wholesale";

/**
 * The in-template content for one campaign. Note: subject + preheader
 * are inbox metadata (not rendered inside the body) so they live on the
 * campaign row but not here — the renderer only needs what paints.
 */
export interface CampaignData {
  // Hero
  heroVariant: HeroVariant;
  heroImagePath?: string | null;
  heroImageAlt?: string | null;
  heroHeadline?: string | null;
  heroSubtitle?: string | null;
  heroCtaLabel?: string | null;
  heroCtaUrl?: string | null;
  heroScrim?: Scrim | null;

  // Section A
  sectionAVariant: SectionAVariant;
  sectionAHeading?: string | null;
  sectionABody?: string | null;

  // Secondary image
  secondaryImageVariant: SecondaryVariant;
  secondaryImagePath?: string | null;
  secondaryImagePath2?: string | null;
  secondaryImageAlt?: string | null;
  secondaryImageAlt2?: string | null;

  // Section B
  sectionBVariant: SectionBVariant;
  sectionBHeading?: string | null;
  sectionBBody?: string | null;
  sectionBCtaLabel?: string | null;
  sectionBCtaUrl?: string | null;
}
