/**
 * Export — turn a campaign row into something pasteable into the real
 * sending platforms. This is the step that was missing: without it the
 * pipeline never reaches an inbox.
 *
 *   - Omnisend → a standalone, client-hardened HTML document. Paste
 *     into Omnisend's "import HTML" / custom-code block.
 *   - Faire   → structured JSON blocks + a flattened plain-text body,
 *     since Faire's email builder is block-based copy/paste (no HTML
 *     import).
 */

import { renderEmailHtml } from "./render-email";
import { catalogImageUrl } from "@/lib/storage/image-url";
import type { CampaignData } from "./email-template-types";

/** The campaign fields export needs — a structural subset of the row. */
export interface ExportableCampaign extends CampaignData {
  subject?: string | null;
  preheader?: string | null;
  audience?: string | null;
  scheduledDate?: string | null;
  utmCampaign?: string | null;
}

/** Map a DB row (snake or camel via Drizzle) to the export shape. */
export function toExportable(row: Record<string, unknown>): ExportableCampaign {
  const g = (k: string) => (row[k] ?? null) as string | null;
  return {
    subject: g("subject"),
    preheader: g("preheader"),
    audience: g("audience"),
    scheduledDate: g("scheduledDate"),
    utmCampaign: g("utmCampaign"),
    heroVariant: (g("heroVariant") ?? "full_bleed_overlay") as CampaignData["heroVariant"],
    heroImagePath: g("heroImagePath"),
    heroImageAlt: g("heroImageAlt"),
    heroHeadline: g("heroHeadline"),
    heroSubtitle: g("heroSubtitle"),
    heroCtaLabel: g("heroCtaLabel"),
    heroCtaUrl: g("heroCtaUrl"),
    heroScrim: (g("heroScrim") ?? "dark") as CampaignData["heroScrim"],
    sectionAVariant: (g("sectionAVariant") ?? "centered") as CampaignData["sectionAVariant"],
    sectionAHeading: g("sectionAHeading"),
    sectionABody: g("sectionABody"),
    secondaryImageVariant: (g("secondaryImageVariant") ?? "full_bleed") as CampaignData["secondaryImageVariant"],
    secondaryImagePath: g("secondaryImagePath"),
    secondaryImagePath2: g("secondaryImagePath2"),
    secondaryImageAlt: g("secondaryImageAlt"),
    secondaryImageAlt2: g("secondaryImageAlt2"),
    sectionBVariant: (g("sectionBVariant") ?? "centered_with_cta") as CampaignData["sectionBVariant"],
    sectionBHeading: g("sectionBHeading"),
    sectionBBody: g("sectionBBody"),
    sectionBCtaLabel: g("sectionBCtaLabel"),
    sectionBCtaUrl: g("sectionBCtaUrl"),
  };
}

/** Full standalone HTML for Omnisend. */
export function buildOmnisendHtml(c: ExportableCampaign): string {
  return renderEmailHtml(c, { target: "export", preheader: c.preheader });
}

// ── Faire block model ───────────────────────────────────────────

export type FaireBlock =
  | { type: "hero"; headline: string; subtitle: string; ctaLabel: string; ctaUrl: string; imageUrl: string | null; imageAlt: string }
  | { type: "text"; heading: string; body: string }
  | { type: "image"; imageUrls: string[]; alt: string }
  | { type: "text_cta"; heading: string; body: string; ctaLabel: string; ctaUrl: string };

export interface FaireExport {
  subject: string;
  preheader: string;
  blocks: FaireBlock[];
  /** Flattened, paste-ready plain text of the whole email. */
  plainText: string;
}

function url(p: string | null | undefined): string | null {
  return p ? catalogImageUrl(p) : null;
}

export function buildFaireBlocks(c: ExportableCampaign): FaireExport {
  const blocks: FaireBlock[] = [];

  blocks.push({
    type: "hero",
    headline: c.heroHeadline ?? "",
    subtitle: c.heroSubtitle ?? "",
    ctaLabel: c.heroCtaLabel ?? "",
    ctaUrl: c.heroCtaUrl ?? "",
    imageUrl: url(c.heroImagePath),
    imageAlt: c.heroImageAlt ?? "",
  });

  blocks.push({
    type: "text",
    heading: c.sectionAHeading ?? "",
    body: c.sectionABody ?? "",
  });

  const secondaryUrls = [url(c.secondaryImagePath), url(c.secondaryImagePath2)].filter(
    (u): u is string => !!u,
  );
  blocks.push({
    type: "image",
    imageUrls: secondaryUrls,
    alt: c.secondaryImageAlt ?? "",
  });

  blocks.push({
    type: "text_cta",
    heading: c.sectionBHeading ?? "",
    body: c.sectionBBody ?? "",
    ctaLabel: c.sectionBCtaLabel ?? "",
    ctaUrl: c.sectionBCtaUrl ?? "",
  });

  const plainText = [
    `SUBJECT: ${c.subject ?? ""}`,
    `PREHEADER: ${c.preheader ?? ""}`,
    "",
    `# ${c.heroHeadline ?? ""}`,
    c.heroSubtitle ?? "",
    c.heroCtaLabel ? `[${c.heroCtaLabel}] → ${c.heroCtaUrl ?? ""}` : "",
    "",
    c.sectionAHeading ? `## ${c.sectionAHeading}` : "",
    c.sectionABody ?? "",
    "",
    secondaryUrls.length ? `[image: ${secondaryUrls.join(", ")}]` : "",
    "",
    c.sectionBHeading ? `## ${c.sectionBHeading}` : "",
    c.sectionBBody ?? "",
    c.sectionBCtaLabel ? `[${c.sectionBCtaLabel}] → ${c.sectionBCtaUrl ?? ""}` : "",
  ]
    .filter((l) => l !== "")
    .join("\n");

  return {
    subject: c.subject ?? "",
    preheader: c.preheader ?? "",
    blocks,
    plainText,
  };
}

/**
 * Pre-export readiness check — what's missing before this should go to
 * a platform. Non-blocking (caller decides), but surfaced to the user.
 */
export function exportReadiness(c: ExportableCampaign): { ready: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!c.subject) missing.push("subject");
  if (!c.heroHeadline) missing.push("hero headline");
  if (!c.sectionABody) missing.push("section A body");
  if (!c.sectionBBody) missing.push("section B body");
  if (!c.heroImagePath) missing.push("hero image");
  if (!c.secondaryImagePath) missing.push("secondary image");
  if (c.secondaryImageVariant === "grid_2up" && !c.secondaryImagePath2)
    missing.push("secondary image 2");
  return { ready: missing.length === 0, missing };
}
