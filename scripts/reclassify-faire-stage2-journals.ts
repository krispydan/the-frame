/**
 * One-shot fix-up for the Faire-as-Shopify-Wholesale Stage 2 misclassification
 * (commit 6a4b769).
 *
 * For every row in `order_revenue_recognitions` where the payout actually
 * came from Faire but the Stage 2 journal got tagged with Shopify Wholesale's
 * Sales account (4030) + tracking ("Shopify - Wholesale"), this script:
 *
 *   1. Fetches the existing posted Manual Journal from Xero
 *   2. Swaps the Sales account 4030 → 4040 on the revenue line
 *   3. Swaps the Sales Channel tracking on all four lines
 *      (Deferred Revenue, Sales, COGS, Inventory) from
 *      "Shopify - Wholesale" → "Faire"
 *   4. Updates the Narration text "Shopify Wholesale order #X" → "Faire order #X"
 *   5. POSTs the corrected journal back to Xero — same ManualJournalID,
 *      so Xero updates in-place rather than creating a new entry
 *   6. Updates the local `order_revenue_recognitions.channel` to 'faire' so
 *      future audits show the correct attribution
 *
 * Idempotent: only touches rows whose recognized_as != real_platform.
 * Re-running is safe (no-op once everything's reclassified).
 *
 * Usage:
 *   npx tsx scripts/reclassify-faire-stage2-journals.ts            # dry-run
 *   npx tsx scripts/reclassify-faire-stage2-journals.ts --apply    # do it
 *   npx tsx scripts/reclassify-faire-stage2-journals.ts --apply --only "#2DJPVRJBUX"
 */
import { sqlite, db } from "@/lib/db";
import { xeroAdminFetch, xeroAdminPost } from "@/modules/finance/lib/xero-client";
import { xeroAccountMappings, xeroTrackingMappings, SHARED_PLATFORM_KEY } from "@/modules/integrations/schema/xero";
import { orderRevenueRecognitions } from "@/modules/finance/schema";
import { eq, inArray } from "drizzle-orm";

interface MisclassifiedRow {
  order_id: string;
  order_number: string;
  recognized_as: string;
  real_platform: string;
  revenue: number;
  cogs: number;
  xero_manual_journal_id: string;
  shipped_at: string;
}

interface FaireConfig {
  salesAccountCode: string;       // 4040
  deferredRevenueAccountCode: string;  // 2050
  cogsAccountCode: string;        // 5000
  inventoryAccountCode: string;   // 1400
  trackingCategoryId: string;
  trackingCategoryName: string;
  trackingOptionName: string;     // "Faire"
}

interface XeroJournalLine {
  LineAmount: number;
  AccountCode: string;
  Description: string;
  Tracking?: Array<{ TrackingCategoryID: string; Name?: string; Option: string }>;
}
interface XeroManualJournal {
  ManualJournalID: string;
  Narration: string;
  Date: string;
  Status: string;
  JournalLines: XeroJournalLine[];
}

async function loadFaireConfig(): Promise<FaireConfig> {
  const rows = await db
    .select()
    .from(xeroAccountMappings)
    .where(inArray(xeroAccountMappings.sourcePlatform, ["faire", SHARED_PLATFORM_KEY]));
  const byCategory = new Map<string, string>();
  for (const r of rows) {
    if (!r.xeroAccountCode) continue;
    if (r.sourcePlatform === "faire" || !byCategory.has(r.category)) {
      byCategory.set(r.category, r.xeroAccountCode);
    }
  }
  const need = ["sales", "deferred_revenue", "cogs", "inventory"];
  const missing = need.filter((k) => !byCategory.get(k));
  if (missing.length) throw new Error(`Faire mappings missing: ${missing.join(", ")}`);

  const [tk] = await db.select().from(xeroTrackingMappings).where(eq(xeroTrackingMappings.sourcePlatform, "faire"));
  if (!tk) throw new Error("Faire tracking mapping missing — add Sales Channel → Faire under Xero settings");

  return {
    salesAccountCode: byCategory.get("sales")!,
    deferredRevenueAccountCode: byCategory.get("deferred_revenue")!,
    cogsAccountCode: byCategory.get("cogs")!,
    inventoryAccountCode: byCategory.get("inventory")!,
    trackingCategoryId: tk.trackingCategoryId,
    trackingCategoryName: tk.trackingCategoryName ?? "Sales Channel",
    trackingOptionName: tk.trackingOptionName ?? "Faire",
  };
}

/**
 * Build a corrected journal payload using the Faire config. Includes the
 * existing ManualJournalID so Xero treats this as an update, not a new
 * journal. Reuses revenue + COGS amounts from order_revenue_recognitions
 * (frozen at original recognition time — safer than re-querying current
 * cost_price).
 */
function buildCorrectedJournal(row: MisclassifiedRow, cfg: FaireConfig): XeroManualJournal {
  const tracking = [{
    TrackingCategoryID: cfg.trackingCategoryId,
    Name: cfg.trackingCategoryName,
    Option: cfg.trackingOptionName,
  }];

  const orderRef = row.order_number;
  const shipDate = row.shipped_at.slice(0, 10);

  const lines: XeroJournalLine[] = [
    {
      LineAmount: row.revenue,                                  // DR Deferred Revenue
      AccountCode: cfg.deferredRevenueAccountCode,
      Description: `Recognize revenue at shipment — Faire order ${orderRef}`,
      Tracking: tracking,
    },
    {
      LineAmount: -row.revenue,                                 // CR Sales (Faire)
      AccountCode: cfg.salesAccountCode,
      Description: `Sales — Faire order ${orderRef} (shipped ${shipDate})`,
      Tracking: tracking,
    },
  ];
  if (row.cogs > 0) {
    lines.push(
      {
        LineAmount: row.cogs,                                   // DR COGS
        AccountCode: cfg.cogsAccountCode,
        Description: `COGS — Faire order ${orderRef}`,
        Tracking: tracking,
      },
      {
        LineAmount: -row.cogs,                                  // CR Inventory
        AccountCode: cfg.inventoryAccountCode,
        Description: `Inventory release — Faire order ${orderRef}`,
        Tracking: tracking,
      },
    );
  }

  const narration = row.cogs > 0
    ? `Shipment recognition — Faire order ${orderRef} | revenue ${row.revenue.toFixed(2)} | COGS ${row.cogs.toFixed(2)} | ${shipDate}`
    : `Shipment recognition — Faire order ${orderRef} | revenue ${row.revenue.toFixed(2)} | no COGS (missing cost_price) | ${shipDate}`;

  return {
    ManualJournalID: row.xero_manual_journal_id,
    Narration: narration,
    Date: shipDate,
    Status: "POSTED",
    JournalLines: lines,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const onlyIdx = args.indexOf("--only");
  const onlyOrder = onlyIdx !== -1 ? args[onlyIdx + 1] : null;

  console.log(`Mode: ${apply ? "LIVE (will POST updates to Xero)" : "DRY RUN"}`);
  if (onlyOrder) console.log(`Limited to order: ${onlyOrder}`);
  console.log("");

  const cfg = await loadFaireConfig();
  console.log("Faire config loaded:");
  console.log(`  Sales account:    ${cfg.salesAccountCode}`);
  console.log(`  Tracking option:  ${cfg.trackingCategoryName} = ${cfg.trackingOptionName}`);
  console.log("");

  // Pull misclassified rows joined to real_platform
  const rows = sqlite.prepare(`
    SELECT
      orr.order_id                 AS order_id,
      o.order_number               AS order_number,
      orr.channel                  AS recognized_as,
      xps.source_platform          AS real_platform,
      orr.revenue_amount           AS revenue,
      orr.cogs_amount              AS cogs,
      orr.xero_manual_journal_id   AS xero_manual_journal_id,
      o.shipped_at                 AS shipped_at
    FROM order_revenue_recognitions orr
    INNER JOIN orders o ON o.id = orr.order_id
    INNER JOIN settlement_line_items sli ON sli.order_id = o.id
    INNER JOIN settlements s ON s.id = sli.settlement_id
    INNER JOIN xero_payout_syncs xps ON xps.source_payout_id IN (
      REPLACE(s.external_id, 'shopify_payout_', ''),
      REPLACE(s.external_id, 'faire_payout_', '')
    )
    WHERE orr.channel != xps.source_platform
      AND xps.source_platform = 'faire'
      AND orr.xero_manual_journal_id IS NOT NULL
    GROUP BY orr.order_id
    ORDER BY orr.recognized_at ASC
  `).all() as MisclassifiedRow[];

  const filtered = onlyOrder ? rows.filter((r) => r.order_number === onlyOrder) : rows;
  console.log(`Found ${filtered.length} misclassified journals to fix.\n`);

  let ok = 0, failed = 0;

  for (const row of filtered) {
    const corrected = buildCorrectedJournal(row, cfg);
    process.stdout.write(`▶ ${row.order_number}  rev=$${row.revenue.toFixed(2)}  mj=${row.xero_manual_journal_id.slice(0, 8)}... `);

    if (!apply) {
      console.log("(dry run) would update");
      continue;
    }

    const post = await xeroAdminPost("/api.xro/2.0/ManualJournals", { ManualJournals: [corrected] });
    if (!post.success) {
      console.log(`✗ ${post.error.slice(0, 150)}`);
      failed++;
      continue;
    }

    // Verify Xero kept the same ManualJournalID (it should — we sent it)
    const data = post.data as { ManualJournals?: Array<{ ManualJournalID?: string }> };
    const newId = data.ManualJournals?.[0]?.ManualJournalID;
    if (newId && newId !== row.xero_manual_journal_id) {
      console.log(`⚠ Xero returned a NEW journal ID (${newId.slice(0, 8)}) — original ${row.xero_manual_journal_id.slice(0, 8)} may now be orphaned. Investigate.`);
    }

    // Update local row to reflect correct channel attribution
    await db.update(orderRevenueRecognitions)
      .set({ channel: "faire", xeroManualJournalId: newId ?? row.xero_manual_journal_id })
      .where(eq(orderRevenueRecognitions.orderId, row.order_id));

    console.log(`✓ updated`);
    ok++;

    // Throttle to stay under Xero's 60 req/min rate cap
    await new Promise((r) => setTimeout(r, 1100));
  }

  console.log(`\nDone. ok=${ok}  failed=${failed}`);
  process.exit(failed > 0 ? 2 : 0);
}

main().catch((e) => {
  console.error("Reclassify threw:", e);
  process.exit(1);
});
