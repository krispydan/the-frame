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
import { geocodeCompanies } from "@/modules/customers/lib/geocoding";
import { refreshIfExpiringSoon as refreshShipHeroToken } from "@/modules/operations/lib/shiphero/auth";
import { pullPhoneBurnerCallResults } from "@/modules/sales/lib/phoneburner-sync";
import { ensureFreshPhoneBurnerToken } from "@/modules/sales/lib/phoneburner-oauth";
import { reconcileContactEdits } from "@/modules/sales/lib/phoneburner-contact-sync";
import { enrichCatalogChunk } from "@/modules/sales/lib/catalog-mail";
import { postPhoneBurnerCallDigest } from "@/modules/integrations/lib/slack/phoneburner-digest";
import { runShopifyMetafieldSync } from "@/modules/catalog/lib/shopify-metafields/bulk-sync-job";
import { syncSettlementsAllShops } from "@/modules/finance/lib/shopify-settlements";
import { runShipmentRevenueRecognition } from "@/modules/finance/lib/shipment-revenue-recognition";
import { runDailyCogsPosting } from "@/modules/finance/lib/daily-cogs";
import { syncFairePayouts } from "@/modules/integrations/lib/faire/payout-sync";
import {
  syncAmazonOrders,
  syncAmazonSalesTraffic,
  syncAmazonSettlements,
  syncAmazonFbaInventory,
} from "@/modules/integrations/lib/amazon/sync";
import { runOrderDealSweep, runActivitySweep } from "@/modules/sales/lib/pipedrive-sync";
import { enrichViaGoogleMaps } from "@/modules/sales/lib/google-maps-enrichment";
import { recalculateAllHealthScores } from "@/modules/customers/lib/health-scoring";
import { refreshReorderEstimates } from "@/modules/customers/lib/reorder-engine";
import { calculateSellThrough } from "@/modules/inventory/lib/sell-through";
import { runWeeklyFaireExport } from "@/modules/sales/lib/faire-customer-export";
import { topUpVideoQueue } from "@/modules/marketing/lib/video/scheduler";
import { runVideoStorageHygiene } from "@/modules/marketing/lib/video/cleanup";
import { drainMetaLeads, reconcileMetaLeads } from "@/modules/integrations/lib/meta/lead-ingest";
import { runCapiSyncAndDrain } from "@/modules/integrations/lib/meta/capi";
import { runMetaLeadCsvReminder } from "@/modules/integrations/lib/meta/daily-reminder";
import { suppressBuyersFromMail } from "@/modules/sales/lib/shopify-wholesale-customer";
import { refreshStaleCustomerListings, captureListings, countRemaining, countControlListings } from "@/modules/sales/lib/gmaps-profile";

/**
 * How many "called, never ordered" listings to capture as the control group.
 * Enough to stabilise a baseline share for every common category; past that
 * it's Apify spend buying a third decimal place we won't act on.
 */
const CONTROL_SAMPLE_TARGET = 400;

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

// ─────────────────────────────────────────────────────────────────────────
// TEMPORARILY PAUSED — 2026-08-04 production OOM incident.
// The Apify / Google-Maps scraping and Meta lead jobs below balloon container
// memory past the plan's limit on their frequent schedules, OOM-killing the app
// in a restart loop (clean boot → memory sawtooth to the ceiling → SIGTERM →
// respawn). `guard: () => false` makes runJob() skip them REGARDLESS of
// cron_job_state.enabled — the DB toggle we can't reach while the app is down.
// To re-enable (ideally after bounding their memory use, and one at a time):
// remove the `guard: PAUSED_OOM` line from the job. None of these had a prior
// guard, so removal fully restores the original behavior.
// ─────────────────────────────────────────────────────────────────────────
const PAUSED_OOM = () => false;

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
  {
    id: "inventory-velocity-refresh",
    schedule: "40 11 * * *",  // 11:40 UTC ≈ 4:40am PT (after ShipHero sync window opens)
    description: "Recompute per-SKU sell-through velocity + reorder flags (all channels, pack-expanded) and write back to inventory",
    handler: async () => {
      const results = calculateSellThrough(30);
      return {
        skus: results.length,
        needsReorder: results.filter((r) => r.needsReorder).length,
        dead: results.filter((r) => r.velocity === "dead").length,
      };
    },
  },
  // ── Meta (Facebook/Instagram) Lead Ads ──
  // The leadgen webhook is the real-time path; these are the reliability net.
  // - drain: re-process any leads that failed or were interrupted by a
  //   container restart (rows stay 'received'/'error'). Cheap no-op when clean.
  // - capi-sync: derive funnel-stage events (Contacted/Qualified/Converted)
  //   from current DB state and flush the CAPI queue to Meta.
  // - reconcile: hourly re-poll of known forms to catch any dropped webhook.
  {
    id: "meta-leads-drain",
    guard: PAUSED_OOM,  // paused: OOM incident 2026-08-04
    schedule: "*/3 * * * *",  // every 3 min
    description: "Process any pending/errored Facebook Lead Ads leads (webhook safety net) → frame + Pipedrive + Slack",
    handler: () => drainMetaLeads(25),
    fireAndForget: true,
  },
  {
    id: "meta-capi-sync",
    guard: PAUSED_OOM,  // paused: OOM incident 2026-08-04
    schedule: "*/10 * * * *",  // every 10 min
    description: "Derive Facebook lead funnel-stage events from CRM state and push them to Meta's Conversions API",
    handler: () => runCapiSyncAndDrain(),
    fireAndForget: true,
  },
  {
    id: "meta-leads-reconcile",
    guard: PAUSED_OOM,  // paused: OOM incident 2026-08-04
    schedule: "17 * * * *",  // hourly at :17
    description: "Re-poll known Facebook lead forms for any submissions the webhook dropped (safety net)",
    handler: () => reconcileMetaLeads(50),
    fireAndForget: true,
  },
  // Daily nudge to download the Meta lead export and upload it, because the
  // leadgen webhook can't run until Meta approves leads_retrieval. Reports what
  // actually happened yesterday and escalates its subject line when nothing has
  // been uploaded for days. Self-retiring: once real webhook deliveries start
  // landing it sends one "you can stop" note and then goes quiet.
  {
    id: "meta-leads-csv-reminder",
    guard: PAUSED_OOM,  // paused: OOM incident 2026-08-04 (low-memory email job — safe to re-enable first)
    schedule: "0 15 * * *",  // 15:00 UTC ≈ 8am PT — start of the sales day
    description: "Email the daily reminder to download Facebook leads from Meta and upload the CSV (stops itself once the leadgen webhook is live)",
    handler: runMetaLeadCsvReminder,
  },
  // "Mail them until they buy" only works if something stops the mail.
  // PostPilot segments on the postpilot-mail tag, so removing it once an order
  // lands is the off switch. Runs as a sweep rather than on the order webhook
  // because an order can arrive through any channel (Faire, phone, either
  // Shopify store), and only the frame sees all of them.
  {
    id: "shopify-suppress-mailed-buyers",
    schedule: "40 14 * * *",  // 14:40 UTC ~ 7:40am PT, after the orders sync
    description: "Remove the postpilot-mail tag from wholesale customers who have now ordered, so direct mail stops",
    handler: () => suppressBuyersFromMail(200),
  },
  // Google Maps data ages: ratings and review counts drift, hours change, and
  // a permanently-closed flag we never re-check is how a rep ends up calling a
  // shut store. Small nightly slice rather than a big periodic sweep, so Apify
  // spend stays flat and predictable.
  {
    id: "gmaps-refresh-customer-listings",
    schedule: "30 12 * * *",  // 12:30 UTC ≈ 5:30am PT
    description: "Refresh Google Maps listings for customers whose data is over 120 days old (rating, reviews, hours, closure)",
    handler: () => refreshStaleCustomerListings(20, 120),
    fireAndForget: true,
  },
  // Initial backfill of the profiling cohorts. This used to run as a long
  // admin POST and kept tripping Railway's proxy timeout — one Apify run for
  // five stores is minutes, and a 20-store request is not a request. So it
  // drains here instead, five at a time, and no-ops once both cohorts are in.
  //
  // Customers first: they're the signal. Controls (called, never ordered) are
  // capped because they're only the denominator — a few hundred pins down the
  // baseline share of every category, and the next 2,700 would just be spend.
  {
    id: "gmaps-profile-backfill",
    guard: PAUSED_OOM,  // paused: OOM incident 2026-08-04 (Apify captureListings — memory-heavy)
    // */5, not */3, because the Railway cron service ticks every FIVE minutes
    // despite what docs/scheduled-jobs.md says. A "*/3" schedule only fires on
    // the ticks whose minute is also divisible by 3 — :00, :15, :30, :45 — so
    // it silently means "every 15 minutes". Match the tick cadence or the
    // schedule you wrote is not the schedule you get.
    schedule: "*/5 * * * *",
    description: "Backfill Google Maps listings for the profiling cohorts — customers first, then a capped control sample",
    handler: async () => {
      const cohort = countRemaining("customers") > 0
        ? "customers" as const
        : countControlListings() < CONTROL_SAMPLE_TARGET
          ? "called-no-order" as const
          : null;
      if (!cohort) return { done: true, controls: countControlListings() };

      // detail: false — the detail-page crawl only supplies hours and
      // description; everything the profile is built from comes back without
      // it. batchSize: 1 because Apify has been overrunning its own 300s
      // ceiling for hours, and a batch loses every store in it when that
      // happens — three-at-a-time turned one slow store into three lost ones
      // and captured 5 listings in nine hours. One at a time is slower when
      // Apify is healthy and is the difference between progress and none when
      // it isn't. The salvage pass then doubles as a retry of that one store.
      const res = await captureListings({ cohort, limit: 6, detail: false, batchSize: 1 });
      // A tick that captured nothing because Apify timed out is a failure, and
      // cron_runs is the only place anyone will look. Reporting "ok" here is
      // how a backfill sits at zero for an hour without anyone noticing.
      if (res.captured === 0 && res.errors.length > 0) {
        throw new Error(`captured 0 of ${res.attempted}: ${res.errors[0].reason}`);
      }
      return { cohort, ...res };
    },
    fireAndForget: true,
  },
  {
    id: "faire-interested-export",
    schedule: "0 14 * * 1",  // Mondays 14:00 UTC ≈ 7am PT
    description: "Email a CSV of new interested leads to add to Faire (Customers bulk upload + Campaigns). First run carries the current interested backlog; then only new leads each week.",
    handler: runWeeklyFaireExport,
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

  // ── Amazon channel (via Windsor AI) ──
  // Data lands in raw archive tables first; everything downstream derives
  // from those, never from a live Windsor call. See docs/amazon-channel-plan.md.
  //
  // Placement in the daily chain matters. Orders land at 14:10 so they are
  // present before revenue recognition (16:30) and daily COGS (16:45).
  // Settlements land at 16:20 — after Faire (16:15) so the Xero call rate
  // stays spread out, and before recognition, which needs the settlement
  // bridge rows to join orders to payouts.
  //
  // All four are gated on WINDSOR_API_KEY: without it every run would fail
  // identically and bury the genuine failures in noise.
  {
    id: "amazon-orders-sync",
    schedule: "10 14 * * *",  // 14:10 UTC ≈ 7:10am PT
    description: "Pull Amazon orders (by order date + by last update) from Windsor into the raw archive",
    handler: () => syncAmazonOrders({}),
    guard: () => Boolean(process.env.WINDSOR_API_KEY),
  },
  {
    id: "amazon-sales-traffic-sync",
    schedule: "30 14 * * *",  // 14:30 UTC ≈ 7:30am PT
    description: "Pull Amazon daily sales + traffic metrics (sessions, Buy Box, conversion) for the dashboard",
    handler: () => syncAmazonSalesTraffic({}),
    guard: () => Boolean(process.env.WINDSOR_API_KEY),
  },
  {
    id: "amazon-fba-inventory-sync",
    schedule: "0 13 * * *",   // 13:00 UTC ≈ 6:00am PT
    description: "Snapshot FBA stock on hand — units held at Amazon that ShipHero cannot see",
    handler: () => syncAmazonFbaInventory({}),
    guard: () => Boolean(process.env.WINDSOR_API_KEY),
  },
  {
    id: "amazon-settlement-sync",
    schedule: "20 16 * * *",  // 16:20 UTC ≈ 9:20am PT
    description: "Archive Amazon settlement rows (Windsor serves only 90 days — this is the permanent copy)",
    handler: () => syncAmazonSettlements({}),
    guard: () => Boolean(process.env.WINDSOR_API_KEY),
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
    id: "geocode-customers",
    schedule: "0 4 * * *",  // daily at 4am UTC — off-peak for Nominatim
    description: "Geocode customer company addresses for the customer map (Nominatim, rate-limited)",
    // Small nightly batch: newly-added customers get pinned within a day.
    // Bounded to 60/run so a daily tick stays well under Nominatim limits.
    handler: () => geocodeCompanies({ limit: 60, customersOnly: true }),
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
    guard: PAUSED_OOM,  // paused: OOM incident 2026-08-04 (Apify enrichment — prime suspect, */10 matches restart cadence)
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
  // Keep Christina's OAuth access token fresh. PhoneBurner tokens expire (they
  // arrive with a refresh_token); the hourly daily-folder builder and the call
  // poller read the stored token, so without renewal her account goes dark when
  // the token lapses. Refreshes only when within ~5 min of expiry — a no-op
  // otherwise, and a no-op entirely if she hasn't connected via OAuth. Sandra's
  // account uses a long-lived env key and isn't touched here.
  {
    id: "phoneburner-token-refresh-christina",
    schedule: "*/20 * * * *",  // every 20 min — well inside a 1h token life
    description: "Refresh Christina's PhoneBurner OAuth access token before it expires (no-op until she connects / until near expiry)",
    handler: async () => {
      const token = await ensureFreshPhoneBurnerToken("christina").catch((e) => {
        throw e instanceof Error ? e : new Error(String(e));
      });
      return { refreshed: !!token, hasToken: !!token };
    },
  },
  // Drain the catalog direct-mail cohort's missing street addresses via Apify
  // Google Maps, in small restart-safe chunks. Self-stops once every
  // Catalog-Interested lead is either addressed or tagged no-result. fire-and-
  // forget so a slow Apify batch doesn't 524 the tick. Disable in the cron UI
  // once the cohort is drained.
  {
    id: "catalog-mail-address-enrich",
    schedule: "*/5 * * * *",  // every 5 min
    description: "Fill missing mailing addresses for the Catalog-Interested direct-mail cohort via Apify Google Maps (chunked, self-stopping)",
    handler: () => enrichCatalogChunk(12),
    fireAndForget: true,
  },
  // Reconcile agent-side contact edits from PhoneBurner. PB has no
  // contact-edit webhook, so we poll the /contacts list (ordered by
  // date_updated) and sync any email that now differs from the frame back into
  // the frame + Pipedrive. Watermark per account keeps each run cheap. Runs
  // during business hours (when agents are dialing/editing).
  {
    id: "phoneburner-contact-edit-sync",
    schedule: "*/15 * * * *",  // every 15 min
    description: "Poll PhoneBurner for agent-edited contact emails and sync them back to the frame + Pipedrive (no PB contact-edit webhook exists)",
    handler: () => reconcileContactEdits({ maxPages: 5 }),
    guard: () => isDuringBusinessHours(),
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

  // ── Video Remix Studio ──
  {
    id: "video-queue-top-up",
    schedule: "0 13 * * *",  // 13:00 UTC ≈ 6am PT daily
    description: "Compose + enqueue renders so the next 7 days have a video post in every slot (3/day). Opt-in — enable once the clip library is seeded.",
    handler: () => topUpVideoQueue({ horizonDays: 7 }) as unknown as Promise<unknown>,
    // Opt-in: with an empty clip library this would just log warnings
    // every morning. Flip on in the cron settings UI after seeding.
    defaultEnabled: false,
    // Composing 21 slots + trend detection can exceed the edge timeout
    // on a cold cache; renders themselves run via the job queue anyway.
    fireAndForget: true,
  },
  {
    id: "video-storage-hygiene",
    schedule: "0 12 * * 1",  // Mondays 12:00 UTC ≈ 5am PT
    description: "Delete render files for posts posted >60d ago / discarded, sweep tmp/, report disk usage + permutation headroom per recipe",
    handler: () => runVideoStorageHygiene(),
  },
  // ── Sales: Pipedrive call activities → PhoneBurner rep folders ──
  {
    id: "build-call-folders",
    schedule: "0 13 * * *",  // 13:00 UTC ≈ 6am PT — before the reps start dialing
    description: "Build each rep's PhoneBurner daily follow-up folder from their open Pipedrive call activities (create PB contact if missing, move in, stamp activity id, clear completed) + post the #sales-leads digest.",
    handler: async () => {
      const { buildDailyCallFolders } = await import("@/modules/sales/lib/pipedrive-call-sync");
      return buildDailyCallFolders({ dryRun: false });
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
