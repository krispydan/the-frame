/**
 * Amazon raw-landing writers.
 *
 * Every Windsor row lands here before anything else looks at it. Downstream
 * code (order import, Xero journals, dashboards) reads these tables and never
 * calls Windsor directly, for two reasons:
 *
 *  - Amazon serves settlements for 90 days only. Once a row ages out it is
 *    unrecoverable, so "catch it once, keep it forever" is the whole game.
 *  - Landing raw means a mapping bug is a re-derivation, not a re-fetch of
 *    data that no longer exists.
 *
 * Idempotency differs by table, on purpose:
 *  - Order rows UPSERT: Amazon restates them (Pending → Shipped → Cancelled).
 *  - Settlement rows APPEND-SKIP: a posted settlement line is immutable, so a
 *    changed value is an anomaly to surface, not something to overwrite.
 *  - Traffic and inventory UPSERT by date: Amazon restates recent days.
 */

import { sqlite } from "@/lib/db";
import type { WindsorRow } from "@/modules/integrations/lib/windsor/client";
import type { ReportKey } from "./reports";

/** Money/quantity coercion: Windsor mixes numbers, numeric strings and "". */
export function num(v: unknown): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** Text coercion that collapses Windsor's empty strings to null. */
export function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** Round to cents — repo-wide convention for REAL dollar columns. */
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Amazon SKUs are our SKU plus an optional `-FBA` suffix, marking stock sent
 * to Amazon's warehouse (`JX1010-TOR-FBA`) versus stock shipped from ours
 * (`JX4006-BLK`). Both are real listings for the same physical product, so
 * costing, inventory and reporting must resolve them to one internal SKU.
 *
 * Case-insensitive on the suffix only; the SKU body is returned untouched
 * because `catalog_skus` is case-sensitive.
 */
export function toInternalSku(amazonSku: string | null | undefined): string | null {
  const s = str(amazonSku);
  if (!s) return null;
  return s.replace(/-FBA$/i, "");
}

/** True when the SKU denotes FBA-fulfilled stock. */
export function isFbaSku(amazonSku: string | null | undefined): boolean {
  const s = str(amazonSku);
  return !!s && /-FBA$/i.test(s);
}

export interface IngestResult {
  /** Rows returned by Windsor. */
  received: number;
  /** Rows newly written. */
  inserted: number;
  /** Existing rows refreshed (upsert tables only). */
  updated: number;
  /** Rows already present and intentionally left alone (append-only tables). */
  skipped: number;
  /** Rows rejected as unusable, with the reason — surfaced, never swallowed. */
  rejected: Array<{ reason: string; row: WindsorRow }>;
}

function emptyResult(): IngestResult {
  return { received: 0, inserted: 0, updated: 0, skipped: 0, rejected: [] };
}

/**
 * Land rows from either all-orders report.
 *
 * Both variants share a field shape, so one writer serves both. The
 * last-update pull refreshes `item_status` / `last_updated_date` on rows the
 * order-date pull created — that refresh is how a Pending order ever becomes
 * Shipped in our copy.
 */
export function ingestOrderRows(rows: WindsorRow[]): IngestResult {
  const result = emptyResult();
  result.received = rows.length;

  const selectStmt = sqlite.prepare(
    "SELECT id FROM amazon_order_rows WHERE amazon_order_id = ? AND sku = ?",
  );
  const insertStmt = sqlite.prepare(`
    INSERT INTO amazon_order_rows (
      id, amazon_order_id, sku, asin, quantity, item_price, item_tax,
      item_promotion_discount, ship_promotion_discount, shipping_price, shipping_tax,
      order_status, item_status, fulfillment_channel, sales_channel, currency,
      purchase_date, last_updated_date, ship_city, ship_state, ship_postal_code,
      ship_country, is_business_order, raw_json, ingested_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `);
  const updateStmt = sqlite.prepare(`
    UPDATE amazon_order_rows SET
      asin = ?, quantity = ?, item_price = ?, item_tax = ?,
      item_promotion_discount = ?, ship_promotion_discount = ?, shipping_price = ?,
      shipping_tax = ?, order_status = ?, item_status = ?, fulfillment_channel = ?,
      sales_channel = ?, currency = ?, purchase_date = COALESCE(?, purchase_date),
      last_updated_date = ?, ship_city = ?, ship_state = ?, ship_postal_code = ?,
      ship_country = ?, is_business_order = ?, raw_json = ?, updated_at = datetime('now')
    WHERE id = ?
  `);

  const run = sqlite.transaction((batch: WindsorRow[]) => {
    for (const row of batch) {
      const orderId = str(row.amazon_order_id);
      const sku = str(row.sku);
      // Without both keys the row cannot be deduped or joined to anything.
      if (!orderId || !sku) {
        result.rejected.push({ reason: "missing amazon_order_id or sku", row });
        continue;
      }

      const values = [
        str(row.asin),
        Math.trunc(num(row.quantity)),
        round2(num(row.item_price)),
        round2(num(row.item_tax)),
        round2(num(row.item_promotion_discount)),
        round2(num(row.ship_promotion_discount)),
        round2(num(row.shipping_price)),
        round2(num(row.shipping_tax)),
        str(row.order_status),
        str(row.item_status),
        str(row.fulfillment_channel),
        str(row.sales_channel),
        str(row.currency) ?? "USD",
        str(row.purchase_date),
        str(row.last_updated_date),
        str(row.ship_city),
        str(row.ship_state),
        str(row.ship_postal_code),
        str(row.ship_country),
        str(row.is_business_order),
        JSON.stringify(row),
      ];

      const existing = selectStmt.get(orderId, sku) as { id: string } | undefined;
      if (existing) {
        updateStmt.run(...values, existing.id);
        result.updated++;
      } else {
        insertStmt.run(crypto.randomUUID(), orderId, sku, ...values);
        result.inserted++;
      }
    }
  });
  run(rows);

  return result;
}

/**
 * Land settlement rows. Append-only.
 *
 * A settlement line, once Amazon has posted it, never changes, so this writer
 * never updates — it only adds what is missing.
 *
 * Deduplication is by COUNT per identity rather than by existence, and that
 * distinction matters financially. Amazon legitimately emits several
 * economically identical rows for one order (two promotions of the same value
 * on the same item, say). An existence check would drop every duplicate after
 * the first and quietly understate the settlement — the worst class of bug
 * here, because the books would still balance against themselves while being
 * wrong. Counting keeps genuine duplicates and stays idempotent: a re-pull
 * sees equal counts and inserts nothing.
 */
export function ingestSettlementRows(rows: WindsorRow[]): IngestResult {
  const result = emptyResult();
  result.received = rows.length;

  const countStmt = sqlite.prepare(`
    SELECT COUNT(*) AS n FROM amazon_settlement_rows
    WHERE settlement_id = ?
      AND IFNULL(order_id, '') = IFNULL(?, '')
      AND IFNULL(sku, '') = IFNULL(?, '')
      AND IFNULL(amount_type, '') = IFNULL(?, '')
      AND IFNULL(amount_description, '') = IFNULL(?, '')
      AND IFNULL(posted_date, '') = IFNULL(?, '')
      AND amount = ?
  `);
  const insertStmt = sqlite.prepare(`
    INSERT INTO amazon_settlement_rows (
      id, settlement_id, posted_date, transaction_type, amount_type, amount_description,
      amount, currency, sku, order_id, quantity_purchased, marketplace_name,
      settlement_start_date, settlement_end_date, deposit_date, total_amount,
      raw_json, ingested_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  interface Identity {
    settlementId: string;
    orderId: string | null;
    sku: string | null;
    amountType: string | null;
    amountDescription: string | null;
    postedDate: string | null;
    amount: number;
  }

  /** Groups rows that are indistinguishable to the dedup key. */
  const groups = new Map<string, { identity: Identity; rows: WindsorRow[] }>();

  for (const row of rows) {
    const settlementId = str(row.settlement_id);
    if (!settlementId) {
      result.rejected.push({ reason: "missing settlement_id", row });
      continue;
    }
    const identity: Identity = {
      settlementId,
      orderId: str(row.order_id),
      sku: str(row.sku),
      amountType: str(row.amount_type),
      amountDescription: str(row.amount_description),
      postedDate: str(row.posted_date),
      amount: round2(num(row.amount)),
    };
    const key = JSON.stringify(identity);
    const group = groups.get(key);
    if (group) group.rows.push(row);
    else groups.set(key, { identity, rows: [row] });
  }

  const run = sqlite.transaction(() => {
    for (const { identity, rows: groupRows } of groups.values()) {
      const held = (countStmt.get(
        identity.settlementId,
        identity.orderId,
        identity.sku,
        identity.amountType,
        identity.amountDescription,
        identity.postedDate,
        identity.amount,
      ) as { n: number }).n;

      // Store whichever is larger: what we already hold, or what this batch
      // says exists. Never delete, never double-count.
      const toInsert = Math.max(0, groupRows.length - held);
      result.skipped += groupRows.length - toInsert;

      for (let i = 0; i < toInsert; i++) {
        const row = groupRows[i];
        insertStmt.run(
          crypto.randomUUID(),
          identity.settlementId,
          identity.postedDate,
          str(row.transaction_type),
          identity.amountType,
          identity.amountDescription,
          identity.amount,
          // Windsor frequently returns an empty currency on settlement rows;
          // the account is US-only, so USD is the correct default rather than
          // a null that would break money formatting downstream.
          str(row.currency) ?? "USD",
          identity.sku,
          identity.orderId,
          row.quantity_purchased === null || row.quantity_purchased === undefined || row.quantity_purchased === ""
            ? null
            : Math.trunc(num(row.quantity_purchased)),
          str(row.marketplace_name),
          str(row.settlement_start_date),
          str(row.settlement_end_date),
          str(row.deposit_date),
          row.total_amount === null || row.total_amount === undefined || row.total_amount === ""
            ? null
            : round2(num(row.total_amount)),
          JSON.stringify(row),
        );
        result.inserted++;
      }
    }
  });
  run();

  return result;
}

/** Land daily sales + traffic metrics. Upsert by date (Amazon restates). */
export function ingestSalesTraffic(rows: WindsorRow[]): IngestResult {
  const result = emptyResult();
  result.received = rows.length;

  const selectStmt = sqlite.prepare("SELECT id FROM amazon_sales_traffic_daily WHERE date = ?");
  const insertStmt = sqlite.prepare(`
    INSERT INTO amazon_sales_traffic_daily (
      id, date, gross_sales, units_ordered, units_shipped, total_order_items,
      refund_rate, sessions, page_views, buy_box_pct, conversion_rate,
      avg_selling_price, ingested_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `);
  const updateStmt = sqlite.prepare(`
    UPDATE amazon_sales_traffic_daily SET
      gross_sales = ?, units_ordered = ?, units_shipped = ?, total_order_items = ?,
      refund_rate = ?, sessions = ?, page_views = ?, buy_box_pct = ?,
      conversion_rate = ?, avg_selling_price = ?, updated_at = datetime('now')
    WHERE id = ?
  `);

  const run = sqlite.transaction((batch: WindsorRow[]) => {
    for (const row of batch) {
      const date = str(row.date);
      if (!date) {
        result.rejected.push({ reason: "missing date", row });
        continue;
      }
      const values = [
        round2(num(row.salesbydate_orderedproductsales_amount)),
        Math.trunc(num(row.salesbydate_unitsordered)),
        Math.trunc(num(row.salesbydate_unitsshipped)),
        Math.trunc(num(row.salesbydate_totalorderitems)),
        num(row.salesbydate_refundrate),
        Math.trunc(num(row.trafficbydate_sessions)),
        Math.trunc(num(row.trafficbydate_pageviews)),
        num(row.trafficbydate_buyboxpercentage),
        num(row.trafficbydate_unitsessionpercentage),
        round2(num(row.salesbydate_averagesellingprice_amount)),
      ];
      const existing = selectStmt.get(date) as { id: string } | undefined;
      if (existing) {
        updateStmt.run(...values, existing.id);
        result.updated++;
      } else {
        insertStmt.run(crypto.randomUUID(), date, ...values);
        result.inserted++;
      }
    }
  });
  run(rows);

  return result;
}

/**
 * Land an FBA inventory snapshot.
 *
 * The upstream report is a live snapshot with no date column, so the caller
 * supplies the snapshot date. Upserting on (date, sku) makes a same-day
 * re-run refresh rather than duplicate.
 */
export function ingestFbaInventory(rows: WindsorRow[], snapshotDate: string): IngestResult {
  const result = emptyResult();
  result.received = rows.length;

  const selectStmt = sqlite.prepare(
    "SELECT id FROM amazon_fba_inventory WHERE snapshot_date = ? AND sku = ?",
  );
  const insertStmt = sqlite.prepare(`
    INSERT INTO amazon_fba_inventory (
      id, snapshot_date, sku, internal_sku, asin, fulfillable_qty,
      inbound_working_qty, inbound_shipped_qty, inbound_receiving_qty,
      reserved_qty, unsellable_qty, total_qty, ingested_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const updateStmt = sqlite.prepare(`
    UPDATE amazon_fba_inventory SET
      internal_sku = ?, asin = ?, fulfillable_qty = ?, inbound_working_qty = ?,
      inbound_shipped_qty = ?, inbound_receiving_qty = ?, reserved_qty = ?,
      unsellable_qty = ?, total_qty = ?, ingested_at = datetime('now')
    WHERE id = ?
  `);

  const run = sqlite.transaction((batch: WindsorRow[]) => {
    for (const row of batch) {
      const sku = str(row.sku);
      if (!sku) {
        result.rejected.push({ reason: "missing sku", row });
        continue;
      }
      const values = [
        toInternalSku(sku),
        str(row.asin),
        Math.trunc(num(row.afn_fulfillable_quantity)),
        Math.trunc(num(row.afn_inbound_working_quantity)),
        Math.trunc(num(row.afn_inbound_shipped_quantity)),
        Math.trunc(num(row.afn_inbound_receiving_quantity)),
        Math.trunc(num(row.afn_reserved_quantity)),
        Math.trunc(num(row.afn_unsellable_quantity)),
        Math.trunc(num(row.afn_total_quantity)),
      ];
      const existing = selectStmt.get(snapshotDate, sku) as { id: string } | undefined;
      if (existing) {
        updateStmt.run(...values, existing.id);
        result.updated++;
      } else {
        insertStmt.run(crypto.randomUUID(), snapshotDate, sku, ...values);
        result.inserted++;
      }
    }
  });
  run(rows);

  return result;
}

// ── Sync state ────────────────────────────────────────────────────────────

export interface SyncStateRow {
  reportName: string;
  lastSyncedThrough: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  rowsIngested: number;
}

/** Mark a report as running, so a stuck sync is visible while it's stuck. */
export function markSyncRunning(reportName: ReportKey | string): void {
  sqlite.prepare(`
    INSERT INTO amazon_sync_state (report_name, last_run_at, last_status, updated_at)
    VALUES (?, datetime('now'), 'running', datetime('now'))
    ON CONFLICT(report_name) DO UPDATE SET
      last_run_at = datetime('now'), last_status = 'running', updated_at = datetime('now')
  `).run(reportName);
}

/**
 * Record a successful sync. Clears the failure counter, which is what stops
 * a report that recovered from continuing to alert.
 */
export function markSyncSuccess(
  reportName: ReportKey | string,
  opts: { syncedThrough?: string | null; rowsIngested?: number } = {},
): void {
  sqlite.prepare(`
    INSERT INTO amazon_sync_state (
      report_name, last_synced_through, last_run_at, last_success_at,
      last_status, last_error, consecutive_failures, rows_ingested, updated_at
    ) VALUES (?, ?, datetime('now'), datetime('now'), 'ok', NULL, 0, ?, datetime('now'))
    ON CONFLICT(report_name) DO UPDATE SET
      last_synced_through = COALESCE(excluded.last_synced_through, amazon_sync_state.last_synced_through),
      last_run_at = datetime('now'),
      last_success_at = datetime('now'),
      last_status = 'ok',
      last_error = NULL,
      consecutive_failures = 0,
      rows_ingested = excluded.rows_ingested,
      updated_at = datetime('now')
  `).run(reportName, opts.syncedThrough ?? null, opts.rowsIngested ?? 0);
}

/**
 * Record a failure and return the new consecutive-failure count, so the
 * caller can decide whether this is worth waking someone for. Windsor's
 * Amazon reports are flaky enough that a single timeout is noise; three in a
 * row is a problem.
 */
export function markSyncFailure(reportName: ReportKey | string, error: string): number {
  sqlite.prepare(`
    INSERT INTO amazon_sync_state (
      report_name, last_run_at, last_status, last_error, consecutive_failures, updated_at
    ) VALUES (?, datetime('now'), 'failed', ?, 1, datetime('now'))
    ON CONFLICT(report_name) DO UPDATE SET
      last_run_at = datetime('now'),
      last_status = 'failed',
      last_error = excluded.last_error,
      consecutive_failures = amazon_sync_state.consecutive_failures + 1,
      updated_at = datetime('now')
  `).run(reportName, error.slice(0, 2000));

  const row = sqlite
    .prepare("SELECT consecutive_failures AS n FROM amazon_sync_state WHERE report_name = ?")
    .get(reportName) as { n: number } | undefined;
  return row?.n ?? 1;
}

export function getSyncState(reportName?: string): SyncStateRow[] {
  const sql = `
    SELECT report_name AS reportName, last_synced_through AS lastSyncedThrough,
           last_run_at AS lastRunAt, last_success_at AS lastSuccessAt,
           last_status AS lastStatus, last_error AS lastError,
           consecutive_failures AS consecutiveFailures, rows_ingested AS rowsIngested
    FROM amazon_sync_state
    ${reportName ? "WHERE report_name = ?" : ""}
    ORDER BY report_name
  `;
  const stmt = sqlite.prepare(sql);
  return (reportName ? stmt.all(reportName) : stmt.all()) as SyncStateRow[];
}

/**
 * Per-ASIN daily sales & traffic.
 *
 * UPSERT on (date, child_asin): Amazon restates recent days as orders settle
 * and sessions are deduplicated, so the last version of a day wins.
 *
 * Rows with no child ASIN are rejected rather than dropped silently. Amazon
 * emits a parent-only summary row alongside the child rows; storing it would
 * double-count every metric against its own children.
 */
export function ingestAsinTraffic(rows: WindsorRow[]): IngestResult {
  const result = emptyResult();
  result.received = rows.length;

  const upsert = sqlite.prepare(`
    INSERT INTO amazon_asin_traffic_daily (
      id, date, child_asin, parent_asin, units_ordered, units_shipped,
      total_order_items, ordered_product_sales, avg_selling_price, refund_rate,
      sessions, page_views, buy_box_pct, conversion_rate, session_pct,
      ingested_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(date, child_asin) DO UPDATE SET
      parent_asin = excluded.parent_asin,
      units_ordered = excluded.units_ordered,
      units_shipped = excluded.units_shipped,
      total_order_items = excluded.total_order_items,
      ordered_product_sales = excluded.ordered_product_sales,
      avg_selling_price = excluded.avg_selling_price,
      refund_rate = excluded.refund_rate,
      sessions = excluded.sessions,
      page_views = excluded.page_views,
      buy_box_pct = excluded.buy_box_pct,
      conversion_rate = excluded.conversion_rate,
      session_pct = excluded.session_pct,
      updated_at = datetime('now')
  `);

  const existing = sqlite.prepare(
    "SELECT 1 AS hit FROM amazon_asin_traffic_daily WHERE date = ? AND child_asin = ?",
  );

  const run = sqlite.transaction((batch: WindsorRow[]) => {
    for (const row of batch) {
      const date = str(row.date);
      const childAsin = str(row.childasin);
      if (!date) { result.rejected.push({ reason: "missing date", row }); continue; }
      if (!childAsin) { result.rejected.push({ reason: "missing childAsin", row }); continue; }

      const had = existing.get(date, childAsin) as { hit: number } | undefined;
      upsert.run(
        crypto.randomUUID(), date, childAsin, str(row.parentasin),
        Math.trunc(num(row.salesbyasin_unitsordered)),
        Math.trunc(num(row.salesbyasin_unitsshipped)),
        Math.trunc(num(row.salesbyasin_totalorderitems)),
        round2(num(row.salesbyasin_orderedproductsales_amount)),
        round2(num(row.salesbyasin_averagesellingprice_amount)),
        num(row.salesbyasin_refundrate),
        Math.trunc(num(row.trafficbyasin_sessions)),
        Math.trunc(num(row.trafficbyasin_pageviews)),
        num(row.trafficbyasin_buyboxpercentage),
        num(row.trafficbyasin_unitsessionpercentage),
        num(row.trafficbyasin_sessionpercentage),
      );
      if (had) result.updated++; else result.inserted++;
    }
  });

  run(rows);
  return result;
}

/**
 * Listing metadata — titles and the ASIN↔SKU bridge.
 *
 * Keyed on seller SKU, which is the only stable identifier: a listing can be
 * relisted under a new ASIN, and one ASIN can carry several SKUs (ours and
 * the -FBA variant). `internal_sku` is resolved at ingest so downstream joins
 * never have to know about the suffix.
 *
 * This is a full snapshot of current listings, so it REPLACES rather than
 * accumulates — but only for SKUs present in the pull. A listing Amazon stops
 * returning keeps its last known title, because a report that suddenly shows
 * SKU codes where names used to be reads as a bug in the report.
 */
export function ingestListings(rows: WindsorRow[]): IngestResult {
  const result = emptyResult();
  result.received = rows.length;

  const upsert = sqlite.prepare(`
    INSERT INTO amazon_listings (
      sku, internal_sku, asin, title, price, quantity, status,
      fulfillment_channel, opened_at, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(sku) DO UPDATE SET
      internal_sku = excluded.internal_sku,
      asin = excluded.asin,
      title = excluded.title,
      price = excluded.price,
      quantity = excluded.quantity,
      status = excluded.status,
      fulfillment_channel = excluded.fulfillment_channel,
      opened_at = excluded.opened_at,
      synced_at = datetime('now')
  `);
  const existing = sqlite.prepare("SELECT 1 AS hit FROM amazon_listings WHERE sku = ?");

  const run = sqlite.transaction((batch: WindsorRow[]) => {
    for (const row of batch) {
      const sku = str(row.seller_sku);
      if (!sku) { result.rejected.push({ reason: "missing seller-sku", row }); continue; }

      const had = existing.get(sku) as { hit: number } | undefined;
      upsert.run(
        sku, toInternalSku(sku), str(row.asin1), str(row.item_name),
        round2(num(row.price)), Math.trunc(num(row.quantity)),
        str(row.status), str(row["fulfillment_channel"]), str(row.open_date),
      );
      if (had) result.updated++; else result.inserted++;
    }
  });

  run(rows);
  return result;
}

/**
 * Best available display name for an internal SKU.
 *
 * Prefers the catalog's own product name (ours, curated) and falls back to
 * Amazon's listing title (theirs, keyword-stuffed but always present). A
 * report row with no name at all is the one outcome worth avoiding.
 */
export function skuDisplayNames(): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of sqlite.prepare(`
    SELECT l.internal_sku AS sku, l.title AS title FROM amazon_listings l
    WHERE l.internal_sku IS NOT NULL AND l.title IS NOT NULL
  `).all() as Array<{ sku: string; title: string }>) {
    out.set(r.sku, r.title);
  }
  for (const r of sqlite.prepare(`
    SELECT cs.sku AS sku,
           TRIM(COALESCE(cp.name, '') || CASE WHEN cs.color_name IS NOT NULL
                THEN ' · ' || cs.color_name ELSE '' END) AS name
    FROM catalog_skus cs LEFT JOIN catalog_products cp ON cp.id = cs.product_id
    WHERE cs.sku IS NOT NULL AND cp.name IS NOT NULL
  `).all() as Array<{ sku: string; name: string }>) {
    if (r.name) out.set(r.sku, r.name);
  }
  return out;
}

/**
 * Amazon's restock recommendations, snapshotted daily.
 *
 * Snapshotted rather than overwritten because the recommendation is a moving
 * target: "Amazon wanted 220 units three weeks ago and we sent 45" is the
 * only way to tell later whether a stockout was a planning miss or a
 * deliberate call. A single current-state row cannot answer that.
 */
export function ingestRestockRecommendations(
  rows: WindsorRow[],
  snapshotDate: string,
): IngestResult {
  const result = emptyResult();
  result.received = rows.length;

  const upsert = sqlite.prepare(`
    INSERT INTO amazon_restock_recommendations (
      id, snapshot_date, sku, internal_sku, asin, fnsku, product_name,
      alert, recommended_action, recommended_qty, recommended_ship_date,
      units_sold_30d, days_of_supply, total_days_of_supply,
      available, inbound, working, receiving, unfulfillable, total_units,
      price, ingested_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(snapshot_date, sku) DO UPDATE SET
      internal_sku = excluded.internal_sku, asin = excluded.asin,
      fnsku = excluded.fnsku, product_name = excluded.product_name,
      alert = excluded.alert, recommended_action = excluded.recommended_action,
      recommended_qty = excluded.recommended_qty,
      recommended_ship_date = excluded.recommended_ship_date,
      units_sold_30d = excluded.units_sold_30d,
      days_of_supply = excluded.days_of_supply,
      total_days_of_supply = excluded.total_days_of_supply,
      available = excluded.available, inbound = excluded.inbound,
      working = excluded.working, receiving = excluded.receiving,
      unfulfillable = excluded.unfulfillable, total_units = excluded.total_units,
      price = excluded.price, ingested_at = datetime('now')
  `);
  const existing = sqlite.prepare(
    "SELECT 1 AS hit FROM amazon_restock_recommendations WHERE snapshot_date = ? AND sku = ?",
  );

  // Amazon writes "none" and "" into date and numeric columns rather than
  // leaving them empty, so a plain cast would silently produce 0 or an
  // invalid date string.
  const optDate = (v: unknown): string | null => {
    const s = str(v);
    return !s || s.toLowerCase() === "none" ? null : s;
  };
  const optNum = (v: unknown): number | null => {
    const s = str(v);
    return s === null ? null : num(s);
  };

  const run = sqlite.transaction((batch: WindsorRow[]) => {
    for (const row of batch) {
      const sku = str(row.merchant_sku);
      if (!sku) { result.rejected.push({ reason: "missing merchant_sku", row }); continue; }

      const had = existing.get(snapshotDate, sku) as { hit: number } | undefined;
      upsert.run(
        crypto.randomUUID(), snapshotDate, sku, toInternalSku(sku),
        str(row.asin), str(row.fnsku), str(row.product_name),
        str(row.alert), str(row.recommended_action),
        Math.trunc(num(row.recommended_replenishment_qty)),
        optDate(row.recommended_ship_date),
        Math.trunc(num(row.units_sold_last_30_days)),
        optNum(row.days_of_supply_at_amazon_fulfillment_network),
        optNum(row["total_days_of_supply_(including_units_from_open_shipments)"]),
        Math.trunc(num(row.available)), Math.trunc(num(row.inbound)),
        Math.trunc(num(row.working)), Math.trunc(num(row.receiving)),
        Math.trunc(num(row.unfulfillable)), Math.trunc(num(row.total_units)),
        optNum(row.price),
      );
      if (had) result.updated++; else result.inserted++;
    }
  });

  run(rows);
  return result;
}
