export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { requireOpsToken } from "@/lib/ops-auth";
import {
  DEFAULT_MATRIX, PLACES_PER_CELL, batchSummary, exportLeads, listBatches,
  batchCosts, pollBatch, rescoreBatch, retryFailedCells, startBatch, type TestCell,
} from "@/modules/sales/lib/qualifier-test";
import {
  emailReport, exportEmails, pollEmailProbe, startEmailProbe, verifySample,
} from "@/modules/sales/lib/email-probe";

/**
 * Apify qualifier bench — prospecting research, driven from tooling.
 *
 * POST ?confirm=1  { matrix?, perCell? }             → start a batch (spends Apify credit)
 * POST ?confirm=1  { action:'emails', batch, limit } → crawl those leads' sites for addresses
 * POST ?confirm=1  { action:'verify', batch, limit } → NeverBounce a sample of what was found
 * GET                                       → list batches
 * GET  ?batch=<id>                          → poll running cells, then the scorecard
 * GET  ?batch=<id>&export=1[&minScore=]     → the scored leads themselves
 * GET  ?batch=<id>&emails=1                 → poll the email probe, then its report
 * GET  ?batch=<id>&exportEmails=1           → the addresses found
 * GET  ?batch=<id>&costs=1                  → what each cell actually cost, per Apify
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
    const rows = exportLeads(batch, Number(p.get("minScore")) || 0, p.get("includeExcluded") === "1");
    return NextResponse.json({ ok: true, batch, count: rows.length, leads: rows });
  }

  if (p.get("emails") === "1") {
    const poll = await pollEmailProbe(batch);
    return NextResponse.json({ ok: true, poll, ...emailReport(batch) });
  }

  if (p.get("costs") === "1") {
    return NextResponse.json({ ok: true, ...(await batchCosts(batch)) });
  }

  if (p.get("exportEmails") === "1") {
    const rows = exportEmails(batch);
    return NextResponse.json({ ok: true, batch, count: rows.length, emails: rows });
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

  const body = (await req.json().catch(() => ({}))) as {
    matrix?: TestCell[]; perCell?: number;
    action?: "scrape" | "emails" | "verify" | "rescore" | "retry";
    batch?: string; limit?: number; minScore?: number; pagesPerSite?: number;
  };

  // Maintenance on an existing batch — neither spends Apify credit.
  if (body.action === "rescore" || body.action === "retry") {
    if (!body.batch) return NextResponse.json({ error: "batch required" }, { status: 400 });
    const res = body.action === "rescore" ? rescoreBatch(body.batch) : retryFailedCells(body.batch);
    return NextResponse.json({ ok: true, action: body.action, ...res });
  }

  // Email discovery runs against an existing batch, so it needs one named.
  if (body.action === "emails" || body.action === "verify") {
    if (!body.batch) return NextResponse.json({ error: "batch required" }, { status: 400 });
    if (body.action === "verify") {
      const res = await verifySample(body.batch, Number(body.limit) || 100);
      return NextResponse.json({ ok: true, ...res, ...emailReport(body.batch) });
    }
    const res = await startEmailProbe(body.batch, {
      limit: Number(body.limit) || 100,
      minScore: Number(body.minScore) || 0,
      pagesPerSite: Number(body.pagesPerSite) || 3,
    });
    return NextResponse.json({
      ok: !res.error, ...res,
      next: `GET /api/admin/ops/apify-qualifier-test?batch=${body.batch}&emails=1`,
    });
  }

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
