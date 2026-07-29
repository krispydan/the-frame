export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { getSessionUser } from "@/lib/get-session";

/**
 * Factory lead times — the numbers that drive every reorder recommendation.
 *
 * The forecaster's coverage window is production + transit + target stock days,
 * so these two fields decide how much to buy more than any other input. They
 * were previously only reachable by hand in SQL, which meant a stale default
 * (Brilliant sat at 32 days against an actual 75) quietly under-ordered with
 * nothing on screen to contradict it.
 *
 * GET   → every factory with lead times, MOQ, open-PO position and SKU count.
 * PATCH { code, productionLeadDays?, transitLeadDays?, airTransitLeadDays?, moq?, notes? }
 *
 * Editing is limited to the roles that own purchasing.
 */

const WRITE_ROLES = ["owner", "warehouse", "finance"];

const OPEN_PO_STATUSES = ["draft", "submitted", "confirmed", "in_production", "shipped", "in_transit"];

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const ph = OPEN_PO_STATUSES.map(() => "?").join(",");
  const rows = sqlite
    .prepare(
      `SELECT f.id, f.code, f.name, f.production_lead_days, f.transit_lead_days,
              f.air_transit_lead_days, f.moq, f.notes,
              (SELECT COUNT(*) FROM inventory_purchase_orders po
                WHERE po.factory_id = f.id AND po.status IN (${ph})) AS open_pos,
              (SELECT COALESCE(SUM(po.total_units), 0) FROM inventory_purchase_orders po
                WHERE po.factory_id = f.id AND po.status IN (${ph})) AS open_units,
              (SELECT MIN(po.expected_arrival_date) FROM inventory_purchase_orders po
                WHERE po.factory_id = f.id AND po.status IN (${ph})) AS next_arrival
         FROM inventory_factories f
        ORDER BY f.code`,
    )
    .all(...OPEN_PO_STATUSES, ...OPEN_PO_STATUSES, ...OPEN_PO_STATUSES) as Array<{
    id: string; code: string; name: string;
    production_lead_days: number; transit_lead_days: number;
    air_transit_lead_days: number | null; moq: number | null; notes: string | null;
    open_pos: number; open_units: number; next_arrival: string | null;
  }>;

  // SKU counts come from the SKU number prefix rather than a factory FK: a
  // product whose factory link is missing still belongs to JX4 by its number,
  // and the count is here to show how much a lead-time change affects.
  const skuCounts = new Map<string, number>();
  try {
    const counts = sqlite
      .prepare("SELECT UPPER(SUBSTR(sku, 1, 3)) AS prefix, COUNT(*) n FROM catalog_skus GROUP BY prefix")
      .all() as Array<{ prefix: string; n: number }>;
    for (const c of counts) skuCounts.set(c.prefix, c.n);
  } catch { /* informational only */ }

  return NextResponse.json({
    ok: true,
    canEdit: WRITE_ROLES.includes(user.role),
    factories: rows.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      productionLeadDays: r.production_lead_days,
      transitLeadDays: r.transit_lead_days,
      airTransitLeadDays: r.air_transit_lead_days,
      totalLeadDays: r.production_lead_days + r.transit_lead_days,
      totalLeadDaysAir: r.air_transit_lead_days != null ? r.production_lead_days + r.air_transit_lead_days : null,
      moq: r.moq,
      notes: r.notes,
      openPos: r.open_pos,
      openUnits: r.open_units,
      nextArrival: r.next_arrival,
      skus: skuCounts.get(r.code.toUpperCase()) ?? 0,
    })),
  });
}

export async function PATCH(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!WRITE_ROLES.includes(user.role)) {
    return NextResponse.json({ error: "not permitted for your role" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const code = String(body.code || "").trim().toUpperCase();
  const current = sqlite
    .prepare(
      `SELECT id, production_lead_days, transit_lead_days, air_transit_lead_days, moq, notes
         FROM inventory_factories WHERE UPPER(code) = ?`,
    )
    .get(code) as
    | { id: string; production_lead_days: number; transit_lead_days: number; air_transit_lead_days: number | null; moq: number | null; notes: string | null }
    | undefined;
  if (!current) return NextResponse.json({ error: `Unknown factory "${code}"` }, { status: 400 });

  // Reject nonsense rather than storing it: a zero lead time makes the
  // forecaster recommend nothing, which reads as "we're fine" instead of as
  // bad data — the exact failure mode this page exists to prevent.
  const int = (v: unknown, fallback: number | null, max = 365): number | null => {
    if (v === undefined || v === null || v === "") return fallback;
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n) || n < 1 || n > max) return fallback;
    return n;
  };

  const production = int(body.productionLeadDays, current.production_lead_days)!;
  const transit = int(body.transitLeadDays, current.transit_lead_days)!;
  const airTransit = int(body.airTransitLeadDays, current.air_transit_lead_days);
  const moq = int(body.moq, current.moq, 100000);
  const notes = typeof body.notes === "string" ? body.notes.slice(0, 500) : current.notes;

  sqlite
    .prepare(
      `UPDATE inventory_factories
          SET production_lead_days = ?, transit_lead_days = ?, air_transit_lead_days = ?,
              moq = ?, notes = ?
        WHERE id = ?`,
    )
    .run(production, transit, airTransit, moq, notes, current.id);

  return NextResponse.json({
    ok: true,
    code,
    productionLeadDays: production,
    transitLeadDays: transit,
    airTransitLeadDays: airTransit,
    totalLeadDays: production + transit,
    moq,
    notes,
  });
}
