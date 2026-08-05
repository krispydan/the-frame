/**
 * Turning an approved replenishment proposal into a shipment.
 *
 * Deliberately generates rather than sends. The proposal is a recommendation
 * built partly from Amazon's own numbers; a human adjusts and approves it, and
 * only then does anything leave the building. Auto-shipping stock to a
 * warehouse you cannot easily pull it back from is not a step worth saving.
 *
 * Two artifacts come out, because the move has two halves:
 *
 *   - a ShipHero order that physically picks and ships the units, and
 *   - an Amazon FBA shipment plan naming what Amazon should expect.
 *
 * ⚠️ The ShipHero order is priced at $0 because it is a stock TRANSFER between
 * our own locations, not a sale. Two consequences that must stay true:
 *
 *   1. It must never generate COGS. Goods moved between our own locations have
 *      not been sold, so recognising cost would overstate COGS and understate
 *      inventory. This is safe today because the ShipHero order sync only ever
 *      UPDATES orders and never inserts them, so a transfer created in
 *      ShipHero never reaches `orders` at all.
 *   2. It must never be pushed to Amazon as a customer order. The channel
 *      guards cover that; the transfer is not an Amazon order and carries no
 *      Amazon channel marker.
 *
 * Both are asserted in tests rather than left as intent.
 */

import { sqlite } from "@/lib/db";
import { buildCsv } from "@/modules/operations/lib/shiphero/csv-utils";
import { buildReplenishmentProposal, type ReplenishmentLine } from "./replenishment";

/** A line the operator has reviewed. Quantity may differ from the proposal. */
export interface TransferLine {
  /** Amazon-facing SKU, e.g. JX3004-S-BLK-FBA. */
  sku: string;
  quantity: number;
}

export interface TransferPlan {
  reference: string;
  createdFor: string;
  lines: Array<{
    /** What ShipHero picks — our warehouse spelling. */
    warehouseSku: string;
    /** What Amazon receives it as. */
    amazonSku: string;
    title: string | null;
    quantity: number;
    landedCostPerUnit: number | null;
    /** Inventory value moving, at cost. Not revenue. */
    valueAtCost: number;
  }>;
  totals: { skus: number; units: number; valueAtCost: number };
  /** ShipHero order lines, $0 — a transfer, not a sale. */
  shipheroCsv: string;
  /** Amazon FBA shipment plan: what Amazon should expect to receive. */
  fbaPlanCsv: string;
  warnings: string[];
  /** Populated when a requested line cannot be shipped as asked. */
  rejected: Array<{ sku: string; requested: number; reason: string }>;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export const SHIPHERO_TRANSFER_HEADERS = [
  "Order Number", "Email", "Order Date", "Sku", "Quantity", "Price",
  "Shipping Method", "Note",
] as const;

export const FBA_PLAN_HEADERS = ["Merchant SKU", "Quantity", "Title"] as const;

/**
 * Build the transfer artifacts for an approved set of lines.
 *
 * `lines` are the operator's numbers, not the proposal's. They are still
 * validated against warehouse stock — approving a quantity does not conjure
 * units, and a plan that cannot be picked would fail in the warehouse instead
 * of here, which is a far worse place to find out.
 */
export function buildFbaTransfer(opts: {
  lines: TransferLine[];
  reference: string;
  /** Defaults to today. */
  date?: string;
  /** Injectable so a proposal can be reused rather than rebuilt. */
  proposal?: ReturnType<typeof buildReplenishmentProposal>;
}): TransferPlan {
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const proposal = opts.proposal ?? buildReplenishmentProposal();
  const bySku = new Map<string, ReplenishmentLine>(proposal.lines.map((l) => [l.sku, l]));

  const warnings: string[] = [];
  const rejected: TransferPlan["rejected"] = [];
  const lines: TransferPlan["lines"] = [];

  // Merge duplicate SKUs before validating, so two lines for one SKU are
  // checked against stock as the single quantity they actually represent.
  const merged = new Map<string, number>();
  for (const l of opts.lines) {
    const qty = Math.trunc(l.quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      rejected.push({ sku: l.sku, requested: l.quantity, reason: "Quantity must be a positive whole number." });
      continue;
    }
    merged.set(l.sku, (merged.get(l.sku) ?? 0) + qty);
  }

  for (const [sku, quantity] of merged) {
    const p = bySku.get(sku);
    if (!p) {
      rejected.push({
        sku, requested: quantity,
        reason: "Not in the current replenishment proposal — re-run the restock sync, or the SKU is not listed on Amazon.",
      });
      continue;
    }
    if (quantity > p.warehouseAvailable) {
      rejected.push({
        sku, requested: quantity,
        reason: `Warehouse holds ${p.warehouseAvailable}. Shipping more than exists would fail at the pick, not here.`,
      });
      continue;
    }
    if (quantity > p.proposedQty) {
      // Allowed — the operator may be seeding a launch or covering a
      // promotion the model cannot see. Flagged, not blocked.
      warnings.push(
        `${sku}: shipping ${quantity} against a proposed ${p.proposedQty}. ` +
        `Paid velocity is ${p.paidUnits30d} units/30d, so this is roughly ` +
        `${p.paidUnits30d > 0 ? Math.round((quantity / (p.paidUnits30d / 30)) ) : "∞"} days of cover.`,
      );
    }

    lines.push({
      // ShipHero picks our warehouse spelling, which is the Amazon SKU minus
      // the -FBA suffix. Sending the Amazon spelling would not match a pick.
      warehouseSku: sku.replace(/-FBA$/i, ""),
      amazonSku: sku,
      title: p.title,
      quantity,
      landedCostPerUnit: p.landedCostPerUnit,
      valueAtCost: round2(quantity * (p.landedCostPerUnit ?? 0)),
    });
  }

  lines.sort((a, b) => a.warehouseSku.localeCompare(b.warehouseSku));

  const noCost = lines.filter((l) => l.landedCostPerUnit === null);
  if (noCost.length > 0) {
    warnings.push(
      `${noCost.length} SKU(s) have no FIFO layer, so the value moving is understated. ` +
      `They will still ship; the transfer carries no accounting entry either way.`,
    );
  }

  const shipheroCsv = buildCsv([
    [...SHIPHERO_TRANSFER_HEADERS],
    ...lines.map((l) => [
      opts.reference, "", date, l.warehouseSku, l.quantity,
      // $0: a transfer between our own locations, never a sale.
      0, "FBA Inbound", `FBA transfer ${opts.reference} — stock transfer, not a sale`,
    ]),
  ]);

  const fbaPlanCsv = buildCsv([
    [...FBA_PLAN_HEADERS],
    ...lines.map((l) => [l.amazonSku, l.quantity, l.title ?? ""]),
  ]);

  return {
    reference: opts.reference,
    createdFor: date,
    lines,
    totals: {
      skus: lines.length,
      units: lines.reduce((t, l) => t + l.quantity, 0),
      valueAtCost: round2(lines.reduce((t, l) => t + l.valueAtCost, 0)),
    },
    shipheroCsv, fbaPlanCsv, warnings, rejected,
  };
}

/**
 * Build a transfer straight from the proposal's own recommended quantities.
 *
 * The "just do what it says" path. Still reviewable — it returns the same
 * plan object and sends nothing.
 */
export function buildFbaTransferFromProposal(opts?: {
  reference?: string;
  coverDays?: number;
  date?: string;
}): TransferPlan {
  const proposal = buildReplenishmentProposal({ coverDays: opts?.coverDays });
  const date = opts?.date ?? new Date().toISOString().slice(0, 10);
  const reference = opts?.reference ?? `FBA-${date.replace(/-/g, "")}`;

  return buildFbaTransfer({
    reference, date, proposal,
    lines: proposal.lines
      .filter((l) => l.proposedQty > 0)
      .map((l) => ({ sku: l.sku, quantity: l.proposedQty })),
  });
}

/**
 * Record that a transfer was generated, and what Amazon should expect.
 *
 * Written so days-of-cover reflects in-flight stock immediately rather than
 * waiting for Amazon to acknowledge the inbound shipment — which can take
 * days, during which the proposal would keep recommending the same units and
 * a second shipment could go out for stock already on a truck.
 */
export function recordFbaTransfer(plan: TransferPlan): { recorded: number } {
  const insert = sqlite.prepare(`
    INSERT INTO amazon_fba_transfers
      (id, reference, created_for, sku, warehouse_sku, quantity, landed_cost_per_unit, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(reference, sku) DO UPDATE SET
      quantity = excluded.quantity,
      landed_cost_per_unit = excluded.landed_cost_per_unit
  `);
  const tx = sqlite.transaction((rows: TransferPlan["lines"]) => {
    for (const l of rows) {
      insert.run(
        crypto.randomUUID(), plan.reference, plan.createdFor,
        l.amazonSku, l.warehouseSku, l.quantity, l.landedCostPerUnit,
      );
    }
  });
  tx(plan.lines);
  return { recorded: plan.lines.length };
}
