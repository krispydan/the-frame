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
  shopifyPayoutUrl,
  type InvoiceComponent,
  type XeroInvoicePayload,
} from "@/modules/integrations/lib/xero/settlement-invoice-builder";
import { postManualJournal } from "@/modules/finance/lib/xero-client";
import { loadChannelXeroConfig } from "@/modules/finance/lib/shipment-revenue-recognition";

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

/**
 * Per-payout "delta plug" — the gap between (gross − fees + adjustments) and the
 * actual net deposit, caused by deductions the historical `settlements` rows
 * don't itemize (Faire promotions / damaged-missing / shipping labels, some
 * Shopify refunds). Booked so the invoice still ties to the deposit 1:1, flagged
 * for the bookkeeper to recategorize. The forward live flow itemizes these from
 * the APIs, so the plug is a historical-only artifact.
 */
const PLUG_NEG_ACCOUNT = "4300"; // net deposit LOWER than lines → contra-revenue (refunds/promos)
const PLUG_POS_ACCOUNT = "4060"; // net deposit HIGHER than lines → income (overpayment/passthrough)

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

  // Delta plug so the invoice ties to the actual net deposit (see PLUG_* note).
  const lineTotal = comps.reduce((sum, c) => sum + (c.kind === "revenue" ? c.amount : -c.amount), 0);
  const plug = round2(round2(s.netAmount) - round2(lineTotal));
  if (plug > 0.01) comps.push({ category: "settlement_delta", accountCode: PLUG_POS_ACCOUNT, amount: plug, kind: "revenue", description: `Settlement delta (+) — ${ref} (REVIEW: unitemized passthrough/overpayment)` });
  else if (plug < -0.01) comps.push({ category: "settlement_delta", accountCode: PLUG_NEG_ACCOUNT, amount: Math.abs(plug), kind: "contra", description: `Settlement delta (−) — ${ref} (REVIEW: unitemized refunds/promos/deductions)` });
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
  /** Total of all plug lines booked (the unitemized deduction gap). */
  plugTotal: number;
  /** Net-negative payouts — become credit notes, not invoices. */
  creditNotes: Array<{ settlementId: string; channel: string; invoiceNumber: string; net: number }>;
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
    feesTotal: 0, netToBankTotal: 0, byChannel: {}, deltaCount: 0, plugTotal: 0,
    creditNotes: [], samples: [],
  };
  const sampleSize = opts.sampleSize ?? 5;

  for (const s of rows) {
    // Net-negative payout (refunds/chargebacks exceeded sales) → credit note, not an ACCREC invoice.
    if (round2(s.netAmount) <= 0) {
      res.creditNotes.push({ settlementId: s.id, channel: s.channel, invoiceNumber: invoiceNumberFor(s), net: round2(s.netAmount) });
      continue;
    }
    const comps = componentsForSettlement(s);
    const plugComp = comps.find((c) => c.category === "settlement_delta");
    if (plugComp) res.plugTotal = round2(res.plugTotal + (plugComp.kind === "revenue" ? plugComp.amount : -plugComp.amount));
    const payoutUrl = shopifyPayoutUrl(s.channel, (s.externalId ?? "").replace(/^shopify_payout_/, ""));
    const reference = payoutUrl ? `${s.externalId} — ${payoutUrl}` : (s.externalId ?? s.id);
    const built = buildSettlementInvoice({
      channel: s.channel,
      contactName: CONTACT[s.channel] ?? s.channel,
      invoiceNumber: invoiceNumberFor(s),
      reference,
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

/**
 * Historical cleanup — Entry 1 (P&L fix). Recognizes the revenue stranded in
 * Deferred Revenue under the old model by posting a single adjusting journal:
 *
 *   DR 2050 Deferred Revenue   (total)
 *     CR 4030/4040/4000 Sales  (target gross − current Xero balance, per channel)
 *
 * Target gross comes from `settlements`; `currentSales` is the live Xero balance
 * per account (caller supplies it from the P&L). Sales-Channel-tracked. Leaves
 * the remaining Deferred balance (the gross/net asymmetry + direct-to-deferred
 * deposits) for the balance-sheet reconciliation (Entry 2). dryRun returns the
 * payload without posting.
 */
export async function restateDeferredToSales(opts: {
  currentSales: Record<string, number>;
  date: string;
  deferredAccount?: string;
  dryRun?: boolean;
}): Promise<{
  dryRun: boolean;
  totalRecognized: number;
  recognized: Record<string, number>;
  payload: { Narration: string; Date: string; Status: "POSTED"; JournalLines: Array<Record<string, unknown>> };
  success?: boolean;
  manualJournalId?: string;
  error?: string;
}> {
  const deferredAccount = opts.deferredAccount ?? "2050";
  const rows = sqlite
    .prepare("SELECT channel, ROUND(SUM(gross_amount),2) AS gross FROM settlements WHERE gross_amount > 0 GROUP BY channel")
    .all() as Array<{ channel: string; gross: number }>;

  const lines: Array<Record<string, unknown>> = [];
  const recognized: Record<string, number> = {};
  let totalCredit = 0;

  for (const r of rows) {
    const acct = SALES_ACCOUNT[r.channel];
    if (!acct) continue;
    const inc = round2(r.gross - (opts.currentSales[acct] ?? 0));
    if (inc <= 0.01) continue;
    const cfg = await loadChannelXeroConfig(r.channel);
    const tracking = cfg?.trackingCategoryId
      ? [{ TrackingCategoryID: cfg.trackingCategoryId, Name: cfg.trackingCategoryName ?? undefined, Option: cfg.trackingOptionName ?? "" }]
      : undefined;
    lines.push({
      LineAmount: -inc, // credit revenue
      AccountCode: acct,
      Description: `Restate stranded revenue — ${r.channel} (settlement-date model)`,
      ...(tracking ? { Tracking: tracking } : {}),
    });
    recognized[acct] = inc;
    totalCredit = round2(totalCredit + inc);
  }

  lines.push({
    LineAmount: totalCredit, // debit Deferred Revenue
    AccountCode: deferredAccount,
    Description: "Recognize revenue stranded in Deferred Revenue (settlement-date restatement)",
  });

  const payload = {
    Narration: `Deferred-revenue restatement → Sales (settlement-date model) | ${totalCredit.toFixed(2)} | Generated by the-frame`,
    Date: opts.date,
    Status: "POSTED" as const,
    JournalLines: lines,
  };

  if (opts.dryRun) return { dryRun: true, totalRecognized: totalCredit, recognized, payload };

  const post = await postManualJournal(payload);
  return post.success
    ? { dryRun: false, totalRecognized: totalCredit, recognized, payload, success: true, manualJournalId: post.manualJournalId }
    : { dryRun: false, totalRecognized: totalCredit, recognized, payload, success: false, error: post.error };
}
