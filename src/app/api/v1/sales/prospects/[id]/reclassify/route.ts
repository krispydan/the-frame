export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { icpClassifierHandler } from "@/modules/sales/agents/icp-classifier";

/**
 * POST /api/v1/sales/prospects/{id}/reclassify
 *
 * Clears any manual ICP override on the prospect and re-runs the classifier
 * against the company. Used by the "Reclassify" button on the prospect
 * detail page when a reviewer wants to let the auto-classifier re-rate
 * after a website / social / business change.
 *
 * Returns the fresh tier + score so the UI can update without a page reload.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Confirm the company exists
  const exists = sqlite.prepare("SELECT id FROM companies WHERE id = ?").get(id);
  if (!exists) return NextResponse.json({ error: "Prospect not found" }, { status: 404 });

  // Clear the override + audit fields so the classifier picks the row up
  sqlite.prepare(`
    UPDATE companies
    SET icp_manual_override = 0,
        icp_updated_by = NULL,
        icp_updated_at = NULL,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(id);

  // Run the classifier directly (single-row batch)
  try {
    await icpClassifierHandler({ companyIds: [id] });
  } catch (err) {
    console.error("[prospect/reclassify] classifier error:", err);
    return NextResponse.json({ error: "Reclassification failed", details: String(err) }, { status: 500 });
  }

  // Read final tier / score / reasoning back from DB so the UI can render
  // without a round-trip through the agent's response shape.
  const row = sqlite.prepare("SELECT icp_tier, icp_score, icp_reasoning FROM companies WHERE id = ?").get(id) as
    | { icp_tier: string | null; icp_score: number | null; icp_reasoning: string | null }
    | undefined;

  return NextResponse.json({
    ok: true,
    tier: row?.icp_tier ?? null,
    score: row?.icp_score ?? null,
    reasoning: row?.icp_reasoning ?? null,
  });
}
