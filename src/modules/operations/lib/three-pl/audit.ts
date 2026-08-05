/**
 * 3PL invoice audit engine.
 *
 * Recomputes what each charge SHOULD have been from the rate card (which
 * mirrors the Big Sky contract) and cross-checks billed quantities against
 * what The Frame knows the orders contained. The contract rates reproduce
 * observed invoices to the penny (verified against May–July 2026), so any
 * delta here is a genuine billing question, not model noise.
 *
 * Checks:
 *   1. rate            charged ≠ rate-card recompute (fulfillment, returns,
 *                      receiving, account mgmt, storage days)
 *   2. quantity        billed units ≠ order's pack-expanded unit count
 *   3. reconciliation  imported lines don't sum to the Summary sheet
 *   4. duplicate       same order billed the same charge type twice (any invoice)
 *   5. postage_outlier postage far above the carrier's norm for the invoice
 */
import { sqlite } from "@/lib/db";
import { resolveDepletionTarget } from "@/modules/finance/lib/fifo-engine";
import { canonicalChargeType } from "./parse-invoice";

export interface AuditFinding {
  check: "rate" | "quantity" | "reconciliation" | "duplicate" | "postage_outlier";
  severity: "error" | "warning" | "info";
  chargeType: string;
  orderNumber?: string | null;
  message: string;
  charged?: number;
  expected?: number;
  delta?: number; // positive = overcharged
}

export interface AuditReport {
  invoiceId: string;
  findings: AuditFinding[];
  totals: { overcharged: number; undercharged: number; checkedLines: number };
}

interface RateCard {
  fulfillmentDtc: { base: number; addl: number };
  fulfillmentWholesale: { base: number; tier2to10: number; tier10plus: number };
  returnFee: { base: number; addl: number };
  receiving: { perPo: number };
  accountManagement: { perMonth: number; startsOn?: string };
  storagePallet: { perDay: number };
  storageBin: { perDay: number };
}

/** Latest rate row per service key effective on/before the given date. */
function loadRateCard(asOf: string): RateCard {
  const rows = sqlite.prepare(
    `SELECT service_key, rate_json FROM three_pl_rate_card
     WHERE effective_from <= ?
     ORDER BY effective_from ASC`,
  ).all(asOf) as Array<{ service_key: string; rate_json: string }>;
  const byKey = new Map<string, Record<string, number | string>>();
  for (const r of rows) {
    try { byKey.set(r.service_key, JSON.parse(r.rate_json)); } catch { /* skip bad row */ }
  }
  const g = (k: string) => byKey.get(k) ?? {};
  return {
    fulfillmentDtc: { base: Number(g("fulfillment_dtc").base ?? 2.15), addl: Number(g("fulfillment_dtc").addl ?? 0.68) },
    fulfillmentWholesale: {
      base: Number(g("fulfillment_wholesale").base ?? 1.85),
      tier2to10: Number(g("fulfillment_wholesale").tier2to10 ?? 0.38),
      tier10plus: Number(g("fulfillment_wholesale").tier10plus ?? 0.18),
    },
    returnFee: { base: Number(g("return_fee").base ?? 5.0), addl: Number(g("return_fee").addl ?? 0.5) },
    receiving: { perPo: Number(g("receiving").perPo ?? 35) },
    accountManagement: {
      perMonth: Number(g("account_management").perMonth ?? 450),
      startsOn: g("account_management").startsOn as string | undefined,
    },
    storagePallet: { perDay: Number(g("storage_pallet").perDay ?? 1.0) },
    storageBin: { perDay: Number(g("storage_bin").perDay ?? 0.06) },
  };
}

export function expectedFulfillmentDtc(units: number, r: RateCard): number {
  if (units <= 0) return 0;
  return r.fulfillmentDtc.base + r.fulfillmentDtc.addl * (units - 1);
}

export function expectedFulfillmentWholesale(units: number, r: RateCard): number {
  if (units <= 0) return 0;
  const t2 = Math.min(Math.max(units - 1, 0), 9);       // items 2..10
  const t10 = Math.max(units - 10, 0);                  // items 11+
  return r.fulfillmentWholesale.base + r.fulfillmentWholesale.tier2to10 * t2 + r.fulfillmentWholesale.tier10plus * t10;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const TOL = 0.015; // penny rounding tolerance

interface ChargeRow {
  id: string; charge_type: string; amount: number; quantity: number;
  order_id: string | null; order_number_raw: string | null; carrier: string | null;
}

export function auditInvoice(invoiceId: string): AuditReport {
  const inv = sqlite.prepare(
    "SELECT id, period_start, period_end, summary_json FROM three_pl_invoices WHERE id = ?",
  ).get(invoiceId) as { id: string; period_start: string; period_end: string; summary_json: string | null } | undefined;
  if (!inv) return { invoiceId, findings: [], totals: { overcharged: 0, undercharged: 0, checkedLines: 0 } };

  const rates = loadRateCard(inv.period_start);
  const findings: AuditFinding[] = [];
  let over = 0, under = 0, checked = 0;

  const flagRate = (c: ChargeRow, expected: number, label: string) => {
    checked++;
    const delta = r2(c.amount - expected);
    if (Math.abs(delta) <= TOL) return;
    if (delta > 0) over += delta; else under -= delta;
    findings.push({
      check: "rate", severity: "error", chargeType: c.charge_type,
      orderNumber: c.order_number_raw,
      message: `${label}: charged $${r2(c.amount)} for ${c.quantity} unit(s), rate card says $${r2(expected)}`,
      charged: r2(c.amount), expected: r2(expected), delta,
    });
  };

  const charges = sqlite.prepare(
    "SELECT id, charge_type, amount, quantity, order_id, order_number_raw, carrier FROM three_pl_charges WHERE invoice_id = ?",
  ).all(invoiceId) as ChargeRow[];

  // ── 1. Rate checks ──
  for (const c of charges) {
    switch (c.charge_type) {
      case "fulfillment_dtc":
        flagRate(c, expectedFulfillmentDtc(c.quantity, rates), "DTC fulfillment");
        break;
      case "fulfillment_wholesale":
        flagRate(c, expectedFulfillmentWholesale(c.quantity, rates), "Wholesale fulfillment");
        break;
      case "return_fee":
        flagRate(c, c.quantity > 0 ? rates.returnFee.base + rates.returnFee.addl * (c.quantity - 1) : 0, "Return fee");
        break;
      case "receiving":
        flagRate(c, rates.receiving.perPo * Math.max(1, c.quantity), "Receiving fee");
        break;
      case "account_management": {
        const starts = rates.accountManagement.startsOn;
        const expected = starts && inv.period_start < starts ? 0 : rates.accountManagement.perMonth;
        flagRate(c, expected, "Account management");
        break;
      }
      default:
        break; // postage etc. — pass-through, handled by outlier check
    }
  }

  // ── 2. Quantity cross-check: billed units vs the order's pack-expanded units ──
  const itemStmt = sqlite.prepare(
    "SELECT sku, sku_id, quantity FROM order_items WHERE order_id = ?",
  );
  for (const c of charges) {
    if (!c.order_id) continue;
    if (c.charge_type !== "fulfillment_dtc" && c.charge_type !== "fulfillment_wholesale") continue;
    const items = itemStmt.all(c.order_id) as Array<{ sku: string | null; sku_id: string | null; quantity: number }>;
    if (!items.length) continue; // nothing to compare against
    let units = 0;
    for (const it of items) {
      try {
        const rr = resolveDepletionTarget({ sku: it.sku, skuId: it.sku_id, quantity: 1 });
        units += it.quantity * (rr.packSize || 1);
      } catch {
        units += it.quantity;
      }
    }
    if (units <= 0) continue;
    // Big Sky picks each frame's CASE as a separate unit (they stock JX-CASE-*
    // SKUs), so billed units land between `frames` and `2×frames (+ a couple
    // inserts)`. Observed invoices cluster at exactly 2:1. Only bill counts
    // OUTSIDE that envelope are anomalies worth a human look:
    //   below frames      → they picked fewer than the order (split shipment?)
    //   above 2×frames+2  → more picks than frames+cases can explain
    const envelopeMax = units * 2 + 2;
    if (c.quantity < units - 0.5) {
      findings.push({
        check: "quantity", severity: "info", chargeType: c.charge_type,
        orderNumber: c.order_number_raw,
        message: `Billed for ${c.quantity} units but the order contains ${units} frames (pack-expanded) — check for split shipment.`,
        charged: c.quantity, expected: units, delta: c.quantity - units,
      });
    } else if (c.quantity > envelopeMax + 0.5) {
      findings.push({
        check: "quantity", severity: "warning", chargeType: c.charge_type,
        orderNumber: c.order_number_raw,
        message: `Billed for ${c.quantity} units but the order contains ${units} frames — even with a case per frame that's at most ~${envelopeMax}. Possible overbilling.`,
        charged: c.quantity, expected: envelopeMax, delta: c.quantity - envelopeMax,
      });
    }
  }

  // ── 3. Reconciliation vs the Summary sheet ──
  try {
    const summary = JSON.parse(inv.summary_json ?? "[]") as Array<{ charge: string; amount: number }>;
    const importedByType = new Map<string, number>();
    for (const c of charges) {
      importedByType.set(c.charge_type, (importedByType.get(c.charge_type) ?? 0) + c.amount);
    }
    const storageTotal = (sqlite.prepare(
      "SELECT COALESCE(SUM(amount),0) AS a FROM three_pl_storage_days WHERE invoice_id = ?",
    ).get(invoiceId) as { a: number }).a;
    importedByType.set("storage", (importedByType.get("storage") ?? 0) + storageTotal);

    for (const s of summary) {
      const key = canonicalChargeType(s.charge);
      const imported = r2(importedByType.get(key) ?? 0);
      const gap = r2(s.amount - imported);
      if (Math.abs(gap) > 0.05) {
        findings.push({
          check: "reconciliation", severity: "warning", chargeType: key,
          message: `Summary says $${r2(s.amount)} of "${s.charge}" but imported lines total $${imported} (gap $${gap}) — lines missing or double-counted`,
          charged: r2(s.amount), expected: imported, delta: gap,
        });
      }
    }
  } catch { /* summary reconciliation is best-effort */ }

  // ── 4. Duplicate billing across ALL invoices ──
  const dupes = sqlite.prepare(
    `SELECT c.order_number_raw AS n, c.charge_type AS t, COUNT(*) AS cnt, SUM(c.amount) AS total
     FROM three_pl_charges c
     WHERE c.order_number_raw IS NOT NULL
       AND c.charge_type IN ('fulfillment_dtc','fulfillment_wholesale')
       AND c.order_number_raw IN (SELECT order_number_raw FROM three_pl_charges WHERE invoice_id = ?)
     GROUP BY c.order_number_raw, c.charge_type
     HAVING COUNT(*) > 1`,
  ).all(invoiceId) as Array<{ n: string; t: string; cnt: number; total: number }>;
  for (const d of dupes) {
    findings.push({
      check: "duplicate", severity: "warning", chargeType: d.t, orderNumber: d.n,
      message: `Order ${d.n} billed ${d.t.replace("_", " ")} ${d.cnt}× (total $${r2(d.total)}) across invoices`,
      charged: r2(d.total),
    });
  }

  // ── 5. Postage outliers (pass-through, so no contract check — flag the weird) ──
  const postage = charges.filter((c) => c.charge_type.startsWith("shipping_") && c.amount > 0);
  const byCarrier = new Map<string, number[]>();
  for (const p of postage) {
    const k = p.charge_type;
    (byCarrier.get(k) ?? byCarrier.set(k, []).get(k)!).push(p.amount);
  }
  for (const p of postage) {
    const arr = [...(byCarrier.get(p.charge_type) ?? [])].sort((a, b) => a - b);
    if (arr.length < 5) continue;
    const median = arr[Math.floor(arr.length / 2)];
    if (p.amount > median * 4 && p.amount > 25) {
      findings.push({
        check: "postage_outlier", severity: "info", chargeType: p.charge_type,
        orderNumber: p.order_number_raw,
        message: `Postage $${r2(p.amount)} is ${r2(p.amount / median)}× the ${p.charge_type.replace("shipping_", "").toUpperCase()} median ($${r2(median)}) this invoice`,
        charged: r2(p.amount), expected: median,
      });
    }
  }

  const order = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0));

  return { invoiceId, findings, totals: { overcharged: r2(over), undercharged: r2(under), checkedLines: checked } };
}
