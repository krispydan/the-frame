export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { getStoreByDomain } from "@/modules/sales/lib/storeleads/client";

/**
 * POST /api/v1/sales/prospects/[id]/enrich-storeleads
 *
 * Per-prospect "Enrich via StoreLeads" button. Looks up the prospect's
 * domain on StoreLeads (with follow_redirects so a domain-cluster store
 * resolves to its canonical record) and merges every field we care
 * about with COALESCE — fill nulls, never clobber a hand-edited value.
 *
 * Returns:
 *   { ok: true,  enrichedFields: string[] }  on success
 *   { ok: false, error: string }             on StoreLeads / domain errors
 *   { ok: false, error: "No domain on this prospect" } when the row is
 *                                                   missing a domain
 *   { ok: true,  enrichedFields: [], notFound: true } when StoreLeads
 *                                                   doesn't know the domain
 */
export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  const row = sqlite
    .prepare(
      `SELECT id, domain FROM companies WHERE id = ? LIMIT 1`,
    )
    .get(id) as { id: string; domain: string | null } | undefined;
  if (!row) {
    return NextResponse.json({ ok: false, error: "Prospect not found" }, { status: 404 });
  }
  if (!row.domain) {
    return NextResponse.json(
      { ok: false, error: "No domain on this prospect — set one before enriching" },
      { status: 400 },
    );
  }

  let sl;
  try {
    sl = await getStoreByDomain(row.domain, { followRedirects: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }

  if (!sl) {
    // Stamp the sync timestamp so we don't keep retrying a known-unknown
    // domain on every page load.
    sqlite
      .prepare(`UPDATE companies SET storeleads_last_synced_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), row.id);
    return NextResponse.json({ ok: true, enrichedFields: [], notFound: true });
  }

  // Same merge rule as customer-sync.ts: COALESCE existing → new. Track
  // which fields were null before so the UI can flag them.
  const before = sqlite
    .prepare(
      `SELECT category, industry, estimated_yearly_sales_cents,
              estimated_monthly_visits, average_product_price_cents,
              employee_count, ecom_platform, facebook_url, instagram_url,
              tiktok_url, tiktok_followers, youtube_url, youtube_followers,
              phone, email, storeleads_id
       FROM companies WHERE id = ?`,
    )
    .get(row.id) as Record<string, unknown>;

  const ci = sl.contact_info ?? [];
  const first = (type: string) =>
    ci.find((e) => e.type?.toLowerCase() === type)?.value ?? null;
  const follow = (type: string) =>
    ci.find((e) => e.type?.toLowerCase() === type)?.followers ?? null;
  const categoryRaw = sl.categories?.[0] ?? null;
  const industry = categoryRaw
    ? categoryRaw.split("/").map((s) => s.trim()).filter(Boolean).pop() ?? null
    : null;

  // (column, value)
  const candidates: Array<[string, unknown]> = [
    ["category", categoryRaw],
    ["industry", industry],
    ["estimated_yearly_sales_cents", typeof sl.estimated_sales_yearly === "number" ? sl.estimated_sales_yearly : null],
    ["estimated_monthly_visits", typeof sl.estimated_visits === "number" ? sl.estimated_visits : null],
    ["average_product_price_cents", typeof sl.avg_price_usd === "number" ? sl.avg_price_usd : null],
    ["employee_count", typeof sl.employee_count === "number" ? sl.employee_count : null],
    ["ecom_platform", sl.platform?.toLowerCase() ?? null],
    ["facebook_url", first("facebook")],
    ["instagram_url", first("instagram")],
    ["tiktok_url", first("tiktok")],
    ["tiktok_followers", follow("tiktok")],
    ["youtube_url", first("youtube")],
    ["youtube_followers", follow("youtube")],
    ["phone", first("phone")],
    ["email", first("email")],
    ["storeleads_id", sl.platform_domain ?? sl.domain ?? null],
  ];

  const enrichedFields: string[] = [];
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [col, val] of candidates) {
    if (val == null) continue;
    const cur = before[col];
    if (cur != null && cur !== "") continue;
    sets.push(`${col} = ?`);
    vals.push(val);
    enrichedFields.push(col);
  }
  // Always-stamp.
  sets.push("storeleads_last_synced_at = ?");
  vals.push(new Date().toISOString());
  sets.push("updated_at = ?");
  vals.push(new Date().toISOString());
  vals.push(row.id);

  sqlite.prepare(`UPDATE companies SET ${sets.join(", ")} WHERE id = ?`).run(...vals);

  return NextResponse.json({ ok: true, enrichedFields });
}
