/**
 * Amazon sync orchestrators — fetch from Windsor, land into the raw archive,
 * record health.
 *
 * Each function follows the same shape: mark running, fetch, ingest, mark
 * success or failure. That bookkeeping is not ceremony — Windsor's Amazon
 * reports are measurably unreliable (some respond in 2s, others never
 * return), so "which report last worked, and how many times has it failed in
 * a row" is the difference between a system we can trust and one that
 * quietly stops importing.
 *
 * Alerting is deliberately debounced: a single timeout is noise and would
 * page someone most nights, so Slack only fires once a report has failed
 * ALERT_AFTER_FAILURES times consecutively. A recovery clears the counter.
 */

import {
  fetchWindsorReport,
  WindsorError,
  redact,
  type WindsorRow,
} from "@/modules/integrations/lib/windsor/client";
import { notifyIntegrationFailure } from "@/modules/integrations/lib/slack/notifications";
import { sqlite } from "@/lib/db";
import {
  ORDERS_BY_ORDER_DATE,
  ORDERS_BY_LAST_UPDATE,
  SETTLEMENTS,
  SALES_TRAFFIC,
  SALES_TRAFFIC_BY_ASIN,
  MERCHANT_LISTINGS,
  FBA_INVENTORY,
  REPORT_KEYS,
  clampToSettlementWindow,
  latestAvailableDate,
  type ReportKey,
} from "./reports";
import {
  ingestOrderRows,
  ingestSettlementRows,
  ingestSalesTraffic,
  ingestAsinTraffic,
  ingestListings,
  ingestFbaInventory,
  markSyncRunning,
  markSyncSuccess,
  markSyncFailure,
  type IngestResult,
} from "./ingest";

/** Consecutive failures before a report is worth waking someone for. */
export const ALERT_AFTER_FAILURES = 3;

/** Default trailing window. Amazon restates recent days, so we re-pull them. */
const DEFAULT_TRAILING_DAYS = 7;

export interface SyncOutcome {
  report: ReportKey;
  ok: boolean;
  dateFrom?: string;
  dateTo?: string;
  ingest?: IngestResult;
  /** Set when ok === false. Always redacted — never contains the API key. */
  error?: string;
  errorKind?: string;
  consecutiveFailures?: number;
  /** True when the requested range was trimmed to what Amazon will serve. */
  clamped?: boolean;
  notes?: string[];
  durationMs: number;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function subtractDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Shared wrapper: health bookkeeping, error redaction, debounced alerting.
 *
 * Non-retryable configuration errors (no account linked, unknown connector,
 * missing API key) alert immediately rather than waiting for three failures —
 * they will never fix themselves, and the sooner someone sees them the less
 * data is lost to the 90-day settlement window.
 */
async function runSync(
  report: ReportKey,
  label: string,
  fn: () => Promise<{ ingest: IngestResult; dateFrom?: string; dateTo?: string; syncedThrough?: string; clamped?: boolean; notes?: string[] }>,
): Promise<SyncOutcome> {
  const started = Date.now();
  markSyncRunning(report);
  try {
    const { ingest, dateFrom, dateTo, syncedThrough, clamped, notes } = await fn();
    markSyncSuccess(report, {
      syncedThrough: syncedThrough ?? dateTo ?? null,
      rowsIngested: ingest.inserted + ingest.updated,
    });
    return {
      report, ok: true, dateFrom, dateTo, ingest, clamped, notes,
      durationMs: Date.now() - started,
    };
  } catch (e) {
    const err = e as WindsorError | Error;
    const kind = err instanceof WindsorError ? err.kind : "unknown";
    const message = redact(err.message ?? String(err));

    // "No data in this period" is a legitimate answer, not a fault. Amazon
    // cancels the report request outright when a period is empty, so a
    // business with no returns this week would otherwise see its returns
    // sync fail every night. Record it as a successful empty run.
    if (kind === "no_data") {
      markSyncSuccess(report, { rowsIngested: 0 });
      return {
        report,
        ok: true,
        ingest: { received: 0, inserted: 0, updated: 0, skipped: 0, rejected: [] },
        notes: ["Amazon reported no data for this period — recorded as an empty run, not a failure."],
        durationMs: Date.now() - started,
      };
    }

    const failures = markSyncFailure(report, `${kind}: ${message}`);

    const isConfigError =
      err instanceof WindsorError &&
      (err.kind === "auth" || err.kind === "no_account" || err.kind === "unknown_connector" || err.kind === "bad_fields");

    if (isConfigError || failures >= ALERT_AFTER_FAILURES) {
      try {
        await notifyIntegrationFailure({
          service: `Amazon — ${label}`,
          detail: isConfigError
            ? `${message} (configuration problem — this will not resolve on its own)`
            : `${message}\nFailed ${failures} runs in a row.`,
          fixUrl: isConfigError ? "https://onboard.windsor.ai/" : undefined,
        });
      } catch {
        // A Slack outage must never turn a recoverable sync failure into an
        // unhandled rejection that kills the whole cron tick.
      }
    }

    return {
      report, ok: false, error: message, errorKind: kind,
      consecutiveFailures: failures, durationMs: Date.now() - started,
    };
  }
}

/**
 * Pull both all-orders variants and land them.
 *
 * Both are needed and they are not redundant: the order-date report finds new
 * orders, while the last-update report catches ships, cancellations and
 * restatements of orders placed before the current window. The last-update
 * pull is also our only source of a shipped timestamp, since the FBA
 * shipments report is unusable (see reports.ts NOT_AVAILABLE).
 */
export async function syncAmazonOrders(
  opts: { dateFrom?: string; dateTo?: string; days?: number; today?: string } = {},
): Promise<SyncOutcome[]> {
  const today = opts.today ?? todayUtc();
  const dateTo = opts.dateTo ?? latestAvailableDate(today);
  const dateFrom = opts.dateFrom ?? subtractDays(dateTo, (opts.days ?? DEFAULT_TRAILING_DAYS) - 1);

  const byOrderDate = await runSync(REPORT_KEYS.ordersByOrderDate, "orders by order date", async () => {
    const rows = await fetchWindsorReport(ORDERS_BY_ORDER_DATE, { dateFrom, dateTo });
    return { ingest: ingestOrderRows(rows), dateFrom, dateTo };
  });

  const byLastUpdate = await runSync(REPORT_KEYS.ordersByLastUpdate, "orders by last update", async () => {
    const rows = await fetchWindsorReport(ORDERS_BY_LAST_UPDATE, { dateFrom, dateTo });
    return { ingest: ingestOrderRows(rows), dateFrom, dateTo };
  });

  return [byOrderDate, byLastUpdate];
}

/**
 * The cron entry point: pull orders into the archive, then normalise them
 * into `orders` / `order_items`.
 *
 * The import runs even when a fetch failed. The archive still holds
 * everything earlier runs landed, and importing that is strictly better than
 * skipping a night's normalisation because Windsor had a slow report.
 *
 * Imported here rather than at module scope to keep the orders module out of
 * the integrations module's import graph at load time — the cron registry
 * imports this file, and a cycle would surface as an undefined handler.
 */
export async function syncAndImportAmazonOrders(
  opts: { dateFrom?: string; dateTo?: string; days?: number; today?: string } = {},
): Promise<{ fetch: SyncOutcome[]; imported: unknown }> {
  const fetchOutcomes = await syncAmazonOrders(opts);

  const { importAmazonOrders } = await import("@/modules/orders/lib/amazon-sync");
  const imported = importAmazonOrders({ since: opts.dateFrom, until: opts.dateTo });

  // An unmapped SKU means a line that cannot be costed, so it becomes a COGS
  // exception later. Surfacing it at import time is much cheaper to act on
  // than discovering it in a month-end reconciliation.
  if (imported.unmappedSkus.length > 0) {
    try {
      await notifyIntegrationFailure({
        service: "Amazon — SKU mapping",
        detail:
          `${imported.unmappedSkus.length} Amazon SKU(s) do not resolve to a catalog SKU and cannot be costed: ` +
          `${imported.unmappedSkus.slice(0, 10).join(", ")}${imported.unmappedSkus.length > 10 ? ", …" : ""}. ` +
          `Add them to catalog_sku_aliases, or correct the listing SKU in Seller Central.`,
      });
    } catch {
      // Alerting is best-effort; never fail the sync over it.
    }
  }

  return { fetch: fetchOutcomes, imported };
}

/**
 * Pull settlement rows into the permanent archive.
 *
 * Clamps to Amazon's 90-day retention and reports when it had to, so an
 * operator asking for a year of history is told the truth rather than being
 * handed a short result that looks like a trading gap.
 */
export async function syncAmazonSettlements(
  opts: { dateFrom?: string; dateTo?: string; days?: number; today?: string } = {},
): Promise<SyncOutcome> {
  const today = opts.today ?? todayUtc();
  const requestedTo = opts.dateTo ?? today;
  const requestedFrom = opts.dateFrom ?? subtractDays(requestedTo, (opts.days ?? 30) - 1);
  const clamp = clampToSettlementWindow(requestedFrom, requestedTo, today);

  return runSync(REPORT_KEYS.settlements, "settlements", async () => {
    const rows = await fetchWindsorReport(SETTLEMENTS, {
      dateFrom: clamp.dateFrom,
      dateTo: clamp.dateTo,
    });
    const notes: string[] = [];
    if (clamp.clamped) {
      notes.push(
        `Requested from ${requestedFrom}, but Amazon only serves settlements for the last 90 days — clamped to ${clamp.dateFrom}. Anything earlier is permanently unavailable upstream and can only come from this archive.`,
      );
    }
    return {
      ingest: ingestSettlementRows(rows),
      dateFrom: clamp.dateFrom,
      dateTo: clamp.dateTo,
      clamped: clamp.clamped,
      notes,
    };
  });
}

/**
 * The settlement cron entry point: archive settlement rows, then bridge the
 * closed ones into `settlements` / `settlement_line_items`.
 *
 * Bridging runs even when the fetch failed — the archive already holds
 * earlier settlements, and a settlement that closed yesterday should be
 * bridged tonight regardless of whether Windsor answered.
 *
 * Two conditions raise alerts because both mean money is being booked on an
 * assumption that no longer holds: an unrecognised fee type (which would
 * otherwise land in suspense unnoticed) and facilitator-tax legs that stop
 * cancelling (which would mean we owe tax we are not recording).
 */
export async function syncAndBridgeAmazonSettlements(
  opts: { dateFrom?: string; dateTo?: string; days?: number; today?: string } = {},
): Promise<{ fetch: SyncOutcome; bridge: unknown; posted: unknown }> {
  const fetchOutcome = await syncAmazonSettlements(opts);

  const { bridgeAmazonSettlements } = await import("./settlement-bridge");
  const bridge = bridgeAmazonSettlements({ today: opts.today });

  if (bridge.unclassified.length > 0) {
    const lines = bridge.unclassified.slice(0, 5).map((u) => `• ${u.reason} (${u.amount})`).join("\n");
    try {
      await notifyIntegrationFailure({
        service: "Amazon — unclassified settlement lines",
        detail:
          `${bridge.unclassified.length} settlement line(s) did not match any known fee type and have been booked to the suspense account:\n${lines}\n` +
          `Add the mapping in settlement-classify.ts, then re-bridge to reclassify.`,
      });
    } catch { /* alerting is best-effort */ }
  }

  if (bridge.taxResiduals.length > 0) {
    const lines = bridge.taxResiduals.map((t) => `• ${t.settlementId}: ${t.residual}`).join("\n");
    try {
      await notifyIntegrationFailure({
        service: "Amazon — marketplace tax no longer nets to zero",
        detail:
          `We net Amazon's collected and withheld facilitator tax on the basis that they cancel exactly. ` +
          `These settlements break that assumption, which means a real tax liability may be going unrecorded:\n${lines}`,
      });
    } catch { /* alerting is best-effort */ }
  }

  // Post to Xero last, once the archive and bridge are settled. Gated on a
  // setting so the first live run can be a deliberate act rather than
  // something that happens overnight: `amazon_xero_posting` must be
  // "draft" or "posted". Unset means build-and-check only.
  let posted: unknown = null;
  const mode = readPostingMode();
  if (mode !== "off") {
    const { syncAmazonSettlementsToXero } = await import("./payout-sync");
    posted = await syncAmazonSettlementsToXero({
      status: mode === "draft" ? "DRAFT" : "POSTED",
    });
  }

  return { fetch: fetchOutcome, bridge, posted };
}

/**
 * Whether settlements post to Xero, and how.
 *
 * Deliberately opt-in. Journals are hard to unpick once posted, so the first
 * live run should be a decision someone makes, not a side effect of the
 * nightly cron. Set `amazon_xero_posting` in settings to "draft" (posts
 * unapproved journals for review) or "posted" (live).
 */
function readPostingMode(): "off" | "draft" | "posted" {
  try {
    const row = sqlite
      .prepare("SELECT value FROM settings WHERE key = 'amazon_xero_posting' LIMIT 1")
      .get() as { value: string } | undefined;
    const v = (row?.value ?? "").trim().toLowerCase();
    return v === "draft" || v === "posted" ? v : "off";
  } catch {
    return "off";
  }
}

/** Pull daily sales + traffic metrics (dashboard analytics). */
export async function syncAmazonSalesTraffic(
  opts: { dateFrom?: string; dateTo?: string; days?: number; today?: string } = {},
): Promise<SyncOutcome> {
  const today = opts.today ?? todayUtc();
  const dateTo = opts.dateTo ?? latestAvailableDate(today);
  const dateFrom = opts.dateFrom ?? subtractDays(dateTo, (opts.days ?? DEFAULT_TRAILING_DAYS) - 1);

  return runSync(REPORT_KEYS.salesTraffic, "sales & traffic", async () => {
    const rows = await fetchWindsorReport(SALES_TRAFFIC, { dateFrom, dateTo });
    return { ingest: ingestSalesTraffic(rows), dateFrom, dateTo };
  });
}

/**
 * Pull per-ASIN daily sales + traffic.
 *
 * Separate from the by-date sync rather than folded into it: the by-ASIN
 * variant multiplies row volume by the catalogue and takes a much tighter
 * window, so a slow ASIN pull must not be able to take the account-level
 * numbers down with it. Two report keys, two health rows, two failure modes.
 */
export async function syncAmazonAsinTraffic(
  opts: { dateFrom?: string; dateTo?: string; days?: number; today?: string } = {},
): Promise<SyncOutcome> {
  const today = opts.today ?? todayUtc();
  const dateTo = opts.dateTo ?? latestAvailableDate(today);
  const dateFrom = opts.dateFrom ?? subtractDays(dateTo, (opts.days ?? DEFAULT_TRAILING_DAYS) - 1);

  return runSync(REPORT_KEYS.salesTrafficByAsin, "sales & traffic by ASIN", async () => {
    const rows = await fetchWindsorReport(SALES_TRAFFIC_BY_ASIN, { dateFrom, dateTo });
    return { ingest: ingestAsinTraffic(rows), dateFrom, dateTo };
  });
}

/**
 * Pull listing metadata — titles and the ASIN↔SKU bridge.
 *
 * A current-state snapshot with no date dimension, like FBA inventory.
 * Titles change rarely, so this runs daily rather than on the sales cadence.
 */
export async function syncAmazonListings(
  opts: { today?: string } = {},
): Promise<SyncOutcome> {
  const today = opts.today ?? todayUtc();
  return runSync(REPORT_KEYS.merchantListings, "merchant listings", async () => {
    const rows: WindsorRow[] = await fetchWindsorReport(MERCHANT_LISTINGS, { datePreset: "last_7d" });
    return { ingest: ingestListings(rows), syncedThrough: today };
  });
}

/**
 * Snapshot FBA stock on hand.
 *
 * The upstream report is a live snapshot with no date dimension, so it is
 * requested with a short preset and stamped with today's date on arrival.
 */
export async function syncAmazonFbaInventory(
  opts: { snapshotDate?: string; today?: string } = {},
): Promise<SyncOutcome> {
  const today = opts.today ?? todayUtc();
  const snapshotDate = opts.snapshotDate ?? today;

  return runSync(REPORT_KEYS.fbaInventory, "FBA inventory", async () => {
    const rows: WindsorRow[] = await fetchWindsorReport(FBA_INVENTORY, { datePreset: "last_7d" });
    return {
      ingest: ingestFbaInventory(rows, snapshotDate),
      syncedThrough: snapshotDate,
    };
  });
}

export interface BackfillResult {
  outcomes: SyncOutcome[];
  totalInserted: number;
  totalUpdated: number;
  totalRejected: number;
  warnings: string[];
  durationMs: number;
}

/**
 * One-shot historical backfill.
 *
 * Runs reports sequentially rather than in parallel: Windsor is already slow
 * per report, and firing several long-running report generations at once
 * against the same upstream account makes timeouts more likely, not less.
 *
 * Order matters — settlements go first because they are the only data with a
 * hard expiry. If the process is interrupted, the irreplaceable rows are
 * already safe.
 */
export async function backfillAmazon(
  opts: { from: string; to?: string; today?: string; includeInventory?: boolean },
): Promise<BackfillResult> {
  const started = Date.now();
  const today = opts.today ?? todayUtc();
  const to = opts.to ?? latestAvailableDate(today);

  // Validate before doing anything: a malformed start date would otherwise
  // produce an empty pull that looks like a successful no-op backfill, which
  // is the one outcome nobody would think to re-check.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.from)) {
    throw new Error(`backfillAmazon: "from" must be a YYYY-MM-DD date, got "${opts.from}".`);
  }
  if (Date.parse(`${opts.from}T00:00:00Z`) > Date.parse(`${to}T00:00:00Z`)) {
    throw new Error(`backfillAmazon: "from" (${opts.from}) is after "to" (${to}).`);
  }
  const outcomes: SyncOutcome[] = [];
  const warnings: string[] = [];

  outcomes.push(await syncAmazonSettlements({ dateFrom: opts.from, dateTo: opts.to ?? today, today }));
  outcomes.push(...(await syncAmazonOrders({ dateFrom: opts.from, dateTo: to, today })));
  outcomes.push(await syncAmazonSalesTraffic({ dateFrom: opts.from, dateTo: to, today }));
  if (opts.includeInventory !== false) {
    outcomes.push(await syncAmazonFbaInventory({ today }));
  }

  for (const o of outcomes) {
    if (!o.ok) warnings.push(`${o.report}: ${o.errorKind} — ${o.error}`);
    for (const n of o.notes ?? []) warnings.push(`${o.report}: ${n}`);
    const rejected = o.ingest?.rejected ?? [];
    if (rejected.length > 0) {
      warnings.push(`${o.report}: ${rejected.length} row(s) rejected — ${rejected[0].reason}`);
    }
  }

  return {
    outcomes,
    totalInserted: outcomes.reduce((s, o) => s + (o.ingest?.inserted ?? 0), 0),
    totalUpdated: outcomes.reduce((s, o) => s + (o.ingest?.updated ?? 0), 0),
    totalRejected: outcomes.reduce((s, o) => s + (o.ingest?.rejected.length ?? 0), 0),
    warnings,
    durationMs: Date.now() - started,
  };
}
