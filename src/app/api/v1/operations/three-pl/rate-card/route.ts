export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * GET /api/v1/operations/three-pl/rate-card → current rates (latest per key)
 * PUT { serviceKey, rate, effectiveFrom?, notes? } → upsert a rate row.
 *   Passing a NEW effectiveFrom creates a dated revision (history preserved);
 *   same effectiveFrom updates in place.
 */
export async function GET() {
  const rows = sqlite.prepare(
    `SELECT id, service_key AS serviceKey, label, rate_json AS rateJson,
            effective_from AS effectiveFrom, notes, updated_at AS updatedAt
     FROM three_pl_rate_card ORDER BY service_key, effective_from DESC`,
  ).all() as Array<Record<string, unknown>>;
  return NextResponse.json({
    rates: rows.map((r) => ({ ...r, rate: JSON.parse(r.rateJson as string), rateJson: undefined })),
  });
}

export async function PUT(req: NextRequest) {
  let body: { serviceKey?: string; label?: string; rate?: Record<string, unknown>; effectiveFrom?: string; notes?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Bad JSON" }, { status: 400 }); }
  if (!body.serviceKey || !body.rate || typeof body.rate !== "object") {
    return NextResponse.json({ error: "serviceKey and rate required" }, { status: 400 });
  }
  const effectiveFrom = body.effectiveFrom || "2026-04-01";
  const existing = sqlite.prepare(
    "SELECT id, label FROM three_pl_rate_card WHERE service_key = ? AND effective_from = ?",
  ).get(body.serviceKey, effectiveFrom) as { id: string; label: string } | undefined;

  if (existing) {
    sqlite.prepare(
      "UPDATE three_pl_rate_card SET rate_json = ?, label = ?, notes = COALESCE(?, notes), updated_at = datetime('now') WHERE id = ?",
    ).run(JSON.stringify(body.rate), body.label || existing.label, body.notes ?? null, existing.id);
  } else {
    const label = body.label
      || (sqlite.prepare("SELECT label FROM three_pl_rate_card WHERE service_key = ? ORDER BY effective_from DESC LIMIT 1")
        .get(body.serviceKey) as { label: string } | undefined)?.label
      || body.serviceKey;
    sqlite.prepare(
      "INSERT INTO three_pl_rate_card (id, service_key, label, rate_json, effective_from, notes) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(crypto.randomUUID(), body.serviceKey, label, JSON.stringify(body.rate), effectiveFrom, body.notes ?? null);
  }
  return NextResponse.json({ ok: true });
}
