export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { emailCampaigns } from "@/modules/marketing/schema";
import { eq } from "drizzle-orm";
import type { CampaignData } from "@/modules/marketing/lib/email-template-types";
import { renderEmailHtml } from "@/modules/marketing/lib/render-email";

/**
 * GET /api/v1/marketing/email/campaigns/[id]/preview
 *
 * Returns the rendered email HTML for an iframe to consume. Used by
 * the campaign-editor's live preview pane.
 *
 * Response: text/html (not JSON). The iframe loads this URL directly
 * via src="..." — no srcdoc + JSON wrangling.
 *
 * Rendering is delegated to render-email.ts which builds the HTML
 * via pure string templates — Next 16 + Turbopack rejected every
 * `react-dom/server` variant we tried (direct import, server-only
 * helper file with .tsx extension, dynamic import). The string-
 * template approach has zero framework dependency and works
 * regardless of which renderer Next ships in future versions.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const [row] = await db
    .select()
    .from(emailCampaigns)
    .where(eq(emailCampaigns.id, id))
    .limit(1);

  if (!row) {
    return new NextResponse("Not found", { status: 404 });
  }

  const data: CampaignData = {
    heroVariant: row.heroVariant as CampaignData["heroVariant"],
    heroImagePath: row.heroImagePath,
    heroImageAlt: row.heroImageAlt,
    heroHeadline: row.heroHeadline,
    heroSubtitle: row.heroSubtitle,
    heroCtaLabel: row.heroCtaLabel,
    heroCtaUrl: row.heroCtaUrl,
    heroScrim: row.heroScrim as CampaignData["heroScrim"],
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

  const html = renderEmailHtml(data);

  return new NextResponse(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
