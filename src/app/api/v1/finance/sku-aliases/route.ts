export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * SKU alias management for COGS costing.
 *
 * An alias maps a sales/order SKU string with no catalog row (Faire duplicate
 * listings like JX3003-F1-BLK, size variants like JX4004-S-BLK) to a canonical
 * catalog SKU, so orders cost against that SKU's FIFO layers instead of
 * raising an unmapped_sku exception. Same logic as MCP finance.add_sku_alias.
 *
 *   GET     → list aliases
 *   POST    { alias, canonicalSku, note? } → create/replace
 *   DELETE  { alias } → remove
 */

export async function GET() {
  const rows = sqlite.prepare(`
    SELECT a.alias, a.canonical_sku AS canonicalSku, a.note, a.created_at AS createdAt
    FROM catalog_sku_aliases a ORDER BY a.alias
  `).all();
  return NextResponse.json({ aliases: rows });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const alias = typeof body.alias === "string" ? body.alias.trim() : "";
  const canonicalSku = typeof body.canonicalSku === "string" ? body.canonicalSku.trim() : "";
  const note = typeof body.note === "string" ? body.note.trim() || null : null;
  if (!alias || !canonicalSku) {
    return NextResponse.json({ error: "alias and canonicalSku are required" }, { status: 400 });
  }
  if (alias === canonicalSku) {
    return NextResponse.json({ error: "alias and canonical SKU are identical" }, { status: 400 });
  }
  const row = sqlite.prepare("SELECT id FROM catalog_skus WHERE sku = ? LIMIT 1").get(canonicalSku) as { id: string } | undefined;
  if (!row) {
    return NextResponse.json({ error: `Canonical SKU "${canonicalSku}" not found in catalog` }, { status: 404 });
  }
  sqlite.prepare(
    "INSERT OR REPLACE INTO catalog_sku_aliases (alias, sku_id, canonical_sku, note) VALUES (?, ?, ?, ?)",
  ).run(alias, row.id, canonicalSku, note);
  return NextResponse.json({ ok: true, alias, canonicalSku });
}

export async function DELETE(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const alias = typeof body.alias === "string" ? body.alias.trim() : "";
  if (!alias) return NextResponse.json({ error: "alias is required" }, { status: 400 });
  const res = sqlite.prepare("DELETE FROM catalog_sku_aliases WHERE alias = ?").run(alias);
  return NextResponse.json({ ok: true, deleted: res.changes });
}
