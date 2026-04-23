export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { activityFeed } from "@/modules/core/schema";
import {
  calculateCogs,
  saveCogsJournal,
  getCogsJournals,
  markJournalPosted,
  depleteUncostedOrders,
} from "@/modules/finance/lib/fifo-engine";
import { postCogsJournalToXero } from "@/modules/finance/lib/xero-client";

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

  return NextResponse.json({ error: "Unknown action. Use: calculate, post-to-xero, deplete-orders, full-cycle" }, { status: 400 });
}
