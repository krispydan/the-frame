export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { db } from "@/lib/db";
import { emailCampaigns } from "@/modules/marketing/schema";
import { eq } from "drizzle-orm";
import {
  EmailTemplateRenderer,
  type CampaignData,
} from "@/modules/marketing/components/email-template";
import { catalogImageUrl } from "@/lib/storage/image-url";

/**
 * GET /api/v1/marketing/email/campaigns/[id]/preview
 *
 * Returns the rendered email HTML for an iframe to consume. Used by
 * the campaign-editor's live preview pane.
 *
 * Response: text/html (not JSON). The iframe loads this URL directly
 * via src="..." — no srcdoc + JSON wrangling.
 *
 * Images: stored paths run through catalogImageUrl() (already
 * proxies through theframe.getjaxy.com/api/images, handles absolute
 * vs relative paths, etc.).
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

  // Map row → CampaignData. Drizzle's typed columns get coerced to
  // the renderer's union types via the variant enums in the schema.
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

  const body = renderToStaticMarkup(
    <EmailTemplateRenderer campaign={data} imageUrlFor={catalogImageUrl} />,
  );

  // Prepend doctype since renderToStaticMarkup doesn't.
  const html = `<!DOCTYPE html>\n${body}`;

  return new NextResponse(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",  // preview should always be fresh
    },
  });
}
