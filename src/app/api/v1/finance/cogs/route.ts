export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db, sqlite } from "@/lib/db";
import { activityFeed } from "@/modules/core/schema";
import {
  calculateCogs,
  saveCogsJournal,
  getCogsJournals,
  markJournalPosted,
  depleteUncostedOrders,
} from "@/modules/finance/lib/fifo-engine";
import { postCogsJournalToXero } from "@/modules/finance/lib/xero-client";
import { runDailyCogsPosting } from "@/modules/finance/lib/daily-cogs";
import { runCogsBackfill, correctCogsForDate, resolveException } from "@/modules/finance/lib/cogs-backfill";

/** Monitoring snapshot for the COGS dashboard header. */
function getCogsHealth() {
  const lastRun = sqlite.prepare(
    "SELECT * FROM cogs_run_log ORDER BY created_at DESC LIMIT 1",
  ).get() as Record<string, unknown> | undefined;

  const openByType = sqlite.prepare(
    "SELECT type, COUNT(*) AS count, SUM(COALESCE(units,0)) AS units FROM cogs_exceptions WHERE status='open' GROUP BY type",
  ).all() as Array<{ type: string; count: number; units: number }>;

  const openTotal = openByType.reduce((s, r) => s + r.count, 0);

  const oldestOpen = sqlite.prepare(
    "SELECT MIN(created_at) AS oldest FROM cogs_exceptions WHERE status='open'",
  ).get() as { oldest: string | null };

  // SKUs sitting on a zero/implausible cost layer (bad data still in the book).
  const zeroCostLayers = (sqlite.prepare(
    "SELECT COUNT(DISTINCT sku_id) AS c FROM inventory_cost_layers WHERE remaining_quantity > 0 AND unit_cost < 0.1",
  ).get() as { c: number }).c;

  return { lastRun: lastRun ?? null, openByType, openTotal, oldestOpen: oldestOpen.oldest, zeroCostLayers };
}

/**
 * GET /api/v1/finance/cogs — list COGS journals and dashboard data
 *   ?journals=true → list all COGS journals
 *   ?weekStart=YYYY-MM-DD&weekEnd=YYYY-MM-DD → calculate COGS for a specific week
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  if (searchParams.get("journals") === "true") {
    const journals = getCogsJournals();
    return NextResponse.json(journals);
  }

  if (searchParams.get("health") === "true") {
    return NextResponse.json(getCogsHealth());
  }

  if (searchParams.get("runLog") === "true") {
    const rows = sqlite.prepare(
      "SELECT * FROM cogs_run_log ORDER BY created_at DESC LIMIT 30",
    ).all();
    return NextResponse.json(rows);
  }

  if (searchParams.get("exceptions") === "true") {
    const status = searchParams.get("status") || "open";
    const rows = sqlite.prepare(
      "SELECT * FROM cogs_exceptions WHERE status = ? ORDER BY created_at DESC LIMIT 200",
    ).all(status);
    return NextResponse.json(rows);
  }

  // Per-day journal drill-down: the orders/units behind a posted day.
  const detailDate = searchParams.get("journalDetail");
  if (detailDate) {
    const rows = sqlite.prepare(`
      SELECT d.order_id AS orderId, o.order_number AS orderNumber, d.channel,
             cs.sku, cp.name AS productName,
             SUM(d.quantity) AS units,
             ROUND(SUM(d.quantity * d.landed_cost_per_unit), 2) AS landedCost
      FROM inventory_cost_depletions d
      LEFT JOIN orders o ON o.id = d.order_id
      LEFT JOIN inventory_cost_layers l ON l.id = d.cost_layer_id
      LEFT JOIN catalog_skus cs ON cs.id = l.sku_id
      LEFT JOIN catalog_products cp ON cp.id = cs.product_id
      WHERE d.depleted_at >= ? AND d.depleted_at <= ?
      GROUP BY d.order_id, cs.sku
      ORDER BY o.order_number
    `).all(`${detailDate}T00:00:00`, `${detailDate}T23:59:59.999`);
    return NextResponse.json(rows);
  }

  const weekStart = searchParams.get("weekStart");
  const weekEnd = searchParams.get("weekEnd");

  if (weekStart && weekEnd) {
    const calc = calculateCogs(weekStart, weekEnd);
    return NextResponse.json(calc);
  }

  // Default: return journals + summary stats
  const journals = getCogsJournals();
  return NextResponse.json({ journals });
}

/**
 * POST /api/v1/finance/cogs — multi-action endpoint
 *
 * Body actions:
 *   { action: "calculate", weekStart, weekEnd } → calculate + save draft journal
 *   { action: "post-to-xero", journalId, asDraft? } → post a saved journal to Xero
 *   { action: "deplete-orders", since?, dryRun? } → run FIFO on uncosted fulfilled orders
 *   { action: "full-cycle", weekStart, weekEnd, asDraft? } → deplete + calculate + post
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { action } = body;

  if (action === "calculate") {
    const { weekStart, weekEnd, notes } = body;
    if (!weekStart || !weekEnd) {
      return NextResponse.json({ error: "weekStart and weekEnd required" }, { status: 400 });
    }
    const calc = calculateCogs(weekStart, weekEnd);
    const journalId = saveCogsJournal(calc, notes);
    return NextResponse.json({ journalId, ...calc });
  }

  if (action === "post-to-xero") {
    const { journalId, asDraft } = body;
    if (!journalId) {
      return NextResponse.json({ error: "journalId required" }, { status: 400 });
    }

    // Look up the journal
    const journal = getCogsJournals().find((j) => j.id === journalId);
    if (!journal) {
      return NextResponse.json({ error: "Journal not found" }, { status: 404 });
    }
    if (journal.status === "posted") {
      return NextResponse.json({ error: "Already posted to Xero" }, { status: 400 });
    }

    const channelBreakdown = journal.channelBreakdown
      ? JSON.parse(journal.channelBreakdown)
      : undefined;

    const result = await postCogsJournalToXero({
      weekStart: journal.weekStart,
      weekEnd: journal.weekEnd,
      productCost: journal.productCost,
      freightCost: journal.freightCost,
      dutiesCost: journal.dutiesCost,
      totalCogs: journal.totalCogs,
      unitCount: journal.unitCount,
      channelBreakdown,
      asDraft: asDraft ?? true,
    });

    if (result.success && result.journalId) {
      markJournalPosted(journalId, result.journalId);
      db.insert(activityFeed).values({
        eventType: "finance.cogs_posted_to_xero",
        module: "finance",
        entityType: "cogs_journal",
        entityId: journalId,
        data: {
          weekStart: journal.weekStart,
          weekEnd: journal.weekEnd,
          totalCogs: journal.totalCogs,
          xeroJournalId: result.journalId,
          asDraft,
        },
      }).run();
    }

    return NextResponse.json(result);
  }

  if (action === "deplete-orders") {
    const { since, dryRun } = body;
    const result = depleteUncostedOrders({ since, dryRun });
    return NextResponse.json(result);
  }

  // ── Daily FIFO COGS (the primary, automated flow) ──
  if (action === "run-daily") {
    const { date, dryRun, force } = body;
    const result = await runDailyCogsPosting({ date, dryRun, force });
    return NextResponse.json(result);
  }

  if (action === "backfill") {
    const { from, to, dryRun, force } = body;
    if (!from || !to) return NextResponse.json({ error: "from and to required" }, { status: 400 });
    const result = await runCogsBackfill({ from, to, dryRun, force });
    return NextResponse.json(result);
  }

  if (action === "correct-date") {
    const { date, reason } = body;
    if (!date) return NextResponse.json({ error: "date required" }, { status: 400 });
    try {
      const result = await correctCogsForDate(date, { reason });
      return NextResponse.json(result);
    } catch (e) {
      return NextResponse.json({ error: String(e) }, { status: 400 });
    }
  }

  if (action === "resolve-exception") {
    const { exceptionId } = body;
    if (!exceptionId) return NextResponse.json({ error: "exceptionId required" }, { status: 400 });
    try {
      const result = await resolveException(exceptionId);
      return NextResponse.json(result);
    } catch (e) {
      return NextResponse.json({ error: String(e) }, { status: 400 });
    }
  }

  if (action === "full-cycle") {
    const { weekStart, weekEnd, asDraft = true, notes } = body;
    if (!weekStart || !weekEnd) {
      return NextResponse.json({ error: "weekStart and weekEnd required" }, { status: 400 });
    }

    // Step 1: Deplete any uncosted orders in the period
    const depletionResult = depleteUncostedOrders({ since: weekStart });

    // Step 2: Calculate COGS
    const calc = calculateCogs(weekStart, weekEnd);
    const journalId = saveCogsJournal(calc, notes);

    // Step 3: Post to Xero
    let xeroResult: { success: boolean; journalId?: string; error?: string } = { success: false, error: "Skipped" };
    if (calc.totalCogs > 0) {
      xeroResult = await postCogsJournalToXero({
        ...calc,
        asDraft,
      });

      if (xeroResult.success && xeroResult.journalId) {
        markJournalPosted(journalId, xeroResult.journalId);
        db.insert(activityFeed).values({
          eventType: "finance.cogs_full_cycle",
          module: "finance",
          entityType: "cogs_journal",
          entityId: journalId,
          data: {
            weekStart, weekEnd,
            totalCogs: calc.totalCogs,
            unitsDepleted: depletionResult.depleted,
            shortfalls: depletionResult.shortfalls.length,
            xeroJournalId: xeroResult.journalId,
          },
        }).run();
      }
    }

    return NextResponse.json({
      depletion: depletionResult,
      cogs: calc,
      journalId,
      xero: xeroResult,
    });
  }

  return NextResponse.json({ error: "Unknown action. Use: run-daily, backfill, correct-date, resolve-exception, calculate, post-to-xero, deplete-orders, full-cycle" }, { status: 400 });
}
