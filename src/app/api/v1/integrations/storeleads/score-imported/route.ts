export const dynamic = "force-dynamic";
export const maxDuration = 600;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { icpClassifierHandler } from "@/modules/sales/agents/icp-classifier";

/**
 * POST /api/v1/integrations/storeleads/score-imported
 *
 * Runs the existing ICP classifier on every storeleads-sourced company
 * that doesn't yet have an icp_score. Respects `icp_manual_override`
 * (the classifier itself skips those — we don't need to filter here).
 *
 * Body (optional):
 *   { limit?: 500, dryRun?: false }
 *
 * Returns the classifier's output + the count of candidates considered.
 * 500-batch is the existing classifier's natural batch size; the
 * classifier handles further batching internally.
 */
export async function POST(req: NextRequest) {
  let body: { limit?: number; dryRun?: boolean } = {};
  try {
    body = (await req.json()) as { limit?: number; dryRun?: boolean };
  } catch {
    // empty body fine
  }
  const limit = Math.max(1, Math.min(10_000, body.limit ?? 5_000));

  const candidates = sqlite
    .prepare(
      `SELECT id FROM companies
        WHERE source_type = 'storeleads'
          AND icp_score IS NULL
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .all(limit) as Array<{ id: string }>;

  if (body.dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      candidateCount: candidates.length,
    });
  }
  if (candidates.length === 0) {
    return NextResponse.json({
      ok: true,
      candidateCount: 0,
      result: { success: true, message: "No unscored StoreLeads rows" },
    });
  }

  try {
    const result = await icpClassifierHandler({
      companyIds: candidates.map((c) => c.id),
    });
    return NextResponse.json({
      ok: true,
      candidateCount: candidates.length,
      result,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
