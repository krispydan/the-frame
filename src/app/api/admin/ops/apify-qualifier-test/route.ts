export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { requireOpsToken } from "@/lib/ops-auth";
import {
  DEFAULT_MATRIX, PLACES_PER_CELL, batchSummary, exportLeads, listBatches,
  pollBatch, startBatch, type TestCell,
} from "@/modules/sales/lib/qualifier-test";

/**
 * Apify qualifier bench — prospecting research, driven from tooling.
 *
 * POST ?confirm=1  { matrix?, perCell? }   → start a batch (spends Apify credit)
 * GET                                       → list batches
 * GET  ?batch=<id>                          → poll running cells, then the scorecard
 * GET  ?batch=<id>&export=1[&minScore=]     → the scored leads themselves
 *
 * GET polls as a side effect on purpose. The runs are async on Apify's side,
 * so *someone* has to check on them, and making that the read path means no
 * cron job and no background load on the box — the caller drives the loop and
 * stops when they have their answer.
 */

export async function GET(req: NextRequest) {
  const denied = requireOpsToken(req);
  if (denied) return denied;

  const p = req.nextUrl.searchParams;
  const batch = p.get("batch");
  if (!batch) return NextResponse.json({ ok: true, batches: listBatches() });

  if (p.get("export") === "1") {
    const rows = exportLeads(batch, Number(p.get("minScore")) || 0);
    return NextResponse.json({ ok: true, batch, count: rows.length, leads: rows });
  }

  const poll = await pollBatch(batch);
  return NextResponse.json({ ok: true, poll, ...batchSummary(batch) });
}

export async function POST(req: NextRequest) {
  const denied = requireOpsToken(req);
  if (denied) return denied;
  if (req.nextUrl.searchParams.get("confirm") !== "1") {
    return NextResponse.json(
      { error: "add ?confirm=1 — this starts Apify runs and spends credit" },
      { status: 400 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as { matrix?: TestCell[]; perCell?: number };
  const matrix = Array.isArray(body.matrix) && body.matrix.length ? body.matrix : DEFAULT_MATRIX;
  const perCell = Number(body.perCell) || PLACES_PER_CELL;

  const res = await startBatch(matrix, perCell);
  return NextResponse.json({
    ok: true,
    ...res,
    cells: matrix.length,
    perCell,
    next: `GET /api/admin/ops/apify-qualifier-test?batch=${res.batch}`,
  });
}
