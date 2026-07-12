export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * GET/POST /api/admin/sales/ajm-reactivation-audit
 *
 * Read-only audit of the AJ Morgan legacy base, answering: how many AJM
 * customers have NOT ordered with Jaxy yet, how many ordered within the last N
 * years, and — critically for the high/low-value split — how much value data
 * (ajm_total_spend / ajm_total_orders) we actually have on file.
 *
 * No writes. Auth: x-admin-key: jaxy2026.
 *   ?years=4  (recency window, default 4)
 */
export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}

function parseYear(v: string | null): number | null {
  if (!v) return null;
  const s = v.trim();
  // ISO (YYYY-MM-DD / YYYY/..) or US (M/D/YYYY). Grab a 4-digit year.
  const iso = s.match(/^(\d{4})[-/]/);
  if (iso) return parseInt(iso[1], 10);
  const us = s.match(/\/(\d{4})\b/) || s.match(/\b(\d{4})$/);
  if (us) return parseInt(us[1], 10);
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.getFullYear();
}

function run(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const years = Math.max(1, parseInt(new URL(req.url).searchParams.get("years") || "4", 10));
  const cutoffYear = new Date().getFullYear() - years;

  // Pull the whole AJM base once; classify in JS to avoid date-format pitfalls.
  const rows = sqlite
    .prepare(
      `SELECT c.id, c.status, c.tags, c.source,
              c.ajm_total_spend AS spend, c.ajm_total_orders AS orders, c.ajm_last_order AS last_order,
              c.pipedrive_org_id AS org_id,
              (SELECT COUNT(*) FROM orders o WHERE o.company_id = c.id AND o.status != 'cancelled') AS jaxy_orders,
              (SELECT COUNT(*) FROM company_phones p WHERE p.company_id = c.id) AS phones,
              (SELECT COUNT(*) FROM contacts ct WHERE ct.company_id = c.id
                 AND TRIM(COALESCE(ct.email,'')) <> '' AND lower(ct.email) NOT LIKE '%@relay.faire.com%') AS emails,
              (SELECT COUNT(*) FROM pipedrive_deals d WHERE d.company_id = c.id AND d.is_open = 1) AS open_deals
         FROM companies c
        WHERE c.tags LIKE '%ajm_2025%' OR c.source = 'ajm_2025_import'`,
    )
    .all() as Array<{
    id: string;
    status: string | null;
    tags: string | null;
    source: string | null;
    spend: number | null;
    orders: number | null;
    last_order: string | null;
    org_id: number | null;
    jaxy_orders: number;
    phones: number;
    emails: number;
    open_deals: number;
  }>;

  const hasTag = (tags: string | null, t: string) => !!tags && tags.toLowerCase().includes(t.toLowerCase());

  // Target segment: AJM company that has NOT ordered with Jaxy.
  const notJaxy = rows.filter(
    (r) => r.jaxy_orders === 0 && r.status !== "customer" && !hasTag(r.tags, "ajm_already_customer"),
  );
  const within = notJaxy.filter((r) => {
    const y = parseYear(r.last_order);
    return y !== null && y >= cutoffYear;
  });
  const unknownDate = notJaxy.filter((r) => parseYear(r.last_order) === null);

  // Spend distribution over the target (not-Jaxy) segment.
  const withSpend = notJaxy.filter((r) => r.spend != null && r.spend > 0);
  const spends = withSpend.map((r) => r.spend as number).sort((a, b) => a - b);
  const pct = (p: number) => (spends.length ? spends[Math.min(spends.length - 1, Math.floor((p / 100) * spends.length))] : null);
  const withOrders = notJaxy.filter((r) => r.orders != null && (r.orders as number) > 0);

  const seg = within.length ? within : notJaxy; // reachable target for the reachability stats
  const callable = seg.filter((r) => r.phones > 0).length;
  const emailable = seg.filter((r) => r.emails > 0).length;
  const alreadyInPd = seg.filter((r) => r.open_deals > 0 || r.org_id != null).length;

  return NextResponse.json({
    ok: true,
    asOfYearCutoff: cutoffYear,
    recencyYears: years,
    totals: {
      ajmBase: rows.length,
      notOrderedWithJaxy: notJaxy.length,
      notJaxy_within_window: within.length,
      notJaxy_unknown_last_order: unknownDate.length,
      alreadyJaxyCustomers: rows.length - notJaxy.length,
    },
    valueDataCoverage: {
      withSpend: withSpend.length,
      withSpendPct: notJaxy.length ? Math.round((withSpend.length / notJaxy.length) * 100) : 0,
      withOrderCount: withOrders.length,
      spendStats: spends.length
        ? { min: spends[0], p25: pct(25), median: pct(50), p75: pct(75), p90: pct(90), max: spends[spends.length - 1] }
        : null,
    },
    reachability_targetSegment: {
      basis: within.length ? `not-Jaxy AND last order within ${years}y` : "not-Jaxy (no datable last-order window applied)",
      size: seg.length,
      callable_hasPhone: callable,
      emailable_hasEmail: emailable,
      alreadyInPipedrive: alreadyInPd,
    },
    sampleLastOrderValues: notJaxy.slice(0, 10).map((r) => r.last_order),
  });
}
