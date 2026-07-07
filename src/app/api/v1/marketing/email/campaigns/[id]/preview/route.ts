export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { emailCampaigns } from "@/modules/marketing/schema";
import { eq } from "drizzle-orm";
import { renderEmailHtml, renderSectionHtml, type SectionKind } from "@/modules/marketing/lib/render-email";
import { campaignRowToData } from "@/modules/marketing/lib/campaign-render-data";

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
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // ?kind=hero|sectionA|secondary|sectionB renders a single block
  // (used by the client-side image export); default / "full" renders
  // the whole email.
  const kind = req.nextUrl.searchParams.get("kind");

  const [row] = await db
    .select()
    .from(emailCampaigns)
    .where(eq(emailCampaigns.id, id))
    .limit(1);

  if (!row) {
    return new NextResponse("Not found", { status: 404 });
  }

  // Shared row→CampaignData mapping (also used by push-omnisend) so new
  // render fields can't silently go missing in one consumer.
  const data = campaignRowToData(row);

  const SECTION_KINDS = ["hero", "sectionA", "secondary", "sectionB"];
  const html =
    kind && kind !== "full" && SECTION_KINDS.includes(kind)
      ? renderSectionHtml(data, kind as SectionKind)
      : renderEmailHtml(data);

  // ?download=1 → serve as an attachment so the operator can upload
  // the full email HTML straight into Omnisend (custom-HTML email)
  // instead of screenshotting blocks. Filename slugs from the campaign
  // name so downloads stay identifiable.
  const download = req.nextUrl.searchParams.get("download") === "1";
  const slug = (row.name || row.subject || row.id)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "email";

  return new NextResponse(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      ...(download
        ? { "Content-Disposition": `attachment; filename="jaxy-${slug}.html"` }
        : {}),
    },
  });
}
