/**
 * Settlement bridge: `amazon_settlement_rows` → `settlements` +
 * `settlement_line_items`.
 *
 * This is the join that makes Amazon visible to machinery that already
 * exists. Reconciliation compares settlement gross against linked orders;
 * revenue recognition walks orders → settlement_line_items → settlements →
 * payout syncs. Neither can see Amazon without these rows, which is exactly
 * the role `ensureFaireSettlement` plays for Faire.
 *
 * Line items link to local orders through `external_id = 'amazon:' + order_id`,
 * matching the dual-key join the reconciliation view already performs
 * (`o.id = sli.order_id OR o.external_id = sli.order_id`).
 *
 * Idempotent on `settlements.external_id = 'amazon_settlement_{id}'`. A
 * settlement that is still open (Amazon has not closed the period) is
 * deliberately skipped: importing a partial settlement would produce a
 * gross figure that changes underneath any journal posted against it.
 */

import { sqlite } from "@/lib/db";
import {
  classifySettlementRow,
  summariseSettlement,
  type SettlementRowInput,
  type SettlementSummary,
} from "./settlement-classify";

export const AMAZON_SETTLEMENT_EXTERNAL_PREFIX = "amazon_settlement_";

export const amazonSettlementExternalId = (settlementId: string) =>
  `${AMAZON_SETTLEMENT_EXTERNAL_PREFIX}${settlementId}`;

interface StoredRow {
  settlement_id: string;
  posted_date: string | null;
  transaction_type: string | null;
  amount_type: string | null;
  amount_description: string | null;
  amount: number;
  currency: string;
  sku: string | null;
  order_id: string | null;
  settlement_start_date: string | null;
  settlement_end_date: string | null;
  deposit_date: string | null;
  total_amount: number | null;
}

export interface BridgeResult {
  settlementsConsidered: number;
  created: number;
  updated: number;
  skippedOpen: number;
  lineItemsWritten: number;
  /** Settlements carrying lines the classifier did not recognise. */
  unclassified: Array<{ settlementId: string; reason: string; amount: number }>;
  /** Settlements whose facilitator-tax legs failed to net to zero. */
  taxResiduals: Array<{ settlementId: string; residual: number }>;
  summaries: SettlementSummary[];
}

/**
 * A settlement is closed — and therefore safe to bridge — once its period
 * end has passed. Amazon keeps adding lines to an open settlement, so
 * bridging early would produce figures that shift under any journal built
 * from them.
 */
export function isSettlementClosed(endDate: string | null, today: string): boolean {
  if (!endDate) return false;
  return endDate.slice(0, 10) <= today;
}

/**
 * Build `settlements` + `settlement_line_items` from the raw archive.
 *
 * Line items are written at category granularity rather than per raw row:
 * a settlement of 160 lines collapses to a handful of meaningful entries
 * (sale, fee, refund, adjustment), which is what reconciliation reads and
 * what a human can actually check against a bank deposit.
 */
export function bridgeAmazonSettlements(
  opts: { today?: string; settlementIds?: string[] } = {},
): BridgeResult {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const result: BridgeResult = {
    settlementsConsidered: 0, created: 0, updated: 0, skippedOpen: 0,
    lineItemsWritten: 0, unclassified: [], taxResiduals: [], summaries: [],
  };

  const where = opts.settlementIds?.length
    ? `WHERE settlement_id IN (${opts.settlementIds.map(() => "?").join(",")})`
    : "";
  const rows = sqlite.prepare(`
    SELECT settlement_id, posted_date, transaction_type, amount_type, amount_description,
           amount, currency, sku, order_id, settlement_start_date, settlement_end_date,
           deposit_date, total_amount
    FROM amazon_settlement_rows ${where}
    ORDER BY settlement_id, posted_date
  `).all(...(opts.settlementIds ?? [])) as StoredRow[];

  const grouped = new Map<string, StoredRow[]>();
  for (const r of rows) {
    const list = grouped.get(r.settlement_id);
    if (list) list.push(r);
    else grouped.set(r.settlement_id, [r]);
  }
  result.settlementsConsidered = grouped.size;

  for (const [settlementId, group] of grouped) {
    const endDate = group.find((r) => r.settlement_end_date)?.settlement_end_date ?? null;
    if (!isSettlementClosed(endDate, today)) {
      result.skippedOpen++;
      continue;
    }

    const inputs: SettlementRowInput[] = group.map((r) => ({
      transactionType: r.transaction_type,
      amountType: r.amount_type,
      amountDescription: r.amount_description,
      amount: r.amount,
    }));
    const summary = summariseSettlement(settlementId, inputs);
    result.summaries.push(summary);

    for (const u of summary.unclassified) {
      result.unclassified.push({ settlementId, reason: u.reason, amount: u.amount });
    }
    if (Math.abs(summary.taxResidual) >= 0.01) {
      result.taxResiduals.push({ settlementId, residual: summary.taxResidual });
    }

    const startDate = group.find((r) => r.settlement_start_date)?.settlement_start_date ?? endDate;
    const depositDate = group.find((r) => r.deposit_date)?.deposit_date ?? endDate;
    const currency = group.find((r) => r.currency)?.currency ?? "USD";
    const externalId = amazonSettlementExternalId(settlementId);

    const write = sqlite.transaction(() => {
      const existing = sqlite
        .prepare("SELECT id FROM settlements WHERE external_id = ? LIMIT 1")
        .get(externalId) as { id: string } | undefined;

      const settlementRowId = existing?.id ?? crypto.randomUUID();

      // gross is sales before promotions; fees and refunds are carried
      // separately so reconciliation can show what Amazon actually withheld.
      const gross = summary.grossSales;
      const fees = summary.totalFees;
      const adjustments = round2(-summary.promotions - summary.refunds);
      const net = summary.net;

      if (existing) {
        sqlite.prepare(`
          UPDATE settlements SET
            period_start = ?, period_end = ?, gross_amount = ?, fees = ?,
            adjustments = ?, net_amount = ?, currency = ?, status = ?, received_at = ?
          WHERE id = ?
        `).run(startDate, endDate, gross, fees, adjustments, net, currency, "received", depositDate, settlementRowId);
        result.updated++;
      } else {
        sqlite.prepare(`
          INSERT INTO settlements (
            id, channel, period_start, period_end, gross_amount, fees, adjustments,
            net_amount, currency, external_id, status, received_at, created_at
          ) VALUES (?, 'amazon', ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, datetime('now'))
        `).run(settlementRowId, startDate, endDate, gross, fees, adjustments, net, currency, externalId, depositDate);
        result.created++;
      }

      // Rewrite line items: they are derived, and a settlement's raw rows are
      // immutable, so regenerating is always safe and keeps the two in step.
      sqlite.prepare("DELETE FROM settlement_line_items WHERE settlement_id = ?").run(settlementRowId);

      // Per-order sale lines, so reconciliation can tie a settlement to the
      // orders that produced it.
      const perOrder = new Map<string, number>();
      for (const r of group) {
        if (!r.order_id) continue;
        const c = classifySettlementRow({
          transactionType: r.transaction_type, amountType: r.amount_type,
          amountDescription: r.amount_description, amount: r.amount,
        });
        if (c.category !== "sales") continue;
        perOrder.set(r.order_id, round2((perOrder.get(r.order_id) ?? 0) + r.amount));
      }

      const insertLine = sqlite.prepare(`
        INSERT INTO settlement_line_items (id, settlement_id, order_id, type, description, amount, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      `);

      for (const [amazonOrderId, amount] of perOrder) {
        insertLine.run(
          crypto.randomUUID(), settlementRowId,
          // Written in the prefixed form so it matches orders.external_id
          // through the reconciliation view's dual-key join.
          `amazon:${amazonOrderId}`,
          "sale", `Amazon order ${amazonOrderId}`, amount,
        );
        result.lineItemsWritten++;
      }

      // One aggregate line per non-sale category — a bank deposit is checked
      // against a handful of figures, not 160 raw rows.
      for (const [category, amount] of Object.entries(summary.byCategory)) {
        if (category === "sales" || Math.abs(amount) < 0.005) continue;
        const type =
          category === "refunds" ? "refund"
            : category === "discounts" || category === "clearing" ? "adjustment"
              : "fee";
        insertLine.run(crypto.randomUUID(), settlementRowId, null, type, labelFor(category), amount);
        result.lineItemsWritten++;
      }
    });

    write();
  }

  return result;
}

function labelFor(category: string): string {
  switch (category) {
    case "discounts": return "Promotions & discounts";
    case "refunds": return "Refunds";
    case "commission": return "Referral commission";
    case "fba_fulfillment": return "FBA fulfilment fees";
    case "fba_storage": return "FBA storage fees";
    case "subscription": return "Selling plan subscription";
    case "inbound_freight": return "Inbound freight to FBA";
    case "outbound_shipping": return "Return shipping labels";
    case "shipping_income": return "Shipping income";
    case "clearing": return "Settlement clearing";
    case "unclassified": return "Unclassified — needs review";
    default: return category;
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;
