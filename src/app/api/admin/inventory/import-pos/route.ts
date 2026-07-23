export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * POST /api/admin/inventory/import-pos
 *
 * Import in-flight factory purchase orders into inventory_purchase_orders +
 * inventory_po_line_items so the demand forecaster can count them as
 * incoming supply (and so the PO/receiving/FIFO flow can track them).
 *
 * Body:
 *   {
 *     rows: [{ po, factory, sku, style, color, qty, unitCost, shipDate }],
 *     orderDate?: "2026-07-20",   // applied to all POs (default today)
 *     replace?: boolean,           // re-import an existing PO number
 *     dryRun?: boolean
 *   }
 *
 * - Factories are upserted by code (Taga→JX1, Huide→JX2, Geya→JX3,
 *   Brilliant→JX4, Pilot→JX5).
 * - shipDate accepts "August 10th" style strings; year defaults to the
 *   current year (next year if the date already passed >60 days ago).
 * - expected_arrival_date = ship date + factory transit lead days.
 * - Idempotent by PO number: existing POs are skipped unless replace=true.
 *
 * GET → { version } (deploy marker).
 * Auth: x-admin-key: jaxy2026.
 */

const VERSION = "v1-import-pos";

const FACTORY_CODES: Record<string, string> = {
  taga: "JX1",
  huide: "JX2",
  geya: "JX3",
  brilliant: "JX4",
  pilot: "JX5",
};

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

function parseShipDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().toLowerCase().replace(/(\d+)(st|nd|rd|th)/, "$1");
  const m = /^([a-z]+)\s+(\d{1,2})(?:,?\s*(\d{4}))?$/.exec(cleaned);
  if (!m) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().split("T")[0];
  }
  const monthIdx = MONTHS.indexOf(m[1]);
  if (monthIdx < 0) return null;
  const day = parseInt(m[2], 10);
  let year = m[3] ? parseInt(m[3], 10) : new Date().getFullYear();
  const candidate = new Date(Date.UTC(year, monthIdx, day));
  // No explicit year and the date is >60 days in the past → assume next year.
  if (!m[3] && candidate.getTime() < Date.now() - 60 * 86400000) year += 1;
  return new Date(Date.UTC(year, monthIdx, day)).toISOString().split("T")[0];
}

interface PoRow {
  po: string;
  factory: string;
  sku: string;
  style?: string;
  color?: string;
  qty: number;
  unitCost?: number;
  shipDate?: string;
}

export async function GET(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const pos = sqlite.prepare(`
    SELECT po.po_number, f.name AS factory, po.status, po.total_units, po.total_cost,
           po.expected_ship_date, po.expected_arrival_date,
           (SELECT COUNT(*) FROM inventory_po_line_items li WHERE li.po_id = po.id) AS line_count
    FROM inventory_purchase_orders po
    LEFT JOIN inventory_factories f ON po.factory_id = f.id
    ORDER BY po.po_number
  `).all();
  return NextResponse.json({ ok: true, version: VERSION, pos });
}

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { rows?: PoRow[]; orderDate?: string; replace?: boolean; dryRun?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }
  const rows = body.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: "rows[] required" }, { status: 400 });
  }
  const dryRun = body.dryRun === true;
  const replace = body.replace === true;
  const orderDate = body.orderDate ?? new Date().toISOString().split("T")[0];

  // ── Upsert factories ──
  const factoryIds = new Map<string, { id: string; transitLeadDays: number }>();
  const factoryPlan: string[] = [];
  for (const name of new Set(rows.map((r) => r.factory.trim()))) {
    const code = FACTORY_CODES[name.toLowerCase()];
    if (!code) {
      return NextResponse.json({ error: `Unknown factory "${name}" — add it to FACTORY_CODES` }, { status: 400 });
    }
    const existing = sqlite.prepare(
      "SELECT id, transit_lead_days FROM inventory_factories WHERE code = ?",
    ).get(code) as { id: string; transit_lead_days: number } | undefined;
    if (existing) {
      factoryIds.set(name, { id: existing.id, transitLeadDays: existing.transit_lead_days ?? 25 });
    } else {
      const id = crypto.randomUUID();
      factoryIds.set(name, { id, transitLeadDays: 25 });
      factoryPlan.push(`${code} ${name}`);
      if (!dryRun) {
        sqlite.prepare(
          "INSERT INTO inventory_factories (id, code, name, production_lead_days, transit_lead_days, moq, created_at) VALUES (?, ?, ?, 30, 25, 300, datetime('now'))",
        ).run(id, code, name);
      }
    }
  }

  // ── Resolve SKUs ──
  const skuLookup = sqlite.prepare("SELECT id FROM catalog_skus WHERE UPPER(sku) = ? LIMIT 1");
  const aliasLookup = sqlite.prepare("SELECT sku_id FROM catalog_sku_aliases WHERE UPPER(alias) = ? LIMIT 1");
  const unmatched: string[] = [];
  const resolved = rows.map((r) => {
    const skuUp = r.sku.trim().toUpperCase();
    const hit = (skuLookup.get(skuUp) as { id: string } | undefined)?.id
      ?? (aliasLookup.get(skuUp) as { sku_id: string } | undefined)?.sku_id
      ?? null;
    if (!hit) unmatched.push(skuUp);
    return { ...r, sku: skuUp, skuId: hit };
  });

  // ── Group by PO ──
  const byPo = new Map<string, typeof resolved>();
  for (const r of resolved) {
    const list = byPo.get(r.po) ?? [];
    list.push(r);
    byPo.set(r.po, list);
  }

  const result: Array<{ po: string; action: string; units: number; cost: number; lines: number; shipDate: string | null; arrivalDate: string | null }> = [];

  const insertPo = sqlite.prepare(`
    INSERT INTO inventory_purchase_orders
      (id, po_number, factory_id, status, total_units, total_cost, order_date,
       expected_ship_date, expected_arrival_date, notes, created_at)
    VALUES (?, ?, ?, 'in_production', ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const insertLine = sqlite.prepare(`
    INSERT INTO inventory_po_line_items (id, po_id, sku_id, quantity, pack_size, unit_cost, total_cost)
    VALUES (?, ?, ?, ?, 1, ?, ?)
  `);

  for (const [poNumber, lines] of byPo) {
    const existing = sqlite.prepare(
      "SELECT id, status FROM inventory_purchase_orders WHERE po_number = ?",
    ).get(poNumber) as { id: string; status: string } | undefined;

    if (existing && !replace) {
      result.push({ po: poNumber, action: `skipped (exists, status ${existing.status})`, units: 0, cost: 0, lines: 0, shipDate: null, arrivalDate: null });
      continue;
    }

    const usable = lines.filter((l) => l.skuId);
    const units = usable.reduce((a, l) => a + l.qty, 0);
    const cost = Math.round(usable.reduce((a, l) => a + l.qty * (l.unitCost ?? 0), 0) * 100) / 100;
    const factory = factoryIds.get(lines[0].factory.trim())!;
    const shipDate = parseShipDate(lines[0].shipDate);
    const arrivalDate = shipDate
      ? new Date(Date.parse(shipDate) + factory.transitLeadDays * 86400000).toISOString().split("T")[0]
      : null;

    result.push({
      po: poNumber,
      action: existing ? "replaced" : dryRun ? "would create" : "created",
      units, cost, lines: usable.length, shipDate, arrivalDate,
    });

    if (dryRun) continue;

    const txn = sqlite.transaction(() => {
      if (existing) {
        sqlite.prepare("DELETE FROM inventory_po_line_items WHERE po_id = ?").run(existing.id);
        sqlite.prepare("DELETE FROM inventory_purchase_orders WHERE id = ?").run(existing.id);
      }
      const poId = crypto.randomUUID();
      insertPo.run(
        poId, poNumber, factory.id, units, cost, orderDate,
        shipDate, arrivalDate, "Imported from current-POs sheet (Jul 2026)",
      );
      for (const l of usable) {
        insertLine.run(crypto.randomUUID(), poId, l.skuId, l.qty, l.unitCost ?? 0, Math.round(l.qty * (l.unitCost ?? 0) * 100) / 100);
      }
    });
    txn();
  }

  return NextResponse.json({
    ok: true,
    version: VERSION,
    dryRun,
    counts: {
      rows: rows.length,
      pos: byPo.size,
      unmatchedSkus: unmatched.length,
      newFactories: factoryPlan,
    },
    unmatched,
    pos: result,
  });
}
