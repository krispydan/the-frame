/**
 * Revenue-model switch for payout sync.
 *
 *   "deferred" — legacy: payout posts a manual journal that defers gross sales
 *                to 2050 and sweeps net to 1100/clearing; revenue is recognized
 *                later by the shipment-recognition cron. (Stranded all Shopify
 *                Wholesale revenue in Deferred Revenue — see the redesign.)
 *
 *   "invoice"  — settlement-date: payout posts ONE ACCREC invoice (gross sales
 *                +, fees −, total = net deposit) per the channel mapping guide;
 *                revenue recognized at settlement; bank reconciles 1:1; no
 *                deferred revenue. Stage-2 recognition is disabled.
 *
 * Stored in `settings` under key `payout_revenue_model`. DEFAULTS TO "deferred"
 * so deploying the new code changes nothing until this is flipped to "invoice".
 */

import { sqlite } from "@/lib/db";

export type PayoutRevenueModel = "deferred" | "invoice";

export const PAYOUT_REVENUE_MODEL_KEY = "payout_revenue_model";

export function getPayoutRevenueModel(): PayoutRevenueModel {
  try {
    const row = sqlite
      .prepare("SELECT value FROM settings WHERE key = ? LIMIT 1")
      .get(PAYOUT_REVENUE_MODEL_KEY) as { value: string | null } | undefined;
    return row?.value === "invoice" ? "invoice" : "deferred";
  } catch {
    return "deferred";
  }
}

export function setPayoutRevenueModel(model: PayoutRevenueModel): void {
  sqlite
    .prepare(
      `INSERT INTO settings (key, value, type, module, updated_at)
       VALUES (?, ?, 'string', 'finance', datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    )
    .run(PAYOUT_REVENUE_MODEL_KEY, model);
}
