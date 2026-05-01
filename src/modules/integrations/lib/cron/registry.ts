/**
 * Centralized cron job registry.
 *
 * Each entry is a static job definition: stable id, cron expression
 * (UTC), description, and a handler function. The scheduler at
 * /api/v1/cron/tick reads this registry and runs eligible jobs.
 *
 * To add a new cron:
 *   1. Add an entry below
 *   2. Define the handler — async function returning anything JSON-able
 *   3. Done. No Railway dashboard work, no new service.
 *
 * Disable a job at runtime via the cron settings UI (writes to
 * cron_job_state.enabled). Job's identity is the `id` field — keep it
 * stable across renames.
 *
 * Cron times are UTC. PT comments are approximate (DST drift acceptable
 * for these jobs).
 */

import { probeAllShops } from "@/modules/integrations/lib/shopify/health";
import { syncShopifyPayouts } from "@/modules/integrations/lib/xero/payout-sync";
import { postDailyDigest, postWeeklyDigest } from "@/modules/integrations/lib/slack/digests";
import { syncShipHeroOrders } from "@/modules/operations/lib/shiphero/sync-orders";
import { syncShipHeroInventory, isDuringBusinessHours } from "@/modules/operations/lib/shiphero/sync-inventory";

export type CronJob = {
  id: string;                         // stable, kebab-case
  schedule: string;                   // cron expression (UTC)
  description: string;
  handler: () => Promise<unknown>;
  /**
   * Optional gate — if returns false, the job is "skipped" (logged but
   * not executed). Used for things like "only during PT business hours".
   */
  guard?: () => boolean | Promise<boolean>;
  /**
   * Default state if no row exists in cron_job_state. Defaults to true
   * (enabled). Set to false for jobs that should opt-in.
   */
  defaultEnabled?: boolean;
};

export const CRON_JOBS: CronJob[] = [
  // ── Health probes ──
  {
    id: "shopify-health-probe",
    schedule: "*/15 * * * *",  // every 15 min
    description: "Validate Shopify access tokens for all connected shops; alerts Slack on flip",
    handler: probeAllShops,
  },

  // ── Shopify orders sync ──
  // Pulls orders from each connected Shopify shop into the local orders
  // table. Runs daily but the function itself is idempotent (skips orders
  // already in DB) so multiple runs in a row are harmless.
  {
    id: "shopify-orders-sync",
    schedule: "0 14 * * *",  // 14:00 UTC ≈ 7am PT
    description: "Pull recent orders from each connected Shopify shop into the-frame DB",
    handler: async () => {
      // Use the existing sync route's logic via fetch. Lightweight wrapper
      // because shopify-sync logic lives behind a Next.js route handler;
      // calling it directly avoids re-implementing the query logic here.
      const res = await fetch(`${baseUrl()}/api/v1/orders/shopify-sync`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    },
  },

  // ── Xero payout sync ──
  {
    id: "xero-payout-sync",
    schedule: "0 15 * * *",  // 15:00 UTC ≈ 8am PT (after Shopify settles overnight)
    description: "Pull recent Shopify payouts and post paired revenue + COGS journals to Xero",
    handler: () => syncShopifyPayouts({}),
  },

  // ── ShipHero ──
  {
    id: "shiphero-orders-sync",
    schedule: "*/15 * * * *",  // every 15 min during business hours
    description: "Sync ShipHero shipment + tracking updates back to local orders",
    handler: syncShipHeroOrders,
    guard: () => isDuringBusinessHours(),
  },
  {
    id: "shiphero-inventory-sync",
    schedule: "0 * * * *",  // hourly
    description: "Pull current inventory levels from ShipHero into local inventory table",
    handler: syncShipHeroInventory,
    guard: () => isDuringBusinessHours(),
  },

  // ── Slack ──
  {
    id: "slack-digest-daily",
    schedule: "0 14 * * *",  // 14:00 UTC ≈ 7am PT
    description: "Post yesterday's revenue / fulfillment / inventory digest to #jaxy-daily-digest",
    handler: postDailyDigest,
  },
  {
    id: "slack-digest-weekly",
    schedule: "0 15 * * 1",  // 15:00 UTC Monday ≈ 8am PT Monday
    description: "Post last week's revenue / top sellers / slow movers digest to #jaxy-weekly-review",
    handler: postWeeklyDigest,
  },
  {
    id: "slack-stuck-orders",
    schedule: "0 16 * * *",  // 16:00 UTC ≈ 9am PT
    description: "Scan for orders stuck >48h in 'confirmed' and Slack alert (deduped)",
    handler: async () => {
      const res = await fetch(`${baseUrl()}/api/v1/integrations/slack/scan-stuck-orders`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    },
  },
];

function baseUrl(): string {
  return (process.env.SHOPIFY_APP_URL || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000")
    .replace(/\/$/, "");
}

export function findJob(id: string): CronJob | undefined {
  return CRON_JOBS.find((j) => j.id === id);
}
