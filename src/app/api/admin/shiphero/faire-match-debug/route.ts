export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { findFaireOrderByOrderNumber, fetchFaireOrderById } from "@/modules/integrations/lib/faire/order-matching";

/**
 * GET /api/admin/shiphero/faire-match-debug?orderNumber=RDVK4VZ3NX
 *
 * Diagnoses why a Faire order was (or wasn't) matched for the ShipHero
 * packing-slip attach: shows the local frame order rows for that number, the
 * result of findFaireOrderByOrderNumber, and a raw Faire /orders scan (where the
 * target display_id appears, and the sort/window of the paged results).
 * Auth: x-admin-key: jaxy2026.
 */
export async function GET(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const orderNumber = (new URL(req.url).searchParams.get("orderNumber") || "").trim();
  if (!orderNumber) return NextResponse.json({ error: "orderNumber required" }, { status: 400 });
  const code = orderNumber.replace(/^#/, "").trim().toUpperCase();

  // 1. Local frame order rows for this number.
  const local = sqlite
    .prepare(
      `SELECT id, order_number, channel, source_name, external_id, shiphero_order_number, created_at
       FROM orders WHERE UPPER(order_number) = ? OR UPPER(order_number) = ? OR UPPER(external_id) = ?`,
    )
    .all(code, `#${code}`, code);

  // 2. Current matcher result.
  let matchResult: unknown = null;
  let matchError: string | null = null;
  try {
    matchResult = await findFaireOrderByOrderNumber(orderNumber);
  } catch (e) {
    matchError = e instanceof Error ? e.message : String(e);
  }

  // 2b. Direct order-detail fetch (the new fast path): bo_<lowercased code>.
  let directFetch: unknown = null;
  let directError: string | null = null;
  try {
    const o = await fetchFaireOrderById(`bo_${code.toLowerCase()}`);
    directFetch = o ? { id: o.id, display_id: o.display_id, state: o.state } : null;
  } catch (e) {
    directError = e instanceof Error ? e.message : String(e);
  }

  // 3. Raw Faire scan — widen to 12 pages, report where the target appears +
  //    the update-date range per page (reveals sort direction + window miss).
  const token = process.env.FAIRE_API_TOKEN;
  const scan: Array<{ page: number; count: number; firstDisplay?: string; lastDisplay?: string; firstUpdated?: string; lastUpdated?: string; foundHere?: boolean }> = [];
  let foundOnPage: number | null = null;
  let scanError: string | null = null;
  if (token) {
    const updatedAtMin = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    try {
      for (let page = 1; page <= 12; page++) {
        const params = new URLSearchParams({ limit: "50", page: String(page), updated_at_min: updatedAtMin });
        const res = await fetch(`https://www.faire.com/external-api/v2/orders?${params}`, {
          headers: { "X-FAIRE-ACCESS-TOKEN": token, "Content-Type": "application/json" },
        });
        if (!res.ok) {
          scanError = `page ${page}: ${res.status} ${res.statusText}`;
          break;
        }
        const bodyJson = (await res.json()) as { orders?: Array<{ display_id?: string; updated_at?: string; created_at?: string }> };
        const orders = bodyJson.orders ?? [];
        const found = orders.some((o) => (o.display_id || "").toUpperCase() === code);
        if (found && foundOnPage == null) foundOnPage = page;
        scan.push({
          page,
          count: orders.length,
          firstDisplay: orders[0]?.display_id,
          lastDisplay: orders[orders.length - 1]?.display_id,
          firstUpdated: orders[0]?.updated_at ?? orders[0]?.created_at,
          lastUpdated: orders[orders.length - 1]?.updated_at ?? orders[orders.length - 1]?.created_at,
          foundHere: found,
        });
        if (orders.length < 50) break;
      }
    } catch (e) {
      scanError = e instanceof Error ? e.message : String(e);
    }
  } else {
    scanError = "FAIRE_API_TOKEN not set";
  }

  return NextResponse.json({
    ok: true,
    orderNumber,
    code,
    localOrders: local,
    matcher: { result: matchResult, error: matchError },
    directFetch: { result: directFetch, error: directError },
    faireScan: { foundOnPage, pagesScanned: scan.length, scanError, pages: scan },
  });
}
