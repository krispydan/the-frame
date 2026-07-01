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
import { refreshIfExpiringSoon as refreshShipHeroToken } from "@/modules/operations/lib/shiphero/auth";
import { pullPhoneBurnerCallResults } from "@/modules/sales/lib/phoneburner-sync";
import { postPhoneBurnerCallDigest } from "@/modules/integrations/lib/slack/phoneburner-digest";
import { runShopifyMetafieldSync } from "@/modules/catalog/lib/shopify-metafields/bulk-sync-job";
import { syncSettlementsAllShops } from "@/modules/finance/lib/shopify-settlements";
import { runShipmentRevenueRecognition } from "@/modules/finance/lib/shipment-revenue-recognition";
import { runDailyCogsPosting } from "@/modules/finance/lib/daily-cogs";
import { syncFairePayouts } from "@/modules/integrations/lib/faire/payout-sync";
import { runOrderDealSweep, runActivitySweep } from "@/modules/sales/lib/pipedrive-sync";
import { enrichViaGoogleMaps } from "@/modules/sales/lib/google-maps-enrichment";
import { recalculateAllHealthScores } from "@/modules/customers/lib/health-scoring";
import { refreshReorderEstimates } from "@/modules/customers/lib/reorder-engine";

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
  /**
   * If true, the tick endpoint dispatches this job without awaiting
   * its promise — useful for handlers that routinely exceed
   * Cloudflare's 100-second edge timeout (which 524s the HTTP
   * response but doesn't actually stop the Node process). The
   * in_progress lock inside runJob() prevents the next tick from
   * re-running an unfinished detached job, so this is safe.
   *
   * Detached jobs show up in the tick response as
   *   { status: "detached", result: { dispatched: true } }
   * with durationMs=0. The actual completion is recorded in
   * cron_job_state.last_run_at when the job finishes.
   */
  fireAndForget?: boolean;
};

export const CRON_JOBS: CronJob[] = [
  // ── Customer lifecycle refresh ──
  // Keep customer health scores and reorder estimates current. Both are quick
  // whole-table passes over customer_accounts; account stats update on each
  // order, but health (RFM/recency) and reorder timing drift with the calendar,
  // so a nightly recompute keeps the customer pages + retention signals honest.
  {
    id: "recalculate-health-scores",
    schedule: "0 11 * * *",  // 11:00 UTC ≈ 4am PT
    description: "Recompute RFM health scores + statuses for all customer accounts",
    handler: async () => recalculateAllHealthScores(),
  },
  {
    id: "refresh-reorder-estimates",
    schedule: "20 11 * * *",  // 11:20 UTC ≈ 4:20am PT (after health scores)
    description: "Refresh next-reorder-date estimates for all customer accounts",
    handler: async () => ({ updated: refreshReorderEstimates() }),
  },

  // ── Catalog metafield sync ──
  // Catch-all nightly sweep to keep Shopify metafields in sync with
  // the-frame's tag data. Immediate syncs happen on tag mutations
  // (auto-sync.ts debounced per-product). This handles any drift.
  {
    id: "shopify-metafield-sync",
    schedule: "0 3 * * *",  // 03:00 UTC ≈ 8pm PT (low-traffic window)
    description: "Sync tag-curated metafields (lens, frame shape, gender, color) to retail + wholesale Shopify for all products",
    handler: runShopifyMetafieldSync,
  },

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

  // ── Faire payout sync (accrual / ASC 606) ──
  // Faire doesn't expose a /payouts endpoint — payout data is on each order
  // under `payout_costs`. Walks recent Faire orders, finds the ones Faire
  // has paid out (`payment_initiated_at` set), and posts per-order journals
  // following the same defer-at-payout model used for Shopify. Runs after
  // Shopify payout sync so all the day's accrual journals land together.
  {
    id: "faire-payout-sync",
    schedule: "15 16 * * *",  // 16:15 UTC ≈ 9:15am PT
    description: "Pull Faire orders, post per-order deferred-revenue journals + bank sweep for paid orders",
    handler: () => syncFairePayouts({}),
  },

  // ── Shipment-driven revenue recognition (accrual / ASC 606) ──
  // Stage 2 of the accrual flow. Finds orders that shipped (control
  // transferred to customer) but whose revenue is still parked in
  // Deferred Revenue (2200), and posts a per-order Manual Journal that
  // moves it to Sales Revenue. (COGS is handled separately by the daily
  // FIFO COGS job below.) Runs after the daily Shopify orders sync +
  // payout sync so the data it walks is up to date.
  {
    id: "shopify-shipment-revenue-recognition",
    schedule: "30 16 * * *",  // 16:30 UTC ≈ 9:30am PT (after payout-sync at 15:00 and settlements-sync at 16:00)
    description: "Recognize Sales Revenue for shipped orders previously deferred (accrual / ASC 606)",
    handler: runShipmentRevenueRecognition,
  },

  // ── Daily FIFO COGS posting (capitalized landed cost) ──
  // Recognizes COGS at shipment using true FIFO landed cost, decoupled from
  // the revenue job above. Posts ONE consolidated channel-tracked Manual
  // Journal per day (DR 5000/5010/5020, CR 1400). Runs after revenue
  // recognition so both walk the same shipped set. Order lines that can't be
  // costed cleanly raise cogs_exceptions + Slack and are excluded until fixed.
  {
    id: "daily-cogs-posting",
    schedule: "45 16 * * *",  // 16:45 UTC ≈ 9:45am PT (after shipment-revenue-recognition at 16:30)
    description: "Post daily FIFO COGS for yesterday's shipped orders to Xero (one channel-tracked journal)",
    handler: () => runDailyCogsPosting(),
  },

  // ── Shopify Payments settlement sync ──
  // Pulls payouts via the Admin API and writes rows into the `settlements`
  // table so the Finance > Settlements UI auto-populates. Runs an hour
  // after xero-payout-sync so the two pipelines stay independent.
  {
    id: "shopify-settlements-sync",
    schedule: "0 16 * * *",  // 16:00 UTC ≈ 9am PT
    description: "Pull Shopify Payments payouts via Admin API into the local settlements table",
    handler: syncSettlementsAllShops,
  },

  // ── ShipHero ──
  // Access tokens have a ~28-day life. This job refreshes when expiry is
  // within 7 days; quiet on other days. Without it, the integration goes
  // silently dark every 28 days (see May 29 – Jun 15 2026 outage).
  {
    id: "shiphero-token-refresh",
    schedule: "0 6 * * *",  // 06:00 UTC daily ≈ 11pm PT
    description: "Refresh ShipHero access token when expiry is <7 days away",
    handler: () => refreshShipHeroToken(7),
  },
  {
    id: "shiphero-orders-sync",
    schedule: "*/15 * * * *",  // every 15 min during business hours
    description: "Sync ShipHero shipment + tracking updates back to local orders",
    handler: syncShipHeroOrders,
    guard: () => isDuringBusinessHours(),
    // Routinely runs ~2 min; CF 524s the tick HTTP response while the
    // Node process keeps going. Dispatch detached so the cron service
    // sees a clean 200 immediately.
    fireAndForget: true,
  },
  {
    id: "shiphero-inventory-sync",
    schedule: "0 * * * *",  // hourly
    description: "Pull current inventory levels from ShipHero into local inventory table",
    handler: syncShipHeroInventory,
    guard: () => isDuringBusinessHours(),
  },
  {
    // Drains the phone-less qualified-in-Instantly cohort overnight
    // (or whenever this runs). Each tick processes a small batch via
    // the Apify Google Maps actor — phones, hours, ratings, and
    // permanently-closed status. Cohort filter already excludes
    // dead-end statuses (not_interested / rejected / etc.) and any
    // company already enriched, so this stops being a no-op when the
    // cohort drains.
    //
    // Cost: ~$0.05-0.10 per tick. Bounded by total cohort size, not
    // by tick count.
    //
    // Disable by toggling `enabled` to false in cron_job_state once
    // we're satisfied with the cohort coverage:
    //   curl -X POST .../api/admin/cron/jobs/apify-gmaps-enrichment \
    //        -H "x-admin-key: jaxy2026" -d '{"enabled": false}'
    id: "apify-gmaps-enrichment",
    schedule: "*/10 * * * *",  // every 10 min
    description: "Enrich phone-less prospects via Apify Google Maps in chunks of 50",
    handler: () => enrichViaGoogleMaps({ limit: 50 }),
    // fire-and-forget — each batch takes ~30-90s × up to 2 batches = 1-3 min
    // server-side, well under cron-tick's CF timeout when async-dispatched.
    fireAndForget: true,
  },

  // ── PhoneBurner ──
  // We discovered PB DOES expose workspace-wide webhooks via the
  // Settings UI (webhooksSettings.pdf). The webhook receiver is the
  // primary delivery path; this polling cron stays as a safety net at
  // a slower cadence to catch any deliveries PB might have dropped.
  // After ~2 weeks of clean webhook deliveries, disable via the cron UI.
  {
    id: "phoneburner-call-poll",
    schedule: "*/30 * * * *",  // every 30 min — safety net only
    description: "Safety-net poll for PhoneBurner calls (webhooks are primary). Re-ingestion is idempotent on call_id PK.",
    handler: () => pullPhoneBurnerCallResults({ sinceMinutes: 60 }),
  },
  // Daily call activity summary posted to Slack — totals, connect rate,
  // top dispositions, agent breakdown. Skipped on zero-call days.
  {
    id: "phoneburner-digest-daily",
    schedule: "0 15 * * *",  // 15:00 UTC ≈ 8am PT (alongside other morning digests)
    description: "Daily PhoneBurner call summary to Slack — totals, connect rate, top dispositions, agents",
    handler: postPhoneBurnerCallDigest,
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
    id: "pipedrive-order-deal-sweep",
    schedule: "30 * * * *",  // hourly at :30
    description: "Represent recent wholesale orders as Won deals in Pipedrive (go-forward order→deal). No-ops until Pipedrive is connected. Opt-in: enable after the order-deal backfill is signed off.",
    handler: () => runOrderDealSweep(14),
    guard: () => isDuringBusinessHours(),
    // Off by default so connecting Pipedrive doesn't auto-create deals before
    // Daniel runs the dry-run backfill + sign-off (docs §9.3). Enable in the
    // cron settings UI when ready.
    defaultEnabled: false,
  },
  {
    id: "ajm-gmaps-enrich",
    schedule: "*/10 * * * *",  // every 10 min during business hours
    description: "Enrich the AJM cohort (ajm_2025) via Apify Google Maps — website, hours, rating, permanently-closed. Chips away ~40/run. Opt-in (Apify cost ~$2-3/1000).",
    handler: () => enrichViaGoogleMaps({ ajm: true, limit: 40 }) as Promise<unknown>,
    guard: () => isDuringBusinessHours(),
    defaultEnabled: false,
  },
  {
    id: "pipedrive-activity-sweep",
    schedule: "*/20 * * * *",  // every 20 min during business hours
    description: "Push recent Instantly/PhoneBurner engagement (emails, replies, calls) into Pipedrive as logged activities on the org/person/deal. No-ops until Pipedrive auto-sync is enabled.",
    handler: () => runActivitySweep(300),
    guard: () => isDuringBusinessHours(),
    defaultEnabled: false,
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
