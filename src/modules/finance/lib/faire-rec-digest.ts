/**
 * Daily Faire bank-reconciliation digest.
 *
 * Pulls Mercury's recent bank statement lines from Xero (Reports/BankStatement,
 * scope accounting.reports.read), keeps the UNRECONCILED Faire ones, and
 * classifies each against what the-frame knows — payout invoices
 * (xero_payout_syncs), FAIRE-IC clawback bills (xero_journal_log issue_credit
 * rows), and the legacy clearing model — into a concrete instruction:
 *
 *   deposit == invoice   → "Find & Match FAIRE-<order>"
 *   deposit >  invoice   → "Match + Receive Money Δ to 5900 (reverse delta plug)"
 *   deposit <  invoice   → split-payment: pair with sibling lines summing to the
 *                          invoice, else "part-pay; expect another $Δ deposit"
 *   debit  w/ IC bill    → "Match to bill FAIRE-IC-<order>"
 *   debit  legacy order  → "Transfer → 1020 Faire Payments Clearing"
 *   debit  otherwise     → "Spend Money → 5900" (detector missed it — flag)
 *
 * The confirm-click in Xero bank rec cannot be automated (no API for statement
 * line acceptance) — this automates the diagnosis so the human just executes.
 * Slack topic: finance.faire_rec_digest. Silent when there's nothing to do.
 */

import { sqlite } from "@/lib/db";
import { xeroAdminFetch } from "@/modules/finance/lib/xero-client";

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface RecLine {
  date: string;
  description: string;
  amount: number; // positive = deposit (received), negative = debit (spent)
  orderCode: string | null;
  instruction: string;
}

export interface FaireRecDigestResult {
  ok: boolean;
  bankAccount?: string;
  scanned: number;
  unreconciledFaire: number;
  lines: RecLine[];
  error?: string;
}

/** Extract the Faire order code from a bank description ("Faire #U9WU93QFV5; …"). */
export function extractOrderCode(description: string): string | null {
  const m = description.match(/#([A-Z0-9]{8,12})\b/i);
  return m ? m[1].toUpperCase() : null;
}

type SyncRow = { amount: number; xero_object_type: string } | undefined;

/** Classify one unreconciled Faire bank line into a bookkeeper instruction. */
export function classifyLine(opts: {
  amount: number;
  orderCode: string | null;
  syncRow: SyncRow;
  hasIcBill: boolean;
  siblingAmounts: number[]; // other unreconciled Faire deposits (for split detection)
}): string {
  const { amount, orderCode, syncRow, hasIcBill, siblingAmounts } = opts;
  const code = orderCode ?? "?";

  if (amount < 0) {
    // Money out — a clawback or legacy adjustment
    if (hasIcBill) return `Match to bill FAIRE-IC-${code} (issue-credit clawback)`;
    if (syncRow?.xero_object_type === "manual_journal")
      return `Legacy order — Transfer → 1020 Faire Payments Clearing (delta already in 5900; do NOT expense again)`;
    return `No FAIRE-IC bill found — Spend Money → 5900 (contact Faire, "issue credit — order ${code}") and flag: detector missed this one`;
  }

  // Money in
  if (!syncRow) return `No invoice on file for ${code} — payout not yet synced; check again after the 9:15am sync (or ping Daniel's assistant)`;
  if (syncRow.xero_object_type === "manual_journal")
    return `Legacy (pre-cutover) payout — Transfer → 1020 Faire Payments Clearing`;

  const inv = round2(syncRow.amount);
  const dep = round2(amount);
  if (Math.abs(dep - inv) <= 0.01) return `Find & Match → invoice FAIRE-${code} ($${inv.toFixed(2)}) — exact match`;
  if (dep > inv) {
    const delta = round2(dep - inv);
    return `Match invoice FAIRE-${code} ($${inv.toFixed(2)}) + add Receive Money $${delta.toFixed(2)} → 5900 (reverses the invoice's payout-delta plug; wire exceeded Faire's reported payout)`;
  }
  const remainder = round2(inv - dep);
  const sibling = siblingAmounts.find((s) => Math.abs(round2(s) - remainder) <= 0.01);
  if (sibling !== undefined)
    return `Split payment: part-pay invoice FAIRE-${code} with this $${dep.toFixed(2)} AND the $${remainder.toFixed(2)} line (they sum to the $${inv.toFixed(2)} invoice)`;
  return `Part-payment: match to invoice FAIRE-${code} as partial ($${dep.toFixed(2)} of $${inv.toFixed(2)}); expect a further $${remainder.toFixed(2)} deposit (Faire hold/issue release)`;
}

/**
 * Pull unreconciled Mercury statement lines from Xero and classify Faire ones.
 * Read-only against Xero; DB reads only.
 */
export async function runFaireRecDigest(opts: { days?: number } = {}): Promise<FaireRecDigestResult> {
  const days = opts.days ?? 21;
  const res: FaireRecDigestResult = { ok: false, scanned: 0, unreconciledFaire: 0, lines: [] };

  // 1. Find the Mercury bank account
  const acctRes = await xeroAdminFetch("/api.xro/2.0/Accounts?where=" + encodeURIComponent('Type=="BANK"'));
  if (!acctRes.success) { res.error = `accounts: ${acctRes.error}`; return res; }
  type XA = { AccountID: string; Name: string; Type: string };
  const banks = ((acctRes.data as { Accounts?: XA[] }).Accounts || []);
  const mercury = banks.find((a) => /mercury/i.test(a.Name) && /checking/i.test(a.Name)) || banks.find((a) => /mercury/i.test(a.Name));
  if (!mercury) { res.error = `Mercury bank account not found in Xero (banks: ${banks.map((b) => b.Name).join(", ")})`; return res; }
  res.bankAccount = mercury.Name;

  // 2. Bank statement report for the window
  const to = new Date();
  const from = new Date(to.getTime() - days * 86400000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const repRes = await xeroAdminFetch(
    `/api.xro/2.0/Reports/BankStatement?bankAccountID=${mercury.AccountID}&fromDate=${fmt(from)}&toDate=${fmt(to)}`,
  );
  if (!repRes.success) { res.error = `bank statement report: ${repRes.error}`; return res; }

  // 3. Tolerant parse: rows carry cells [Date, Description, Reference, Reconciled, Source, Amount, Balance]
  //    (column order verified against the report's header row at runtime).
  type Cell = { Value?: string };
  type Row = { RowType: string; Cells?: Cell[]; Rows?: Row[] };
  const report = ((repRes.data as { Reports?: Array<{ Rows?: Row[] }> }).Reports || [])[0];
  const flat: Cell[][] = [];
  const walk = (rows: Row[] | undefined) => {
    for (const r of rows || []) {
      if (r.RowType === "Row" && r.Cells) flat.push(r.Cells);
      if (r.Rows) walk(r.Rows);
    }
  };
  walk(report?.Rows);

  // Header detection: find column indexes from the header row
  let idx = { date: 0, desc: 2, reconciled: 3, amount: 5 };
  const header = (report?.Rows || []).find((r) => r.RowType === "Header");
  if (header?.Cells) {
    const names = header.Cells.map((c) => (c.Value || "").toLowerCase());
    const find = (label: string, fallback: number) => {
      const i = names.findIndex((n) => n.includes(label));
      return i >= 0 ? i : fallback;
    };
    idx = { date: find("date", 0), desc: find("description", 2), reconciled: find("reconciled", 3), amount: find("amount", 5) };
  }

  const faireLines: Array<{ date: string; description: string; amount: number; orderCode: string | null }> = [];
  for (const cells of flat) {
    res.scanned++;
    const desc = cells[idx.desc]?.Value || "";
    const reconciled = (cells[idx.reconciled]?.Value || "").toLowerCase();
    if (!/faire/i.test(desc)) continue;
    if (reconciled === "yes" || reconciled === "true") continue;
    const amount = parseFloat((cells[idx.amount]?.Value || "0").replace(/[^0-9.-]/g, ""));
    if (!Number.isFinite(amount) || amount === 0) continue;
    faireLines.push({ date: cells[idx.date]?.Value || "", description: desc, amount, orderCode: extractOrderCode(desc) });
  }
  res.unreconciledFaire = faireLines.length;

  // 4. Classify each against the DB
  const depositAmounts = faireLines.filter((l) => l.amount > 0).map((l) => l.amount);
  for (const l of faireLines) {
    const syncRow = (l.orderCode
      ? sqlite.prepare("SELECT amount, xero_object_type FROM xero_payout_syncs WHERE source_payout_id = ? AND source_platform='faire'").get("bo_" + l.orderCode.toLowerCase())
      : undefined) as SyncRow;
    const hasIcBill = l.orderCode
      ? !!sqlite.prepare("SELECT 1 FROM xero_journal_log WHERE xero_object_type='issue_credit' AND xero_object_id IS NOT NULL AND source_id = ? LIMIT 1").get("bo_" + l.orderCode.toLowerCase())
      : false;
    const siblings = depositAmounts.filter((a) => a !== l.amount);
    res.lines.push({
      date: l.date,
      description: l.description.slice(0, 80),
      amount: l.amount,
      orderCode: l.orderCode,
      instruction: classifyLine({ amount: l.amount, orderCode: l.orderCode, syncRow, hasIcBill, siblingAmounts: siblings }),
    });
  }

  res.ok = true;
  return res;
}
