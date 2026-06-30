/**
 * Settlement-date revenue model (per finance/Jaxy_Channel_Payout_Mapping_Guide).
 *
 * This module computes the per-payout ACCREC invoices and the restated revenue
 * that REPLACE the old deferred-revenue flow. It is READ-ONLY here — it builds
 * invoice payloads and aggregates from the `settlements` table without touching
 * Xero. Use `previewSettlementInvoices()` to see exactly what would post and the
 * restated revenue by account before any live cutover.
 *
 * Forward posting + historical cutover (the parts that write to Xero) build on
 * top of this and the pure builder in
 * integrations/lib/xero/settlement-invoice-builder.ts.
 */

import { sqlite } from "@/lib/db";
import {
  buildSettlementInvoice,
  type InvoiceComponent,
  type XeroInvoicePayload,
} from "@/modules/integrations/lib/xero/settlement-invoice-builder";

/** Channel → Sales account, per the mapping guide. */
const SALES_ACCOUNT: Record<string, string> = {
  shopify_dtc: "4000",
  shopify_wholesale: "4030",
  faire: "4040",
  amazon: "4010",
};
/** Channel → fees account (aggregate). Faire fees split commission/processing
 *  at live-sync time; from persisted settlements we only have the total, so the
 *  preview books it to the commission account and labels it aggregate. */
const FEE_ACCOUNT: Record<string, string> = {
  shopify_dtc: "5400",
  shopify_wholesale: "5400",
  faire: "5450",
  amazon: "5410",
};
const CONTACT: Record<string, string> = {
  shopify_dtc: "Shopify Payments",
  shopify_wholesale: "Shopify Wholesale",
  faire: "Faire",
  amazon: "Amazon",
};
/** Signed balance adjustments land here (income or shrinkage depending on sign). */
const ADJ_INCOME_ACCOUNT = "4060"; // shipping income / passthrough (positive)
const ADJ_EXPENSE_ACCOUNT = "5900"; // inventory adjustments & shrinkage (negative)

const round2 = (n: number): number => Math.round(n * 100) / 100;

type SettlementRow = {
  id: string;
  channel: string;
  externalId: string | null;
  grossAmount: number;
  fees: number;
  adjustments: number;
  netAmount: number;
  periodEnd: string;
  status: string;
  xeroTransactionId: string | null;
};

/** Build the invoice components for one settlement, per the guide. */
export function componentsForSettlement(s: SettlementRow): InvoiceComponent[] {
  const sales = SALES_ACCOUNT[s.channel] ?? "4050";
  const feeAcct = FEE_ACCOUNT[s.channel] ?? "5440";
  const ref = s.externalId ?? s.id;
  const comps: InvoiceComponent[] = [
    { category: "sales", accountCode: sales, amount: round2(s.grossAmount), kind: "revenue", description: `Gross sales — ${ref}` },
  ];
  if (round2(s.fees) > 0) {
    comps.push({ category: "fees", accountCode: feeAcct, amount: round2(s.fees), kind: "contra", description: `Fees — ${ref}${s.channel === "faire" ? " (commission + processing, aggregate)" : ""}` });
  }
  const adj = round2(s.adjustments);
  if (adj > 0) comps.push({ category: "adjustments", accountCode: ADJ_INCOME_ACCOUNT, amount: adj, kind: "revenue", description: `Balance adjustment (+) — ${ref}` });
  else if (adj < 0) comps.push({ category: "adjustments", accountCode: ADJ_EXPENSE_ACCOUNT, amount: Math.abs(adj), kind: "contra", description: `Balance adjustment (−) — ${ref}` });
  return comps;
}

/** Stable per-payout invoice number for idempotency. */
export function invoiceNumberFor(s: SettlementRow): string {
  const prefix = { shopify_dtc: "SHOP-DTC", shopify_wholesale: "SHOP-WS", faire: "FAIRE", amazon: "AMZN" }[s.channel] ?? "SETL";
  const ref = (s.externalId ?? s.id).replace(/^.*_/, "").toUpperCase();
  return `${prefix}-${ref}`;
}

export type SettlementInvoicePreview = {
  settlementId: string;
  channel: string;
  invoiceNumber: string;
  date: string;
  gross: number;
  fees: number;
  adjustments: number;
  net: number;
  total: number;
  delta: number;
  warnings: string[];
  payload: XeroInvoicePayload | null;
};

export type SettlementPreviewResult = {
  range: { from: string | null; to: string | null };
  count: number;
  /** Restated revenue (gross) by Sales account — the new P&L revenue. */
  revenueByAccount: Record<string, number>;
  feesByAccount: Record<string, number>;
  restatedRevenueTotal: number;
  feesTotal: number;
  netToBankTotal: number;
  /** Per-channel rollup. */
  byChannel: Record<string, { count: number; gross: number; fees: number; adjustments: number; net: number }>;
  /** Payouts whose invoice lines don't tie to net (need review). */
  deltaCount: number;
  /** A few rendered invoices for eyeballing. */
  samples: SettlementInvoicePreview[];
};

/**
 * Render the ACCREC invoices for settlements in a date range (READ-ONLY).
 * Returns restated revenue by account + sample invoices. Nothing is posted.
 */
export function previewSettlementInvoices(opts: { from?: string; to?: string; sampleSize?: number } = {}): SettlementPreviewResult {
  const where: string[] = ["gross_amount > 0"];
  const params: string[] = [];
  if (opts.from) { where.push("period_end >= ?"); params.push(opts.from); }
  if (opts.to) { where.push("period_end <= ?"); params.push(opts.to); }
  const rows = sqlite.prepare(`
    SELECT id, channel, external_id AS externalId, gross_amount AS grossAmount,
           fees, adjustments, net_amount AS netAmount, period_end AS periodEnd,
           status, xero_transaction_id AS xeroTransactionId
    FROM settlements
    WHERE ${where.join(" AND ")}
    ORDER BY period_end ASC, gross_amount DESC
  `).all(...params) as SettlementRow[];

  const res: SettlementPreviewResult = {
    range: { from: opts.from ?? null, to: opts.to ?? null },
    count: 0, revenueByAccount: {}, feesByAccount: {}, restatedRevenueTotal: 0,
    feesTotal: 0, netToBankTotal: 0, byChannel: {}, deltaCount: 0, samples: [],
  };
  const sampleSize = opts.sampleSize ?? 5;

  for (const s of rows) {
    const comps = componentsForSettlement(s);
    const built = buildSettlementInvoice({
      channel: s.channel,
      contactName: CONTACT[s.channel] ?? s.channel,
      invoiceNumber: invoiceNumberFor(s),
      reference: s.externalId ?? s.id,
      date: s.periodEnd,
      netPayout: round2(s.netAmount),
      components: comps,
      status: "AUTHORISED",
    });

    res.count++;
    const salesAcct = SALES_ACCOUNT[s.channel] ?? "4050";
    const feeAcct = FEE_ACCOUNT[s.channel] ?? "5440";
    res.revenueByAccount[salesAcct] = round2((res.revenueByAccount[salesAcct] ?? 0) + s.grossAmount);
    if (s.fees > 0) res.feesByAccount[feeAcct] = round2((res.feesByAccount[feeAcct] ?? 0) + s.fees);
    res.restatedRevenueTotal = round2(res.restatedRevenueTotal + s.grossAmount);
    res.feesTotal = round2(res.feesTotal + s.fees);
    res.netToBankTotal = round2(res.netToBankTotal + s.netAmount);

    const ch = (res.byChannel[s.channel] ??= { count: 0, gross: 0, fees: 0, adjustments: 0, net: 0 });
    ch.count++; ch.gross = round2(ch.gross + s.grossAmount); ch.fees = round2(ch.fees + s.fees);
    ch.adjustments = round2(ch.adjustments + s.adjustments); ch.net = round2(ch.net + s.netAmount);

    const preview: SettlementInvoicePreview = {
      settlementId: s.id, channel: s.channel, invoiceNumber: invoiceNumberFor(s),
      date: s.periodEnd, gross: round2(s.grossAmount), fees: round2(s.fees),
      adjustments: round2(s.adjustments), net: round2(s.netAmount),
      total: built.ok ? built.total : 0, delta: built.ok ? built.delta : NaN,
      warnings: built.ok ? built.warnings : [built.error],
      payload: built.ok ? built.payload : null,
    };
    if (!built.ok || Math.abs(built.delta) > 0.01) res.deltaCount++;
    if (res.samples.length < sampleSize) res.samples.push(preview);
  }

  return res;
}
