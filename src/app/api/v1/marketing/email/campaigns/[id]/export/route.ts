export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { db, sqlite } from "@/lib/db";
import { emailCampaigns } from "@/modules/marketing/schema";
import { eq } from "drizzle-orm";
import {
  toExportable,
  buildOmnisendHtml,
  buildFaireBlocks,
  exportReadiness,
} from "@/modules/marketing/lib/email-export";
import { statusIndex } from "@/modules/marketing/lib/workflow";

/**
 * GET /api/v1/marketing/email/campaigns/[id]/export?format=omnisend|faire
 *
 *   omnisend → standalone client-hardened HTML (download).
 *   faire    → JSON { subject, preheader, blocks[], plainText } for paste.
 *
 * On success, advances status to `exported` (forward-only). Add
 * `?dryRun=1` to render without changing status (used by the preview/
 * readiness check in the editor).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const format = (req.nextUrl.searchParams.get("format") ?? "omnisend").toLowerCase();
  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";

  const [row] = await db
    .select()
    .from(emailCampaigns)
    .where(eq(emailCampaigns.id, id))
    .limit(1);
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const campaign = toExportable(row as unknown as Record<string, unknown>);
  const readiness = exportReadiness(campaign);

  // Advance to exported (forward only — never regress a sent/analyzed
  // campaign). Skipped for dry runs.
  if (!dryRun && statusIndex(row.status) < statusIndex("exported")) {
    sqlite
      .prepare(
        `UPDATE marketing_email_campaigns
           SET status = 'exported', updated_at = datetime('now') WHERE id = ?`,
      )
      .run(id);
  }

  if (format === "faire") {
    return NextResponse.json({
      ok: true,
      format: "faire",
      readiness,
      ...buildFaireBlocks(campaign),
    });
  }

  // Default: omnisend HTML download.
  const html = buildOmnisendHtml(campaign);
  const filename = `${row.utmCampaign || `${row.audience}-${row.scheduledDate}`}.html`;
  return new NextResponse(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": dryRun
        ? "inline"
        : `attachment; filename="${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}"`,
      "Cache-Control": "no-store",
    },
  });
}
