export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { getPipedriveConnectionStatus, updateDeal } from "@/modules/sales/lib/pipedrive-client";
import { resolveOrg, resolvePerson, isSyncEnabled } from "@/modules/sales/lib/pipedrive-sync";
import { getPipedriveOwner } from "@/modules/sales/lib/pipedrive-setup";
import { ensureCustomerAccount } from "@/modules/customers/lib/account-sync";

/**
 * POST /api/admin/sales/split-lumped-company
 *
 * Splits a "lumped" company — one company that accumulated orders from several
 * distinct retailers (the Faire-via-Shopify collapse: shared relay email + no
 * company name) — into one company per retailer, keyed by the order's ship-to
 * store name.
 *
 * For each distinct ship-to name it find-or-creates a company, re-points that
 * group's orders, moves each order's Pipedrive deal to the correct org/person,
 * and refreshes customer accounts. The largest group stays on the original
 * company (renamed to match if needed) so nothing is orphaned.
 *
 * Body: { companyId: string, dryRun?: boolean }   dryRun defaults to true.
 * Auth: x-admin-key: jaxy2026
 */
export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { companyId?: string; dryRun?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    /* empty */
  }
  const companyId = body.companyId;
  const dryRun = body.dryRun !== false; // default true
  if (!companyId) return NextResponse.json({ error: "companyId required" }, { status: 400 });

  const company = sqlite.prepare("SELECT id, name FROM companies WHERE id = ?").get(companyId) as
    | { id: string; name: string | null }
    | undefined;
  if (!company) return NextResponse.json({ error: "company not found" }, { status: 404 });

  const orders = sqlite
    .prepare(
      `SELECT id, order_number, ship_to_name, pipedrive_deal_id, total
         FROM orders WHERE company_id = ?`,
    )
    .all(companyId) as Array<{ id: string; order_number: string | null; ship_to_name: string | null; pipedrive_deal_id: number | null; total: number | null }>;

  // Group orders by normalized ship-to name. Orders with no ship-to name can't
  // be attributed — they stay on the original company.
  const groups = new Map<string, { display: string; orderIds: string[]; deals: number; withDeal: number }>();
  let unattributed = 0;
  for (const o of orders) {
    const raw = (o.ship_to_name || "").trim();
    if (!raw) {
      unattributed++;
      continue;
    }
    const key = raw.toLowerCase().replace(/\s+/g, " ");
    const g = groups.get(key) || { display: titleCase(raw), orderIds: [], deals: 0, withDeal: 0 };
    g.orderIds.push(o.id);
    if (o.pipedrive_deal_id) g.withDeal++;
    groups.set(key, g);
  }

  if (groups.size <= 1) {
    return NextResponse.json({
      ok: true,
      companyId,
      companyName: company.name,
      note: "Not lumped — one (or zero) distinct ship-to name; nothing to split.",
      distinctShipTo: groups.size,
      unattributed,
    });
  }

  // Pick the group that stays on the original company: the one matching the
  // company's current name, else the largest.
  const normName = (company.name || "").trim().toLowerCase().replace(/\s+/g, " ");
  const entries = [...groups.entries()];
  let keepKey = entries.find(([k]) => k === normName)?.[0];
  if (!keepKey) keepKey = entries.sort((a, b) => b[1].orderIds.length - a[1].orderIds.length)[0][0];

  const plan = entries.map(([k, g]) => ({
    shipTo: g.display,
    orders: g.orderIds.length,
    ordersWithPipedriveDeal: g.withDeal,
    disposition: k === keepKey ? "stays on original company" : "new / matched company",
  }));

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      companyId,
      companyName: company.name,
      totalOrders: orders.length,
      unattributed,
      distinctShipTo: groups.size,
      plan,
    });
  }

  // ── Apply ──
  const owner = getPipedriveOwner()?.id;
  const pdOn = isSyncEnabled() && getPipedriveConnectionStatus().connected;
  const affectedCompanies = new Set<string>([companyId]);
  const result: Array<Record<string, unknown>> = [];

  for (const [key, g] of entries) {
    let targetId: string;
    if (key === keepKey) {
      targetId = companyId;
      // Rename the original to the kept group's store name if it doesn't match.
      if (normName !== key) {
        sqlite.prepare("UPDATE companies SET name = ?, updated_at = datetime('now') WHERE id = ?").run(g.display, companyId);
      }
    } else {
      // Find an existing company by exact (case-insensitive) name, else create.
      const existing = sqlite
        .prepare("SELECT id FROM companies WHERE lower(trim(name)) = ? LIMIT 1")
        .get(key) as { id: string } | undefined;
      if (existing) {
        targetId = existing.id;
      } else {
        targetId = crypto.randomUUID();
        sqlite
          .prepare("INSERT INTO companies (id, name, source, status, created_at, updated_at) VALUES (?, ?, 'shopify_split', 'customer', datetime('now'), datetime('now'))")
          .run(targetId, g.display);
      }
      // Re-point this group's orders.
      const placeholders = g.orderIds.map(() => "?").join(",");
      sqlite.prepare(`UPDATE orders SET company_id = ? WHERE id IN (${placeholders})`).run(targetId, ...g.orderIds);
    }
    affectedCompanies.add(targetId);

    // Move each order's Pipedrive deal to the target company's org/person.
    let dealsMoved = 0;
    if (pdOn && targetId !== companyId) {
      try {
        const orgId = await resolveOrg(targetId, owner);
        const personId = await resolvePerson(targetId, orgId, owner);
        for (const oid of g.orderIds) {
          const row = sqlite.prepare("SELECT pipedrive_deal_id FROM orders WHERE id = ?").get(oid) as { pipedrive_deal_id: number | null } | undefined;
          if (!row?.pipedrive_deal_id) continue;
          try {
            const patch: Record<string, unknown> = { org_id: orgId };
            if (personId) patch.person_id = personId;
            await updateDeal(row.pipedrive_deal_id, patch);
            sqlite.prepare("UPDATE pipedrive_deals SET company_id = ?, updated_at = datetime('now') WHERE pipedrive_deal_id = ?").run(targetId, row.pipedrive_deal_id);
            dealsMoved++;
          } catch (e) {
            console.error("[split-lumped] move deal failed", oid, e);
          }
        }
      } catch (e) {
        console.error("[split-lumped] resolve org/person failed for", targetId, e);
      }
    }

    result.push({ shipTo: g.display, companyId: targetId, orders: g.orderIds.length, dealsMoved, original: targetId === companyId });
  }

  // Refresh customer-account stats (LTV / order counts / tier) for every
  // affected company so the customer pages reflect the new grouping.
  for (const cid of affectedCompanies) {
    try {
      ensureCustomerAccount(cid);
    } catch (e) {
      console.error("[split-lumped] ensureCustomerAccount failed for", cid, e);
    }
  }

  return NextResponse.json({
    ok: true,
    companyId,
    unattributed,
    groups: result,
    affectedCompanies: [...affectedCompanies],
  });
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\s+/g, " ")
    .trim();
}
