export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { requireOpsToken } from "@/lib/ops-auth";
import { sqlite } from "@/lib/db";
import { ajmAccountsWithJaxy } from "@/modules/sales/lib/ajm/accounts";

/**
 * GET /api/admin/ops/ajm/diagnose?names=Show Pony,Sunwink,Grey56
 *
 * Why does an account show AJM revenue but no Jaxy revenue when we know it
 * has ordered? Almost always because the AJM history and the Jaxy orders
 * landed on DIFFERENT company records for the same retailer — Jaxy companies
 * are frequently auto-created from an order and named after the buyer's email
 * (e.g. "ashleyriggs@lukesdrugmart.com") or the ship-to name, while the AJM
 * import matched the trading name ("Luke's Drug Mart").
 *
 * For each search term this returns every candidate company plus its AJM and
 * Jaxy revenue, and any Jaxy ORDERS whose ship-to name matches but whose
 * company is different — which is the smoking gun for a split identity.
 */
export async function GET(req: NextRequest) {
  const denied = requireOpsToken(req);
  if (denied) return denied;

  const names = (req.nextUrl.searchParams.get("names") ?? "")
    .split(",").map((n) => n.trim()).filter(Boolean);
  if (!names.length) return NextResponse.json({ error: "pass ?names=A,B,C" }, { status: 400 });

  // Computed once — this is the page's own account list.
  const pageRows = ajmAccountsWithJaxy();

  const out = names.map((name) => {
    const like = `%${name.toLowerCase()}%`;

    // Companies whose name looks like this retailer
    const companies = sqlite.prepare(`
      SELECT c.id, c.name,
        (SELECT ROUND(SUM(a.total),2) FROM ajm_orders a WHERE a.company_id=c.id AND a.cancelled=0) AS ajmRevenue,
        (SELECT COUNT(*) FROM ajm_orders a WHERE a.company_id=c.id AND a.cancelled=0) AS ajmOrders,
        (SELECT ROUND(SUM(o.total),2) FROM orders o WHERE o.company_id=c.id AND o.status NOT IN ('cancelled','returned')) AS jaxyRevenue,
        (SELECT COUNT(*) FROM orders o WHERE o.company_id=c.id AND o.status NOT IN ('cancelled','returned')) AS jaxyOrders,
        (SELECT ct.email FROM contacts ct WHERE ct.company_id=c.id AND ct.email IS NOT NULL LIMIT 1) AS email
      FROM companies c WHERE LOWER(c.name) LIKE ?
      ORDER BY COALESCE(ajmRevenue,0) + COALESCE(jaxyRevenue,0) DESC LIMIT 20
    `).all(like);

    // Jaxy orders that LOOK like this retailer by ship-to name, regardless of
    // which company they were attributed to.
    const jaxyOrdersByShipTo = sqlite.prepare(`
      SELECT o.order_number AS orderNumber, o.total, substr(o.placed_at,1,10) AS placedAt,
             o.ship_to_name AS shipToName, o.company_id AS companyId, c.name AS companyName
      FROM orders o LEFT JOIN companies c ON c.id = o.company_id
      WHERE o.status NOT IN ('cancelled','returned')
        AND (LOWER(COALESCE(o.ship_to_name,'')) LIKE ? OR LOWER(COALESCE(c.name,'')) LIKE ?)
      ORDER BY o.placed_at DESC LIMIT 20
    `).all(like, like);

    // AJM orders that look like this retailer by their raw customer name.
    const ajmByRawName = sqlite.prepare(`
      SELECT a.customer_name AS customerName, a.company_id AS companyId, c.name AS companyName,
             ROUND(SUM(a.total),2) AS ajmRevenue, COUNT(*) AS ajmOrders
      FROM ajm_orders a LEFT JOIN companies c ON c.id = a.company_id
      WHERE a.cancelled=0 AND LOWER(COALESCE(a.customer_name,'')) LIKE ?
      GROUP BY a.customer_name, a.company_id LIMIT 20
    `).all(like);

    const ajmCompanyIds = new Set((ajmByRawName as Array<{ companyId: string | null }>).map((r) => r.companyId).filter(Boolean));
    const jaxyCompanyIds = new Set((jaxyOrdersByShipTo as Array<{ companyId: string | null }>).map((r) => r.companyId).filter(Boolean));
    const shared = [...ajmCompanyIds].filter((id) => jaxyCompanyIds.has(id));

    // What the /customers/ajm page ACTUALLY renders for this retailer — same
    // query, not a re-implementation. If this shows Jaxy revenue but the page
    // doesn't, the problem is the page; if this shows $0 too, it's the data.
    const onPage = pageRows.filter((r) => r.name.toLowerCase().includes(name.toLowerCase()));

    return {
      name,
      companies,
      ajmByRawName,
      jaxyOrdersByShipTo,
      onPage,
      verdict: !ajmCompanyIds.size ? "AJM history not matched to any company"
        : !jaxyCompanyIds.size ? "No Jaxy orders found by name/ship-to"
        : shared.length ? "SAME company — should already show; check date filters"
        : "SPLIT IDENTITY — AJM history and Jaxy orders are on different company records",
      ajmCompanyIds: [...ajmCompanyIds],
      jaxyCompanyIds: [...jaxyCompanyIds],
    };
  });

  return NextResponse.json({ results: out });
}
