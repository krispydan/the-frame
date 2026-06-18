export const dynamic = "force-dynamic";
export const maxDuration = 600;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { buildCustomVariables } from "@/modules/sales/lib/instantly-sync";
import { instantlyClient } from "@/modules/sales/lib/instantly-client";

/**
 * POST /api/admin/sales/sync-instantly-chunk
 *
 * Chunked, resumable Instantly push. Each call processes up to `limit`
 * queued campaign_leads rows: POSTs each to Instantly's /leads endpoint,
 * then writes the returned id back to campaign_leads.instantly_lead_id
 * *immediately* — so even if the handler dies mid-loop, prior leads
 * are persisted.
 *
 * This is the fix for the v1 boutique push: the existing handleSyncRequest
 * sends 8,547 leads via 8,547 sequential POSTs and only writes
 * instantly_lead_id after ALL of them complete (~140 min). If anything
 * interrupts the handler, all progress is lost. This endpoint writes
 * after each POST so we never lose more than 1 lead's worth of work.
 *
 * Loop it client-side until `remaining` hits 0:
 *
 *   while true; do
 *     out=$(curl ... -d '{"campaignId":"...","limit":300}')
 *     echo "$out" | jq .counts
 *     [ $(echo "$out" | jq -r .counts.remaining) -eq 0 ] && break
 *   done
 *
 * Body:
 *   { campaignId: string, limit?: number, dryRun?: boolean }
 *
 * Auth: x-admin-key: jaxy2026
 */

interface LeadRow {
  id: string;
  email: string;
  company_id: string | null;
  contact_id: string | null;
  company_name: string | null;
  website: string | null;
  domain: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  industry: string | null;
  category: string | null;
  segment: string | null;
  icp_tier: string | null;
  icp_score: number | null;
  ecom_platform: string | null;
  employee_count: number | null;
  estimated_yearly_sales_cents: number | null;
  estimated_monthly_visits: number | null;
  instagram_url: string | null;
  facebook_url: string | null;
  tiktok_url: string | null;
  description: string | null;
  meta_description: string | null;
  top_brand: string | null;
  eyewear_categories: string | null;
  eyewear_price_range: string | null;
  eyewear_top_competitors: string | null;
  ai_opener_email1: string | null;
  ai_opener_email2: string | null;
  first_name: string | null;
  last_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  contact_title: string | null;
}

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { campaignId?: string; limit?: number; dryRun?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body OK */
  }
  if (!body.campaignId) {
    return NextResponse.json({ error: "campaignId required" }, { status: 400 });
  }
  const limit = Math.max(1, Math.min(1000, body.limit ?? 300));
  const dryRun = body.dryRun === true;

  const campaign = sqlite
    .prepare(
      "SELECT id, instantly_campaign_id FROM campaigns WHERE id = ? LIMIT 1",
    )
    .get(body.campaignId) as
    | { id: string; instantly_campaign_id: string | null }
    | undefined;
  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }
  if (!campaign.instantly_campaign_id) {
    return NextResponse.json(
      { error: "Campaign not synced to Instantly (no instantly_campaign_id)" },
      { status: 400 },
    );
  }

  const leads = sqlite
    .prepare(
      `
      SELECT cl.id, cl.email, cl.company_id, cl.contact_id,
             co.name      as company_name,
             co.website   as website,
             co.domain    as domain,
             co.city      as city,
             co.state     as state,
             co.country   as country,
             co.industry  as industry,
             co.category  as category,
             co.segment   as segment,
             co.icp_tier  as icp_tier,
             co.icp_score as icp_score,
             co.ecom_platform                as ecom_platform,
             co.employee_count               as employee_count,
             co.estimated_yearly_sales_cents as estimated_yearly_sales_cents,
             co.estimated_monthly_visits     as estimated_monthly_visits,
             co.instagram_url                as instagram_url,
             co.facebook_url                 as facebook_url,
             co.tiktok_url                   as tiktok_url,
             co.description                  as description,
             co.meta_description             as meta_description,
             co.top_brand                    as top_brand,
             co.eyewear_categories           as eyewear_categories,
             co.eyewear_price_range          as eyewear_price_range,
             co.eyewear_top_competitors      as eyewear_top_competitors,
             co.ai_opener_email1             as ai_opener_email1,
             co.ai_opener_email2             as ai_opener_email2,
             ct.first_name,
             ct.last_name,
             ct.email     as contact_email,
             ct.phone     as contact_phone,
             ct.title     as contact_title
        FROM campaign_leads cl
        LEFT JOIN companies co ON co.id = cl.company_id
        LEFT JOIN contacts  ct ON ct.id = cl.contact_id
       WHERE cl.campaign_id = ?
         AND cl.instantly_lead_id IS NULL
         AND cl.email IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM campaign_leads cl2
            WHERE cl2.id != cl.id
              AND LOWER(cl2.email) = LOWER(cl.email)
              AND cl2.instantly_lead_id IS NOT NULL
         )
       ORDER BY cl.created_at
       LIMIT ?
      `,
    )
    .all(campaign.id, limit) as LeadRow[];

  const remainingBefore = (
    sqlite
      .prepare(
        "SELECT COUNT(*) AS n FROM campaign_leads WHERE campaign_id = ? AND instantly_lead_id IS NULL AND email IS NOT NULL",
      )
      .get(campaign.id) as { n: number }
  ).n;

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      counts: { remainingBefore, batchSize: leads.length },
      sample: leads.slice(0, 5).map((l) => ({
        cl_id: l.id,
        email: l.email,
        company: l.company_name,
      })),
    });
  }

  const updateOk = sqlite.prepare(
    "UPDATE campaign_leads SET instantly_lead_id = ?, status = 'sent' WHERE id = ?",
  );

  let pushed = 0;
  let errored = 0;
  const errors: Array<{ email: string; error: string }> = [];

  for (const l of leads) {
    const email = (l.email || l.contact_email) as string;
    if (!email) {
      errored++;
      errors.push({ email: "(null)", error: "no email" });
      continue;
    }
    try {
      // addLeadsToCampaign loops internally but we call it 1-at-a-time
      // so the DB write happens immediately after each successful POST.
      // Resumability guarantee: even if the handler dies after lead N,
      // leads 1..N-1 have their instantly_lead_id persisted.
      const res = await instantlyClient.addLeadsToCampaign(
        campaign.instantly_campaign_id!,
        [
          {
            email,
            first_name: l.first_name ?? undefined,
            last_name: l.last_name ?? undefined,
            company_name: l.company_name ?? undefined,
            phone: l.contact_phone ?? undefined,
            website: l.website ?? undefined,
            custom_variables: buildCustomVariables(
              l as unknown as Record<string, unknown>,
            ),
          },
        ],
      );
      const r = res.results[0];
      if (r?.id) {
        updateOk.run(r.id, l.id);
        pushed++;
      } else {
        errored++;
        errors.push({ email, error: r?.error ?? "no id returned" });
      }
    } catch (e) {
      errored++;
      const msg = e instanceof Error ? e.message : String(e);
      errors.push({ email, error: msg });
    }
  }

  const remainingAfter = Math.max(0, remainingBefore - pushed);

  return NextResponse.json({
    ok: true,
    counts: {
      processed: leads.length,
      pushed,
      errored,
      remainingBefore,
      remainingAfter,
    },
    errors: errors.slice(0, 10),
  });
}
