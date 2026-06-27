/**
 * Daily FIFO COGS posting.
 *
 * Recognizes COGS at SHIPMENT (decoupled from revenue/payout — see Phase 2),
 * once per day, as a single consolidated Xero ManualJournal split by sales
 * channel × cost component:
 *
 *   DR 5000 Product   (per channel, Sales-Channel-tracked)
 *   DR 5010 Freight    "
 *   DR 5020 Duties     "
 *   CR 1400 Inventory  (single net line)
 *
 * Landed cost is capitalized into 1400 at receipt, so this entry balances.
 *
 * Nothing is ever silently mis-costed. Each order line that can't be costed
 * cleanly raises a cogs_exception (+ Slack) and is EXCLUDED from the journal
 * until fixed — it's auto-re-picked on a later run once a layer is seeded or a
 * cost corrected. Every run leaves a cogs_run_log row.
 */
import { sqlite } from "@/lib/db";
import {
  calculateCogs, saveCogsJournal, markJournalPosted,
  resolveDepletionTarget, depleteInventoryFifo, MIN_PLAUSIBLE_UNIT_COST,
} from "./fifo-engine";
import { loadChannelXeroConfig } from "./shipment-revenue-recognition";
import { postManualJournal } from "./xero-client";
import {
  notifyCogsDailySummary, notifyCogsRunFailed, notifyCogsException,
} from "@/modules/integrations/lib/slack/notifications";

// Jaxy CoA — the freight/duty COGS sub-accounts. Product COGS + Inventory come
// from the per-channel Xero mapping; these two components don't have a
// per-channel mapping category yet, so they default here (capitalized model).
const COGS_FREIGHT_ACCOUNT = "5010";
const COGS_DUTIES_ACCOUNT = "5020";
const DEFAULT_PRODUCT_COGS_ACCOUNT = "5000";
const DEFAULT_INVENTORY_ACCOUNT = "1400";

export type ExceptionType = "shortfall" | "zero_cost" | "implausible_cost" | "unmapped_sku";

export interface DailyCogsResult {
  date: string;
  mode: "live" | "dry_run";
  ordersProcessed: number;
  unitsCosted: number;
  totalCogs: number;
  journalId: string | null;
  xeroJournalId: string | null;
  exceptions: Array<{ type: ExceptionType; orderNumber: string; sku: string | null; units: number; detail: string }>;
  skipped?: string; // reason, if the run short-circuited
}

interface ShippedLine {
  orderItemId: string;
  orderId: string;
  orderNumber: string | null;
  skuId: string | null;
  sku: string | null;
  quantity: number;
  channel: string | null;
  shippedAt: string | null;
}

function yesterdayUTC(): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Run the daily COGS posting for a single day (defaults to yesterday, UTC).
 *  opts.postDate overrides the Xero journal Date (locked-period correction:
 *  post into the current open period while still costing the original day). */
export async function runDailyCogsPosting(
  opts: { date?: string; dryRun?: boolean; force?: boolean; postDate?: string } = {},
): Promise<DailyCogsResult> {
  const date = opts.date || yesterdayUTC();
  const dryRun = !!opts.dryRun;
  const startedAt = Date.now();
  const runId = crypto.randomUUID();

  const result: DailyCogsResult = {
    date, mode: dryRun ? "dry_run" : "live",
    ordersProcessed: 0, unitsCosted: 0, totalCogs: 0,
    journalId: null, xeroJournalId: null, exceptions: [],
  };

  try {
    // Idempotency: skip if this day's journal is already posted (unless forced).
    if (!dryRun && !opts.force) {
      const posted = sqlite.prepare(
        "SELECT id FROM cogs_journals WHERE week_start = ? AND week_end = ? AND status = 'posted' LIMIT 1",
      ).get(date, date) as { id: string } | undefined;
      if (posted) {
        result.skipped = `COGS for ${date} already posted (journal ${posted.id}). Use force to re-post via correction.`;
        return result;
      }
    }

    const dayStart = `${date}T00:00:00`;
    const dayEndExclusive = `${date}T23:59:59.999`;

    // Shipped order lines for the day with no depletion yet. sku_id may be null
    // for pack lines — resolve via the SKU string, don't filter it out.
    const lines = sqlite.prepare(`
      SELECT oi.id AS orderItemId, oi.order_id AS orderId, o.order_number AS orderNumber,
             oi.sku_id AS skuId, oi.sku AS sku, oi.quantity AS quantity,
             o.channel AS channel, o.shipped_at AS shippedAt
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      LEFT JOIN inventory_cost_depletions d ON d.order_item_id = oi.id
      WHERE o.status IN ('shipped', 'delivered')
        AND o.shipped_at >= ? AND o.shipped_at <= ?
        AND d.id IS NULL
      ORDER BY o.shipped_at ASC
    `).all(dayStart, dayEndExclusive) as ShippedLine[];

    // For dry-run we simulate FIFO availability across lines for the same SKU.
    const simRemaining = new Map<string, number>();
    const getRemaining = (unitSkuId: string): number => {
      if (!simRemaining.has(unitSkuId)) {
        const row = sqlite.prepare(
          "SELECT COALESCE(SUM(remaining_quantity),0) AS r FROM inventory_cost_layers WHERE sku_id = ?",
        ).get(unitSkuId) as { r: number };
        simRemaining.set(unitSkuId, row.r);
      }
      return simRemaining.get(unitSkuId)!;
    };
    const oldestUnitCost = (unitSkuId: string): number | null => {
      const row = sqlite.prepare(
        `SELECT unit_cost AS c FROM inventory_cost_layers
         WHERE sku_id = ? AND remaining_quantity > 0
         ORDER BY received_at ASC, created_at ASC LIMIT 1`,
      ).get(unitSkuId) as { c: number } | undefined;
      return row ? row.c : null;
    };

    const raiseException = (
      type: ExceptionType, line: ShippedLine, units: number, unitSkuId: string | null, message: string,
    ) => {
      result.exceptions.push({ type, orderNumber: line.orderNumber || line.orderId, sku: line.sku, units, detail: message });
      if (dryRun) return;
      sqlite.prepare(`
        INSERT INTO cogs_exceptions
          (id, type, order_id, order_item_id, order_number, sku, sku_id, units, channel, detail, run_id, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
      `).run(
        crypto.randomUUID(), type, line.orderId, line.orderItemId, line.orderNumber,
        line.sku, unitSkuId, units, line.channel, JSON.stringify({ message }), runId,
      );
    };

    for (const line of lines) {
      result.ordersProcessed++;
      const { unitSkuId, units } = resolveDepletionTarget({ sku: line.sku, skuId: line.skuId, quantity: line.quantity });

      // (a) unmapped SKU — no catalog unit row to attach layers to.
      if (!unitSkuId) {
        raiseException("unmapped_sku", line, units, null, `SKU "${line.sku}" not found in catalog`);
        continue;
      }

      // (b) no inventory cost layer at all → full shortfall.
      const available = getRemaining(unitSkuId);
      if (available <= 0) {
        raiseException("shortfall", line, units, unitSkuId, `No cost layers with stock for ${line.sku} (need ${units})`);
        continue;
      }

      // (c) zero / implausible cost on the next layer to consume.
      const nextCost = oldestUnitCost(unitSkuId);
      if (nextCost != null && nextCost < MIN_PLAUSIBLE_UNIT_COST) {
        raiseException("zero_cost", line, units, unitSkuId, `Oldest layer unit cost ${nextCost} below floor ${MIN_PLAUSIBLE_UNIT_COST}`);
        continue;
      }

      if (dryRun) {
        const take = Math.min(units, available);
        simRemaining.set(unitSkuId, available - take);
        result.unitsCosted += take;
        if (take < units) raiseException("shortfall", line, units - take, unitSkuId, `Only ${take}/${units} units have stock`);
        continue;
      }

      // Live: a successful (re)costing clears any prior open exceptions for this line.
      sqlite.prepare(
        "UPDATE cogs_exceptions SET status='resolved', resolved_at=datetime('now') WHERE order_item_id = ? AND status='open'",
      ).run(line.orderItemId);

      const dep = depleteInventoryFifo(unitSkuId, units, {
        orderItemId: line.orderItemId,
        orderId: line.orderId,
        channel: line.channel || undefined,
        depletedAt: line.shippedAt || `${date}T12:00:00`,
      });
      result.unitsCosted += dep.totalDepleted;
      if (dep.shortfall > 0) {
        raiseException("shortfall", line, dep.shortfall, unitSkuId, `Only ${dep.totalDepleted}/${units} units had stock; ${dep.shortfall} uncosted`);
      }
    }

    // Build + post the consolidated journal from clean depletions for the day.
    const calc = calculateCogs(date, date);
    result.totalCogs = calc.totalCogs;

    if (!dryRun && calc.totalCogs > 0) {
      const journalId = saveCogsJournal(calc, `Daily FIFO COGS ${date}`);
      result.journalId = journalId;

      const journal = await buildDailyCogsJournal(date, calc, { postDate: opts.postDate });
      const post = await postManualJournal(journal);
      if (!post.success) {
        throw new Error(`Xero post failed: ${post.error}`);
      }
      markJournalPosted(journalId, post.manualJournalId);
      result.xeroJournalId = post.manualJournalId;
    }

    // Run log + Slack (live only).
    if (!dryRun) {
      writeRunLog(runId, result, Date.now() - startedAt, null);
      await fireSlack(result);
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!dryRun) {
      writeRunLog(runId, result, Date.now() - startedAt, message);
      await notifyCogsRunFailed({ date, errorMessage: message }).catch(() => {});
    }
    throw err;
  }
}

/**
 * Build the channel × component ManualJournal payload (capitalized model).
 *
 * opts.reverse negates every line — used by the correction engine to post an
 * equal-and-opposite reversing journal (never edit-in-place).
 * opts.postDate overrides the journal Date (locked-period guard: post into the
 * current open period while the narration still references the original day).
 */
export async function buildDailyCogsJournal(
  date: string,
  calc: Awaited<ReturnType<typeof calculateCogs>>,
  opts: { reverse?: boolean; postDate?: string } = {},
) {
  const sign = opts.reverse ? -1 : 1;
  const lines: Array<Record<string, unknown>> = [];
  let inventoryCredit = 0;

  for (const [channel, b] of Object.entries(calc.channelBreakdown)) {
    const cfg = await loadChannelXeroConfig(channel);
    const tracking = cfg?.trackingCategoryId
      ? [{ TrackingCategoryID: cfg.trackingCategoryId, Name: cfg.trackingCategoryName ?? undefined, Option: cfg.trackingOptionName ?? "" }]
      : undefined;
    const productAcct = cfg?.cogsAccountCode || DEFAULT_PRODUCT_COGS_ACCOUNT;
    const label = channelLabel(channel);

    const round = (n: number) => Math.round(n * 100) / 100;
    const push = (amount: number, acct: string, desc: string) => {
      const a = round(amount);
      if (a <= 0) return; // Xero rejects zero lines
      lines.push({ LineAmount: sign * a, AccountCode: acct, Description: desc, Tracking: tracking });
      inventoryCredit += a;
    };
    push(b.productCost, productAcct, `COGS Product — ${label} (${b.units}u)`);
    push(b.freightCost, COGS_FREIGHT_ACCOUNT, `COGS Freight — ${label}`);
    push(b.dutiesCost, COGS_DUTIES_ACCOUNT, `COGS Duties — ${label}`);
  }

  // Single net inventory credit (all components were capitalized into 1400).
  const invAcct = (await loadChannelXeroConfig(Object.keys(calc.channelBreakdown)[0] || ""))?.inventoryAccountCode || DEFAULT_INVENTORY_ACCOUNT;
  lines.push({
    LineAmount: sign * -(Math.round(inventoryCredit * 100) / 100),
    AccountCode: invAcct,
    Description: `Inventory release — ${date} (${calc.unitCount}u, landed)`,
  });

  const narration = opts.reverse
    ? `REVERSAL of Daily COGS ${date} | ${calc.unitCount}u | ref:cogs-${date}-reversal`
    : `Daily COGS — ${date} | ${calc.unitCount}u | ref:cogs-${date}`;

  return {
    Narration: narration,
    Date: opts.postDate || date,
    Status: "POSTED" as const,
    JournalLines: lines,
  };
}

function channelLabel(channel: string): string {
  switch (channel) {
    case "shopify_dtc": return "Shopify Retail";
    case "shopify_wholesale": return "Shopify Wholesale";
    case "faire": return "Faire";
    case "unknown": return "Unattributed";
    default: return channel;
  }
}

function writeRunLog(runId: string, r: DailyCogsResult, durationMs: number, error: string | null) {
  sqlite.prepare(`
    INSERT INTO cogs_run_log
      (id, run_date, mode, orders_processed, units_costed, total_cogs,
       exceptions_opened, cogs_journal_id, xero_journal_id, duration_ms, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId, r.date, r.mode, r.ordersProcessed, r.unitsCosted, r.totalCogs,
    r.exceptions.length, r.journalId, r.xeroJournalId, durationMs, error,
  );
}

async function fireSlack(r: DailyCogsResult) {
  // One summary line for the day.
  if (r.totalCogs > 0 || r.exceptions.length > 0) {
    await notifyCogsDailySummary({
      date: r.date, units: r.unitsCosted, totalCogs: r.totalCogs, currency: "USD",
      ordersProcessed: r.ordersProcessed, exceptionsOpen: r.exceptions.length,
      manualJournalId: r.xeroJournalId,
    }).catch(() => {});
  }
  // One grouped alert per exception type.
  const byType = new Map<ExceptionType, DailyCogsResult["exceptions"]>();
  for (const e of r.exceptions) {
    if (!byType.has(e.type)) byType.set(e.type, []);
    byType.get(e.type)!.push(e);
  }
  for (const [type, items] of byType) {
    await notifyCogsException({
      type, count: items.length, date: r.date,
      examples: items.map((e) => `#${e.orderNumber} ${e.sku ?? "?"} ×${e.units}`),
    }).catch(() => {});
  }
}
