export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { emailCampaigns } from "@/modules/marketing/schema";
import { eq } from "drizzle-orm";
import { lintCopy } from "@/modules/marketing/lib/copy-quality";
import { exportReadiness, toExportable } from "@/modules/marketing/lib/email-export";

/**
 * GET /api/v1/marketing/email/campaigns/[id]/validate
 *
 * Deterministic, server-side QA: runs the copy linter (brand + hard
 * shape rules) and the export-readiness check. The editor calls this
 * to show red (errors) / amber (warnings) before the user exports.
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
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const lint = lintCopy(row, row.audience as "retail" | "wholesale");
  const readiness = exportReadiness(toExportable(row as unknown as Record<string, unknown>));

  return NextResponse.json({ ok: lint.ok && readiness.ready, lint, readiness });
}
