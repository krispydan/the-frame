export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { requireOpsToken } from "@/lib/ops-auth";
import { sqlite } from "@/lib/db";
import { PLATFORM_CATEGORY_SUGGESTIONS, SHARED_PLATFORM_KEY } from "@/modules/integrations/schema/xero";
import {
  syncAndImportAmazonOrders,
  syncAndBridgeAmazonSettlements,
  syncAmazonSalesTraffic,
  syncAmazonFbaInventory,
  backfillAmazon,
} from "@/modules/integrations/lib/amazon/sync";
import { importAmazonOrders, backfillAmazonLineDiscounts } from "@/modules/orders/lib/amazon-sync";
import { bridgeAmazonSettlements } from "@/modules/integrations/lib/amazon/settlement-bridge";
import {
  getAmazonHeadline,
  getAmazonSyncHealth,
  getAmazonUnmappedSkus,
  getAmazonSettlements,
  getAmazonPromoBreakdown,
} from "@/modules/integrations/lib/amazon/metrics";
import { buildAmazonMonthEnd } from "@/modules/integrations/lib/amazon/month-end";
import { fetchWindsorCatalog, CANDIDATE_CONNECTORS } from "@/modules/integrations/lib/windsor/catalog";
import {
  syncAmazonSettlementsToXero,
  loadAmazonXeroConfig,
} from "@/modules/integrations/lib/amazon/payout-sync";

/**
 * Token-guarded Amazon operations.
 *
 * The Amazon UI and API live under `/api/v1/*`, which sits behind the login
 * middleware and therefore needs a browser session. That makes it unusable
 * from tooling — you cannot drive a backfill or check a sync from a script.
 * This route exposes the same libraries through the `/api/admin/ops/*` front
 * door, which gates on `x-ops-key` instead. Same implementation, two front
 * doors, matching the pattern in docs/ops-endpoints.md.
 *
 * GET is always read-only. POST mutates and additionally requires `?confirm=1`,
 * so a write is never accidental.
 *
 * Posting settlements to Xero is deliberately harder to trigger than
 * everything else here: it needs `confirm=1` AND an explicit `dryRun: false`.
 * A journal is not easily unpicked — the correction path is a reversing
 * journal, not a delete — so the safe outcome has to be what happens when a
 * parameter is forgotten.
 */

/**
 * GET /api/admin/ops/amazon?view=status|health|month-end|xero|settlements
 *
 * Read-only diagnostics. Defaults to a broad status summary.
 */
export async function GET(req: NextRequest) {
  const denied = requireOpsToken(req);
  if (denied) return denied;

  const view = req.nextUrl.searchParams.get("view") ?? "status";

  try {
    switch (view) {
      case "health":
        return NextResponse.json({ ok: true, reports: getAmazonSyncHealth() });

      case "month-end": {
        const month = req.nextUrl.searchParams.get("month")
          ?? new Date().toISOString().slice(0, 7);
        if (!/^\d{4}-\d{2}$/.test(month)) {
          return NextResponse.json({ ok: false, error: "month must be YYYY-MM" }, { status: 400 });
        }
        return NextResponse.json({ ok: true, monthEnd: buildAmazonMonthEnd(month) });
      }

      case "xero": {
        // Answers "which mapping is missing" without attempting a post — the
        // question asked most often before the first run.
        try {
          const config = await loadAmazonXeroConfig();
          return NextResponse.json({
            ok: true, ready: true, accounts: config,
            trackingConfigured: Boolean(config.tracking?.length),
            note: config.tracking?.length ? undefined
              : "No Xero tracking option mapped for Amazon — journals will post without a Sales Channel tag.",
          });
        } catch (e) {
          return NextResponse.json({ ok: true, ready: false, error: (e as Error).message });
        }
      }

      case "settlements":
        return NextResponse.json({ ok: true, settlements: getAmazonSettlements(50) });

      case "catalog": {
        // Scopes the next connector from what the account can actually serve.
        // `connector=all` sweeps the candidate slugs, since Windsor names them
        // inconsistently and trying each is the only reliable way to find one.
        const which = req.nextUrl.searchParams.get("connector") ?? "amazon_sp";
        // `report=` drills into one report and returns EVERY field. Scoping a
        // new report needs the full list — a 12-field sample is enough to see
        // that a report exists, never enough to decide what it can answer.
        const only = req.nextUrl.searchParams.get("report");
        const targets = which === "all" ? [...CANDIDATE_CONNECTORS] : [which];
        const results = await Promise.all(targets.map((c) => fetchWindsorCatalog(c, { allFields: Boolean(only) })));
        return NextResponse.json({
          ok: true,
          catalog: results.map((r) => ({
            connector: r.connector, ok: r.ok,
            reportCount: r.reportCount, fieldCount: r.fieldCount,
            error: r.error,
            reports: which === "all"
              ? r.reports.map((x) => x.report)
              : only ? r.reports.filter((x) => x.report === only) : r.reports,
          })),
        });
      }

      case "promotions": {
        // Defaults to all of history — the question this answers ("how much
        // of our volume is actually giveaway?") is a trend, not a snapshot.
        const from = req.nextUrl.searchParams.get("from") ?? "2000-01-01";
        const to = req.nextUrl.searchParams.get("to") ?? "2100-01-01";
        return NextResponse.json({ ok: true, promotions: getAmazonPromoBreakdown({ from, to }) });
      }

      default: {
        const archive = sqlite.prepare(`
          SELECT
            (SELECT COUNT(*) FROM amazon_order_rows) AS orderRows,
            (SELECT COUNT(DISTINCT amazon_order_id) FROM amazon_order_rows) AS distinctOrders,
            (SELECT MAX(purchase_date) FROM amazon_order_rows) AS latestPurchase,
            (SELECT COUNT(*) FROM amazon_settlement_rows) AS settlementRows,
            (SELECT COUNT(DISTINCT settlement_id) FROM amazon_settlement_rows) AS distinctSettlements,
            (SELECT COUNT(*) FROM amazon_sales_traffic_daily) AS trafficDays,
            (SELECT COUNT(*) FROM amazon_fba_inventory) AS fbaSnapshotRows
        `).get();

        const imported = sqlite.prepare(`
          SELECT COUNT(*) AS orders,
                 SUM(CASE WHEN status = 'shipped' THEN 1 ELSE 0 END) AS shipped,
                 SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
                 SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
                 MAX(placed_at) AS latestPlaced
          FROM orders WHERE channel = 'amazon'
        `).get();

        const today = new Date().toISOString().slice(0, 10);
        const from = new Date(Date.now() - 89 * 86_400_000).toISOString().slice(0, 10);

        return NextResponse.json({
          ok: true,
          configured: { windsorApiKey: Boolean(process.env.WINDSOR_API_KEY) },
          archive,
          imported,
          headline: getAmazonHeadline({ from, to: today }),
          unmappedSkus: getAmazonUnmappedSkus(),
          // Same source as ?view=health, so `stale` is reported consistently
          // rather than only on one view.
          reports: getAmazonSyncHealth(),
        });
      }
    }
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

/**
 * POST /api/admin/ops/amazon?confirm=1
 *
 * Body: { action, ...options }
 *
 *   { "action": "backfill", "from": "2026-06-01" }        full historical pull
 *   { "action": "sync-orders" }                            daily orders + import
 *   { "action": "sync-settlements" }                       settlements + bridge
 *   { "action": "sync-traffic" }                           sales & traffic
 *   { "action": "sync-inventory" }                         FBA snapshot
 *   { "action": "import-only" }                            re-normalise the archive
 *   { "action": "bridge-only" }                            re-derive settlements
 *   { "action": "post-xero", "dryRun": true }              build journals, post nothing
 *   { "action": "post-xero", "dryRun": false, "status": "DRAFT", "limit": 1 }
 *
 * `import-only` and `bridge-only` re-derive from the local archive without
 * touching Windsor — the fast path after fixing a SKU alias or a fee mapping,
 * and the reason the raw archive exists.
 */
export async function POST(req: NextRequest) {
  const denied = requireOpsToken(req, { mutation: true });
  if (denied) return denied;

  try {
    const body = await req.json().catch(() => ({}));
    const { action } = body as { action?: string };

    const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

    switch (action) {
      case "backfill": {
        const { from, to } = body as { from?: string; to?: string };
        if (!isDate(from)) {
          return NextResponse.json({ ok: false, error: "`from` must be YYYY-MM-DD" }, { status: 400 });
        }
        if (to !== undefined && !isDate(to)) {
          return NextResponse.json({ ok: false, error: "`to` must be YYYY-MM-DD" }, { status: 400 });
        }
        const result = await backfillAmazon({ from, to });
        // Normalise straight after: a backfill that lands raw rows without
        // importing them looks successful while leaving the P&L unchanged.
        const imported = importAmazonOrders({ since: from, until: to });
        const bridged = bridgeAmazonSettlements({});
        return NextResponse.json({ ok: true, action, result, imported, bridged });
      }

      // These accept an optional date range so a long history can be pulled
      // one report at a time. The `backfill` action runs every report in a
      // single request, which exceeds Railway's 300s edge timeout once the
      // range is wide — the slowest report alone takes ~36s per 7-day chunk.
      case "sync-orders": {
        const { from, to } = body as { from?: string; to?: string };
        if ((from !== undefined && !isDate(from)) || (to !== undefined && !isDate(to))) {
          return NextResponse.json({ ok: false, error: "`from`/`to` must be YYYY-MM-DD" }, { status: 400 });
        }
        return NextResponse.json({
          ok: true, action,
          result: await syncAndImportAmazonOrders({ dateFrom: from, dateTo: to }),
        });
      }

      case "sync-settlements": {
        const { from, to } = body as { from?: string; to?: string };
        if ((from !== undefined && !isDate(from)) || (to !== undefined && !isDate(to))) {
          return NextResponse.json({ ok: false, error: "`from`/`to` must be YYYY-MM-DD" }, { status: 400 });
        }
        return NextResponse.json({
          ok: true, action,
          result: await syncAndBridgeAmazonSettlements({ dateFrom: from, dateTo: to }),
        });
      }

      case "sync-traffic": {
        const { from, to } = body as { from?: string; to?: string };
        if ((from !== undefined && !isDate(from)) || (to !== undefined && !isDate(to))) {
          return NextResponse.json({ ok: false, error: "`from`/`to` must be YYYY-MM-DD" }, { status: 400 });
        }
        return NextResponse.json({
          ok: true, action,
          result: await syncAmazonSalesTraffic({ dateFrom: from, dateTo: to }),
        });
      }

      case "sync-inventory":
        return NextResponse.json({ ok: true, action, result: await syncAmazonFbaInventory({}) });

      case "import-only": {
        const { from, to } = body as { from?: string; to?: string };
        return NextResponse.json({
          ok: true, action,
          result: importAmazonOrders({ since: from, until: to }),
        });
      }

      case "bridge-only":
        return NextResponse.json({ ok: true, action, result: bridgeAmazonSettlements({}) });

      /**
       * Seed the Amazon Xero account mappings from the suggested defaults.
       *
       * The same thing the "Apply suggested defaults" button does in
       * Settings → Integrations → Xero, exposed here because that page needs
       * a browser session. Existing rows are left alone unless `overwrite` is
       * set — a mapping someone deliberately changed should not be silently
       * reverted by an ops call.
       *
       * Also seeds the two `_shared` accrual accounts the deferred revenue
       * model requires, which are not in the per-platform suggestion catalog.
       */
      case "apply-xero-defaults": {
        const { overwrite } = body as { overwrite?: boolean };
        const suggestions = PLATFORM_CATEGORY_SUGGESTIONS.amazon ?? [];

        const shared: Array<{ category: string; code: string; name: string }> = [
          { category: "deferred_revenue", code: "2050", name: "Deferred Revenue" },
          { category: "receivables_holding", code: "1100", name: "Receivables Holding" },
        ];

        const existing = sqlite.prepare(
          "SELECT source_platform AS p, category AS c FROM xero_account_mappings WHERE source_platform IN ('amazon', ?)",
        ).all(SHARED_PLATFORM_KEY) as Array<{ p: string; c: string }>;
        const have = new Set(existing.map((r) => `${r.p}|${r.c}`));

        const insert = sqlite.prepare(`
          INSERT INTO xero_account_mappings (id, source_platform, category, xero_account_code, xero_account_name, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        `);
        const update = sqlite.prepare(`
          UPDATE xero_account_mappings SET xero_account_code = ?, xero_account_name = ?, updated_at = datetime('now')
          WHERE source_platform = ? AND category = ?
        `);

        const created: string[] = [];
        const updated: string[] = [];
        const skipped: string[] = [];

        const run = sqlite.transaction(() => {
          for (const s of suggestions) {
            if (!s.defaultAccountCode) continue;
            const key = `amazon|${s.category}`;
            if (have.has(key)) {
              if (overwrite) {
                update.run(s.defaultAccountCode, s.defaultAccountName ?? null, "amazon", s.category);
                updated.push(s.category);
              } else skipped.push(s.category);
              continue;
            }
            insert.run(crypto.randomUUID(), "amazon", s.category, s.defaultAccountCode, s.defaultAccountName ?? null);
            created.push(s.category);
          }
          for (const sh of shared) {
            const key = `${SHARED_PLATFORM_KEY}|${sh.category}`;
            if (have.has(key)) { skipped.push(`_shared:${sh.category}`); continue; }
            insert.run(crypto.randomUUID(), SHARED_PLATFORM_KEY, sh.category, sh.code, sh.name);
            created.push(`_shared:${sh.category}`);
          }
        });
        run();

        // Report readiness straight back, so one call answers "did it work".
        let ready = true; let error: string | undefined;
        try { await loadAmazonXeroConfig(); } catch (e) { ready = false; error = (e as Error).message; }

        return NextResponse.json({ ok: true, action, created, updated, skipped, ready, error });
      }

      case "backfill-line-discounts": {
        const { dryRun } = body as { dryRun?: boolean };
        // Additive only — writes order_items.discount and nothing else, so it
        // is safe on lines that already carry COGS. Still dry-run by default.
        const isDryRun = dryRun !== false;
        const result = backfillAmazonLineDiscounts({ dryRun: isDryRun });
        return NextResponse.json({ ok: true, action, dryRun: isDryRun, result });
      }

      case "post-xero": {
        const { dryRun, status, settlementIds, limit } = body as {
          dryRun?: boolean; status?: string; settlementIds?: string[]; limit?: number;
        };
        if (status !== undefined && status !== "DRAFT" && status !== "POSTED") {
          return NextResponse.json({ ok: false, error: '`status` must be "DRAFT" or "POSTED"' }, { status: 400 });
        }
        // Explicit opt-out only. Omitting dryRun must never post to Xero.
        const isDryRun = dryRun !== false;
        const result = await syncAmazonSettlementsToXero({
          dryRun: isDryRun,
          status: (status as "DRAFT" | "POSTED") ?? "POSTED",
          settlementIds, limit,
        });
        return NextResponse.json({ ok: !result.fatalError, action, dryRun: isDryRun, result });
      }

      default:
        return NextResponse.json({
          ok: false,
          error: `Unknown action "${action ?? ""}".`,
          actions: [
            "backfill", "sync-orders", "sync-settlements", "sync-traffic",
            "sync-inventory", "import-only", "bridge-only", "apply-xero-defaults", "post-xero",
          ],
        }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
