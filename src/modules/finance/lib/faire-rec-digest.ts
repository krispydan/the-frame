/**
 * Daily Faire reconciliation digest — invoice-side detection.
 *
 * Xero's granular scopes expose no statement-line report (probed 2026-08-05:
 * every accounting.reports.*bankstatement* spelling is invalid_scope, and
 * banksummary.read 401s on Reports/BankStatement), so instead of reading the
 * bank feed we work from what we CAN see with existing scopes:
 *
 *   - every OPEN (AUTHORISED) ACCREC invoice numbered FAIRE-<order> IS an
 *     unreconciled deposit waiting in bank rec, and
 *   - every OPEN ACCPAY bill numbered FAIRE-IC-<order> IS an incoming
 *     FAIRE WHOLESALE clawback debit waiting to be matched.
 *
 * For each open invoice we recompute the payout math from the synced summary
 * (gross − commission − processing) and compare it to the invoice total. When
 * they differ, the wire usually lands as one of the two numbers, so the digest
 * pre-writes both playbooks (deposit-higher → Receive Money delta to 5900;
 * deposit-lower → part-payment, expect the remainder). Old invoices get an
 * age flag. Slack topic: finance.faire_rec_digest. Silent when clean.
 */

import { sqlite } from "@/lib/db";
import { xeroAdminFetch } from "@/modules/finance/lib/xero-client";

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface RecItem {
  invoiceNumber: string;
  date: string;
  amountDue: number;
  orderCode: string | null;
  instruction: string;
}

export interface FaireRecDigestResult {
  ok: boolean;
  openInvoices: number;
  openBills: number;
  lines: RecItem[];
  error?: string;
}

/** Payout math stored at sync time (xero_journal_log settlement_invoice payload). */
export interface PayoutMath {
  netOrderTotal: number;
  commission: number;
  paymentFee: number;
  totalPayout: number;
}

export function extractOrderCode(invoiceNumber: string): string | null {
  const m = invoiceNumber.match(/^FAIRE-(?:IC-)?([A-Z0-9]{8,12})$/i);
  return m ? m[1].toUpperCase() : null;
}

/** Build the instruction for one open FAIRE- invoice. */
export function classifyOpenInvoice(opts: {
  invoiceNumber: string;
  amountDue: number;
  ageDays: number;
  math: PayoutMath | null;
}): string {
  const { invoiceNumber, amountDue, ageDays, math } = opts;
  const stale = ageDays > 10 ? ` ⏰ open ${ageDays}d — if no deposit by now, check Faire for a hold/issue report.` : "";

  if (!math) return `Deposit of $${amountDue.toFixed(2)} expected — Find & Match → ${invoiceNumber}.${stale}`;

  const formulaWire = round2(math.netOrderTotal - math.commission - math.paymentFee);
  const invTotal = round2(amountDue);
  if (Math.abs(formulaWire - invTotal) <= 0.01) {
    return `Deposit of $${invTotal.toFixed(2)} expected — Find & Match → ${invoiceNumber} (exact).${stale}`;
  }
  if (formulaWire > invTotal) {
    const delta = round2(formulaWire - invTotal);
    return `Deposit may arrive as $${formulaWire.toFixed(2)} (Faire's fee math) instead of the $${invTotal.toFixed(2)} invoice — if so: Match ${invoiceNumber} + add Receive Money $${delta.toFixed(2)} → 5900 (reverses the payout-delta plug). If it arrives as $${invTotal.toFixed(2)}, just Match.${stale}`;
  }
  const shortfall = round2(invTotal - formulaWire);
  return `Deposit may arrive short (≈$${formulaWire.toFixed(2)} vs the $${invTotal.toFixed(2)} invoice) — part-pay ${invoiceNumber} and expect a second deposit of ≈$${shortfall.toFixed(2)} (Faire hold/issue release). If it arrives in full, just Match.${stale}`;
}

/** Load the payout math for an order from the stored settlement-invoice payload. */
export function loadPayoutMath(orderCode: string): PayoutMath | null {
  const row = sqlite.prepare(
    "SELECT payload FROM xero_journal_log WHERE source_id = ? AND xero_object_type='invoice' AND status='success' ORDER BY rowid DESC LIMIT 1",
  ).get("bo_" + orderCode.toLowerCase()) as { payload: string | null } | undefined;
  if (!row?.payload) return null;
  try {
    const s = JSON.parse(row.payload)?.summary;
    if (!s) return null;
    return {
      netOrderTotal: Number(s.netOrderTotal) || 0,
      commission: Number(s.commission) || 0,
      paymentFee: Number(s.paymentFee) || 0,
      totalPayout: Number(s.totalPayout) || 0,
    };
  } catch {
    return null;
  }
}

type XeroInvoice = {
  InvoiceNumber?: string;
  InvoiceID?: string;
  Type?: string;
  Status?: string;
  AmountDue?: number;
  DateString?: string;
  Date?: string;
};

/** Parse Xero's /Date(1690848000000+0000)/ or ISO DateString into YYYY-MM-DD. */
function xeroDate(inv: XeroInvoice): string {
  if (inv.DateString) return inv.DateString.slice(0, 10);
  const m = String(inv.Date || "").match(/\/Date\((\d+)/);
  if (m) return new Date(parseInt(m[1], 10)).toISOString().slice(0, 10);
  return "";
}

/**
 * Pull open FAIRE- invoices + FAIRE-IC bills from Xero and build the digest.
 * Read-only. Uses only scopes the app already holds (accounting.invoices).
 */
export async function runFaireRecDigest(): Promise<FaireRecDigestResult> {
  const res: FaireRecDigestResult = { ok: false, openInvoices: 0, openBills: 0, lines: [] };

  const where = encodeURIComponent('Status=="AUTHORISED" AND Contact.Name=="Faire"');
  const invRes = await xeroAdminFetch(`/api.xro/2.0/Invoices?where=${where}&pageSize=200`);
  if (!invRes.success) { res.error = `invoices: ${invRes.error}`; return res; }
  const invoices = ((invRes.data as { Invoices?: XeroInvoice[] }).Invoices || [])
    .filter((i) => /^FAIRE-/i.test(i.InvoiceNumber || ""));

  const today = Date.now();
  for (const inv of invoices) {
    const num = inv.InvoiceNumber || "";
    const code = extractOrderCode(num);
    const amountDue = round2(Number(inv.AmountDue) || 0);
    if (amountDue === 0) continue;
    const date = xeroDate(inv);
    const ageDays = date ? Math.floor((today - new Date(date).getTime()) / 86400000) : 0;

    if (inv.Type === "ACCPAY") {
      res.openBills++;
      res.lines.push({
        invoiceNumber: num, date, amountDue, orderCode: code,
        instruction: `Expect a FAIRE WHOLESALE bank DEBIT of $${amountDue.toFixed(2)} — Match it to bill ${num} (issue-credit clawback).`,
      });
      continue;
    }

    res.openInvoices++;
    res.lines.push({
      invoiceNumber: num, date, amountDue, orderCode: code,
      instruction: classifyOpenInvoice({ invoiceNumber: num, amountDue, ageDays, math: code ? loadPayoutMath(code) : null }),
    });
  }

  // Oldest first — those are the ones blocking a clean bank rec.
  res.lines.sort((a, b) => (a.date < b.date ? -1 : 1));
  res.ok = true;
  return res;
}
