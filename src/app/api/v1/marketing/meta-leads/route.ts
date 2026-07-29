export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { getSessionUser } from "@/lib/get-session";
import { metaLeadsConfigured, metaCapiConfigured } from "@/modules/integrations/lib/meta/client";

/**
 * GET /api/v1/marketing/meta-leads?days=30&status=all|processed|error
 *
 * Facebook / Instagram lead-ad manager data: the lead list with attribution and
 * downstream links, funnel counts, per-campaign performance, and the health of
 * the ingest + Conversions API queues.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const params = req.nextUrl.searchParams;
  const days = Math.min(365, Math.max(7, parseInt(params.get("days") || "30", 10)));
  const status = params.get("status") || "all";
  const start = new Date(Date.now() - days * 86400000).toISOString();

  const many = <T,>(sql: string, ...args: unknown[]): T[] => {
    try { return sqlite.prepare(sql).all(...args) as T[]; } catch { return []; }
  };
  const one = <T,>(sql: string, ...args: unknown[]): T | undefined => {
    try { return sqlite.prepare(sql).get(...args) as T; } catch { return undefined; }
  };

  const where = status === "all" ? "" : "AND ml.status = ?";
  const args: unknown[] = status === "all" ? [start] : [start, status];

  const leads = many<Record<string, unknown>>(
    `SELECT ml.leadgen_id, ml.full_name, ml.email, ml.phone, ml.campaign_name, ml.ad_name,
            ml.status, ml.error, ml.created_at, ml.company_id, ml.pipedrive_lead_id,
            c.name AS company_name, c.status AS company_status
       FROM meta_leads ml LEFT JOIN companies c ON c.id = ml.company_id
      WHERE ml.created_at >= ? ${where}
      ORDER BY ml.created_at DESC LIMIT 200`, ...args);

  const byStatus = many<{ status: string; n: number }>(
    `SELECT status, COUNT(*) n FROM meta_leads WHERE created_at >= ? GROUP BY status`, start);

  const byCampaign = many<{ campaign: string; leads: number; converted: number }>(
    `SELECT COALESCE(ml.campaign_name,'(unattributed)') campaign, COUNT(*) leads,
            SUM(CASE WHEN EXISTS (SELECT 1 FROM orders o WHERE o.company_id = ml.company_id AND o.status NOT IN ('cancelled','returned')) THEN 1 ELSE 0 END) converted
       FROM meta_leads ml WHERE ml.created_at >= ?
      GROUP BY campaign ORDER BY leads DESC LIMIT 10`, start);

  // Funnel comes from the CAPI event queue — the same stages we report to Meta.
  const funnel = many<{ event_name: string; n: number }>(
    `SELECT event_name, COUNT(DISTINCT meta_lead_id) n FROM meta_capi_events GROUP BY event_name`);

  const capi = many<{ status: string; n: number }>(
    `SELECT status, COUNT(*) n FROM meta_capi_events GROUP BY status`);

  // withLead counts the pre-switch deals too, so the tile doesn't appear to
  // collapse for leads that were pushed before ad leads moved to the inbox.
  const totals = one<{ total: number; withCompany: number; withLead: number }>(
    `SELECT COUNT(*) total,
            SUM(CASE WHEN company_id IS NOT NULL THEN 1 ELSE 0 END) withCompany,
            SUM(CASE WHEN pipedrive_lead_id IS NOT NULL OR pipedrive_deal_id IS NOT NULL THEN 1 ELSE 0 END) withLead
       FROM meta_leads WHERE created_at >= ?`, start);

  return NextResponse.json({
    ok: true,
    days,
    integration: { leadsConfigured: metaLeadsConfigured(), capiConfigured: metaCapiConfigured() },
    totals: totals ?? { total: 0, withCompany: 0, withLead: 0 },
    byStatus,
    byCampaign,
    funnel,
    capi,
    leads,
  });
}
