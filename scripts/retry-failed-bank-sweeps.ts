/**
 * Retry the BankTransaction sweep step for payouts whose Manual Journal
 * posted successfully but whose bank-receive leg failed (commonly because
 * the OAuth token was missing the accounting.banktransactions scope at
 * the time).
 *
 * Reuses the saved payload + sibling manual journal in xero_journal_log to
 * reconstruct each request, posts via the same xero-client helper the cron
 * uses, and updates the log row to 'success' on win.
 *
 * Run after re-authorizing Xero with the new scopes:
 *   railway ssh "cd /app && npx tsx scripts/retry-failed-bank-sweeps.ts"
 */
import { sqlite } from "@/lib/db";
import { postBankTransactionReceive } from "@/modules/finance/lib/xero-client";

const HUMAN_PLATFORM: Record<string, string> = {
  shopify_dtc: "Shopify Retail",
  shopify_wholesale: "Shopify Wholesale",
  shopify_afterpay: "Shopify Afterpay",
  faire: "Faire",
  amazon: "Amazon",
  tiktok_shop: "TikTok Shop",
};

interface FailedRow {
  id: string;
  source_platform: string;
  source_id: string;
  amount: number;
  payload: string;
}

interface BankReceivePayload {
  kind: string;
  payoutId: number | string;
  bankAccountCode: string;
  contraAccountCode: string;
  amount: number;
}

interface MjPayload {
  journal?: { Date?: string };
}

interface TrackingRow {
  tracking_category_id: string;
  tracking_category_name: string | null;
  tracking_option_name: string | null;
}

async function main() {
  const failed = sqlite.prepare(`
    SELECT id, source_platform, source_id, amount, payload
    FROM xero_journal_log
    WHERE xero_object_type = 'bank_transaction' AND status = 'failed'
    ORDER BY created_at ASC
  `).all() as FailedRow[];

  console.log(`Found ${failed.length} failed bank-sweep entries.\n`);
  let posted = 0;
  let stillFailing = 0;

  for (const row of failed) {
    const payload = JSON.parse(row.payload) as BankReceivePayload;
    const platform = HUMAN_PLATFORM[row.source_platform] ?? row.source_platform;

    // Date — pull from the sibling Manual Journal that DID succeed
    const mjRow = sqlite.prepare(`
      SELECT payload FROM xero_journal_log
      WHERE source_id = ?
        AND xero_object_type = 'manual_journal'
        AND status = 'success'
      ORDER BY created_at DESC LIMIT 1
    `).get(row.source_id) as { payload: string } | undefined;
    if (!mjRow) {
      console.log(`✗ payout ${row.source_id}: no successful sibling MJ — skip`);
      continue;
    }
    const mj = JSON.parse(mjRow.payload) as MjPayload;
    const date = mj.journal?.Date;
    if (!date) {
      console.log(`✗ payout ${row.source_id}: sibling MJ has no Date — skip`);
      continue;
    }

    // Tracking
    const trackingRow = sqlite.prepare(`
      SELECT tracking_category_id, tracking_category_name, tracking_option_name
      FROM xero_tracking_mappings WHERE source_platform = ?
    `).get(row.source_platform) as TrackingRow | undefined;
    const tracking = trackingRow ? [{
      TrackingCategoryID: trackingRow.tracking_category_id,
      Name: trackingRow.tracking_category_name ?? undefined,
      Option: trackingRow.tracking_option_name ?? "",
    }] : undefined;

    process.stdout.write(`▶ payout ${row.source_id} ($${row.amount} on ${date})... `);
    const res = await postBankTransactionReceive({
      bankAccountCode: payload.bankAccountCode,
      contraAccountCode: payload.contraAccountCode,
      amount: payload.amount,
      date,
      reference: `payout_${payload.payoutId}`,
      description: `${platform} payout #${payload.payoutId} — net deposit (sweep from Receivables Holding) [retry]`,
      contactName: `${platform} Payouts`,
      tracking,
    });

    if (res.success) {
      sqlite.prepare(`
        UPDATE xero_journal_log
           SET status = 'success',
               xero_object_id = ?,
               error_message = NULL,
               response = ?
         WHERE id = ?
      `).run(
        res.bankTransactionId,
        JSON.stringify({ bankTransactionId: res.bankTransactionId, retried: true }),
        row.id,
      );
      console.log(`✓ posted ${res.bankTransactionId}`);
      posted++;
    } else {
      console.log(`✗ ${res.error}`);
      stillFailing++;
    }
  }

  console.log(`\nSummary: posted=${posted}  still_failing=${stillFailing}`);
  process.exit(stillFailing > 0 ? 2 : 0);
}

main().catch((e) => {
  console.error("retry threw:", e);
  process.exit(1);
});
