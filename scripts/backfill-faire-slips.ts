/**
 * Backfill the Faire packing-slip attachment + packer note for existing
 * ShipHero orders. Idempotent — re-running is safe; previously-attached
 * orders short-circuit on the unique index in shiphero_attachment_logs.
 *
 * Usage:
 *   # Default: last 90 days, all fulfillment statuses
 *   SHIPHERO_ACCESS_TOKEN=... FAIRE_API_TOKEN=... \
 *   SHOPIFY_APP_URL=https://theframe.getjaxy.com \
 *     npx tsx scripts/backfill-faire-slips.ts
 *
 *   # Wider date range
 *   npx tsx scripts/backfill-faire-slips.ts --since 2025-01-01
 *
 *   # Only unfulfilled orders (skip already-shipped)
 *   npx tsx scripts/backfill-faire-slips.ts --unfulfilled-only
 *
 *   # Dry run — list which orders WOULD be processed without calling APIs
 *   npx tsx scripts/backfill-faire-slips.ts --dry-run
 *
 * Behavior:
 *   - Pulls every ShipHero order in the date window via getOrders().
 *   - For each, calls attachFairePackingSlipToOrder() — the same function
 *     the webhook handler uses. Non-Faire orders short-circuit on the
 *     display_id regex without burning Faire API calls.
 *   - Sleeps 400ms between orders to be polite to ShipHero's credit budget.
 *   - Prints a per-order line + a final summary by status.
 */
import { getOrders } from "@/modules/operations/lib/shiphero/api-client";
import { attachFairePackingSlipToOrder, type AttachStatus } from "@/modules/operations/lib/shiphero/attach-faire-slip";

interface Args {
  since: string;
  until: string | null;
  unfulfilledOnly: boolean;
  dryRun: boolean;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] ?? null : null;
  };
  const has = (flag: string) => args.includes(flag);

  const sinceRaw = get("--since");
  const since = sinceRaw
    ? new Date(sinceRaw).toISOString()
    : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const untilRaw = get("--until");
  const until = untilRaw ? new Date(untilRaw).toISOString() : null;

  return {
    since,
    until,
    unfulfilledOnly: has("--unfulfilled-only"),
    dryRun: has("--dry-run"),
  };
}

const TERMINAL_STATUSES = new Set([
  "fulfilled",
  "shipped",
  "delivered",
  "canceled",
  "cancelled",
]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  if (!process.env.SHIPHERO_ACCESS_TOKEN) {
    console.error("SHIPHERO_ACCESS_TOKEN is required.");
    process.exit(1);
  }
  if (!process.env.FAIRE_API_TOKEN) {
    console.error("FAIRE_API_TOKEN is required.");
    process.exit(1);
  }
  if (
    !process.env.SHOPIFY_APP_URL &&
    !process.env.APP_BASE_URL &&
    !process.env.NEXT_PUBLIC_APP_URL
  ) {
    console.error(
      "App base URL is required — set SHOPIFY_APP_URL (or APP_BASE_URL) so the signed slip URL is reachable by ShipHero.",
    );
    process.exit(1);
  }

  const args = parseArgs();
  console.log(`Backfilling Faire packing slips for ShipHero orders.`);
  console.log(`  Window:           ${args.since}${args.until ? ` → ${args.until}` : " → now"}`);
  console.log(`  Unfulfilled only: ${args.unfulfilledOnly}`);
  console.log(`  Dry run:          ${args.dryRun}`);
  console.log();

  console.log("Fetching ShipHero orders...");
  const allOrders = await getOrders({
    updatedFrom: args.since,
    updatedTo: args.until ?? undefined,
  });
  console.log(`  ${allOrders.length} orders in window.`);

  const filtered = args.unfulfilledOnly
    ? allOrders.filter((o) => !TERMINAL_STATUSES.has(o.fulfillment_status?.toLowerCase() ?? ""))
    : allOrders;
  console.log(`  ${filtered.length} after status filter.`);
  console.log();

  const counts: Record<AttachStatus, number> = {
    success: 0,
    error: 0,
    skipped_not_faire: 0,
    skipped_no_slip: 0,
    skipped_no_order_id: 0,
  };

  for (let i = 0; i < filtered.length; i++) {
    const o = filtered[i];
    const label = `[${i + 1}/${filtered.length}] ${o.order_number || "(no order#)"}  ${o.fulfillment_status}`;

    if (args.dryRun) {
      console.log(`${label}  (dry-run)`);
      continue;
    }

    try {
      const result = await attachFairePackingSlipToOrder({
        shipheroOrderId: o.id,
        orderNumber: o.order_number || null,
      });
      counts[result.status]++;
      const icon =
        result.status === "success"
          ? "✓"
          : result.status === "error"
          ? "✗"
          : "○";
      console.log(`${label}  ${icon} ${result.status} — ${result.message}`);
    } catch (e) {
      counts.error++;
      console.error(`${label}  ✗ uncaught: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Be kind to ShipHero's credit budget + Faire's rate limits.
    await sleep(400);
  }

  console.log();
  console.log("Summary:");
  console.log(`  ✓ success            : ${counts.success}`);
  console.log(`  ○ skipped_not_faire  : ${counts.skipped_not_faire}`);
  console.log(`  ○ skipped_no_slip    : ${counts.skipped_no_slip}`);
  console.log(`  ○ skipped_no_order_id: ${counts.skipped_no_order_id}`);
  console.log(`  ✗ error              : ${counts.error}`);
  process.exit(counts.error > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
