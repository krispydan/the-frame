export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { requireOpsToken } from "@/lib/ops-auth";
import { buildDriftReport, buildCoverageReport } from "@/modules/finance/lib/inventory-drift";
import { depleteUncostedOrders, getCostLayerSummary } from "@/modules/finance/lib/fifo-engine";
import { runDailyCogsPosting } from "@/modules/finance/lib/daily-cogs";
import { runShipmentRevenueRecognition } from "@/modules/finance/lib/shipment-revenue-recognition";
import { proposeSkuAliases, applySkuAliases } from "@/modules/inventory/lib/sku-alias-proposals";
import { syncShipHeroInventory } from "@/modules/operations/lib/shiphero/sync-inventory";

/**
 * Token-guarded COGS / FIFO operations.
 *
 * The Amazon month-end check can tell you COGS coverage is short or that FIFO
 * has drifted from physical stock, but the libraries that diagnose and fix
 * either one sit behind `/api/v1/*` and the login middleware — unreachable
 * from tooling. This is the same libraries behind the `x-ops-key` door, so a
 * blocked close can actually be worked rather than just reported.
 *
 * GET is read-only. POST mutates and needs `?confirm=1`.
 *
 * `deplete-uncosted` writes FIFO depletions, which move real money into COGS.
 * Like the Xero poster it defaults to a dry run: omitting `dryRun` must never
 * write, because the safe outcome has to be what happens when a parameter is
 * forgotten.
 *
 *   GET  /api/admin/ops/cogs?view=drift            per-SKU FIFO vs physical + verdict
 *   GET  /api/admin/ops/cogs?view=coverage         shipped units carrying no cost
 *   GET  /api/admin/ops/cogs?view=layers           cost layers by SKU
 *   POST /api/admin/ops/cogs?confirm=1 { "action": "deplete-uncosted", "dryRun": false, "since": "2026-01-01" }
 *   POST /api/admin/ops/cogs?confirm=1 { "action": "run-daily-cogs" }
 *   POST /api/admin/ops/cogs?confirm=1 { "action": "recognise-revenue" }
 */
export async function GET(req: NextRequest) {
  const denied = requireOpsToken(req);
  if (denied) return denied;

  const view = req.nextUrl.searchParams.get("view") ?? "drift";
  const since = req.nextUrl.searchParams.get("since") ?? undefined;
  const limitParam = Number(req.nextUrl.searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined;

  try {
    switch (view) {
      case "drift":
        return NextResponse.json({ ok: true, view, drift: buildDriftReport({ limit }) });
      case "coverage":
        return NextResponse.json({ ok: true, view, coverage: buildCoverageReport({ since }) });
      case "layers":
        return NextResponse.json({ ok: true, view, layers: getCostLayerSummary() });
      case "sku-mapping":
        return NextResponse.json({ ok: true, view, mapping: proposeSkuAliases() });
      default:
        return NextResponse.json(
          {
            ok: false, error: `Unknown view "${view}".`,
            views: ["drift", "coverage", "layers", "sku-mapping"],
          },
          { status: 400 },
        );
    }
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  const denied = requireOpsToken(req, { mutation: true });
  if (denied) return denied;

  try {
    const body = await req.json().catch(() => ({}));
    const { action } = body as { action?: string };

    switch (action) {
      case "deplete-uncosted": {
        const { since, dryRun } = body as { since?: string; dryRun?: boolean };
        if (since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
          return NextResponse.json({ ok: false, error: "`since` must be YYYY-MM-DD" }, { status: 400 });
        }
        // Explicit opt-out only. Omitting dryRun must never write depletions.
        const isDryRun = dryRun !== false;
        const result = depleteUncostedOrders({ since, dryRun: isDryRun });
        return NextResponse.json({
          ok: true, action, dryRun: isDryRun, result,
          note: isDryRun
            ? "Dry run — counted the uncosted lines, wrote nothing. Re-send with \"dryRun\": false to cost them."
            : undefined,
        });
      }

      case "run-daily-cogs": {
        const result = await runDailyCogsPosting();
        return NextResponse.json({ ok: true, action, result });
      }

      case "recognise-revenue": {
        const result = await runShipmentRevenueRecognition();
        return NextResponse.json({ ok: true, action, result });
      }

      case "apply-sku-aliases": {
        const { dryRun } = body as { dryRun?: boolean };
        // Same default as everything else that writes: omitting the flag
        // must not mutate. Only unambiguous proposals are ever written.
        const isDryRun = dryRun !== false;
        const result = applySkuAliases({ dryRun: isDryRun });
        return NextResponse.json({
          ok: true, action, dryRun: isDryRun, result,
          note: isDryRun
            ? "Dry run — no aliases written. Re-send with \"dryRun\": false to apply."
            : "Run sync-shiphero-inventory next so the new mappings take effect.",
        });
      }

      case "sync-shiphero-inventory": {
        const result = await syncShipHeroInventory();
        return NextResponse.json({ ok: true, action, result });
      }

      default:
        return NextResponse.json({
          ok: false,
          error: `Unknown action "${action ?? ""}".`,
          actions: [
            "deplete-uncosted", "run-daily-cogs", "recognise-revenue",
            "apply-sku-aliases", "sync-shiphero-inventory",
          ],
        }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
