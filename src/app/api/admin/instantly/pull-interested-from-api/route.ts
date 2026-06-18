export const dynamic = "force-dynamic";
export const maxDuration = 600;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { instantlyClient } from "@/modules/sales/lib/instantly-client";
import { resolveByEmail } from "@/modules/sales/lib/lead-resolution";
import { progressCompanyStatus } from "@/modules/sales/lib/status-progression";

/**
 * POST /api/admin/instantly/pull-interested-from-api
 *
 * Pulls every lead with a positive `interest_value` from Instantly's
 * API (across all our campaigns) and progresses the matching
 * companies.status to 'interested'. Sources historical classifications
 * Christina made BEFORE the webhook receiver was bootstrapped on
 * 2026-06-17 — those events never fired webhooks, so they're
 * invisible to the activity-feed backfill.
 *
 * Instantly's lt_interest_status scale (confirmed empirically against
 * a known-interested lead 2026-06-18):
 *   1  = Interested
 *   2  = Meeting Booked (often)
 *   3  = Closed / Sold
 *   -1 / -2 / -3 = Not Interested / Wrong Person / Lost
 *   0 / null = no classification yet
 *
 * The field key is `lt_interest_status` on the /leads/list response
 * (NOT `interest_value`, which is the write-side field on
 * /leads/update-interest-status). Anything >= 1 is "we want this on
 * the kanban as at least interested".
 *
 * progressCompanyStatus is forward-only: leads already at
 * catalog_sent / customer / etc. are not downgraded.
 *
 * Body (all optional):
 *   {
 *     campaignId?: string,  // restrict to one campaign (otherwise all)
 *     dryRun?: boolean      // default false
 *   }
 *
 * Auth: x-admin-key: jaxy2026
 */

interface CampaignRow {
  id: string;
  name: string;
  instantly_campaign_id: string;
}

interface ApiLeadSummary {
  email: string;
  interest_value: number | null;
}

function normalizeInterestValue(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Extract the interest classification from a lead row returned by
 * Instantly's POST /leads/list. The documented field is
 * `lt_interest_status` (per the OpenAPI spec) — our outbound
 * updateLeadInterestStatus call sends `interest_value` and Instantly
 * stores it as `lt_interest_status` on the lead. Some legacy code
 * paths surface it as `interest_value`; check both for safety.
 */
function extractInterest(raw: Record<string, unknown>): number | null {
  const candidates = [
    raw.lt_interest_status,
    raw.interest_value,
    raw.interest_status,
  ];
  for (const c of candidates) {
    const n = normalizeInterestValue(c);
    if (n !== null) return n;
  }
  return null;
}

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { campaignId?: string; dryRun?: boolean } = {};
  try {
    body = await req.json();
  } catch { /* empty body OK */ }
  const dryRun = body.dryRun === true;

  // Load every Instantly campaign we know about — or just one if specified.
  const campaignsQuery = body.campaignId
    ? sqlite.prepare(
        `SELECT id, name, instantly_campaign_id
           FROM campaigns
          WHERE instantly_campaign_id IS NOT NULL
            AND id = ?`,
      )
    : sqlite.prepare(
        `SELECT id, name, instantly_campaign_id
           FROM campaigns
          WHERE instantly_campaign_id IS NOT NULL`,
      );
  const campaigns = (body.campaignId
    ? campaignsQuery.all(body.campaignId)
    : campaignsQuery.all()) as CampaignRow[];

  if (campaigns.length === 0) {
    return NextResponse.json(
      { error: "No campaigns with instantly_campaign_id found" },
      { status: 404 },
    );
  }

  const summary = {
    ok: true,
    dry_run: dryRun,
    campaigns_walked: 0,
    api_leads_scanned: 0,
    interested_found: 0,
    progressed: 0,
    already_at_or_past: 0,
    unmatched: 0,
    by_interest_value: {} as Record<string, number>,
    per_campaign: [] as Array<{
      name: string;
      leads_scanned: number;
      interested_found: number;
      progressed: number;
    }>,
    sample_progressed: [] as Array<{
      email: string;
      interest_value: number;
      campaign: string;
      from: string | null;
    }>,
  };

  for (const camp of campaigns) {
    let leadsScanned = 0;
    let interestedFound = 0;
    let campProgressed = 0;

    let leads: Array<Record<string, unknown>> = [];
    try {
      leads = await instantlyClient.listLeadsInCampaign(camp.instantly_campaign_id);
    } catch (e) {
      console.error(`[pull-interested] listLeadsInCampaign ${camp.name}:`, e);
      summary.per_campaign.push({
        name: camp.name,
        leads_scanned: 0,
        interested_found: 0,
        progressed: 0,
      });
      continue;
    }

    leadsScanned = leads.length;
    summary.api_leads_scanned += leads.length;
    summary.campaigns_walked++;

    for (const raw of leads) {
      // The /leads/list response uses lt_interest_status. Fall back to
      // interest_value or interest_status for robustness in case the
      // API shape evolves.
      const interestValue = normalizeInterestValue(
        raw.lt_interest_status ?? raw.interest_value ?? raw.interest_status,
      );
      if (interestValue == null || interestValue < 1) continue;
      interestedFound++;

      const bucket = String(interestValue);
      summary.by_interest_value[bucket] =
        (summary.by_interest_value[bucket] ?? 0) + 1;

      const email = String(raw.email ?? "").trim();
      if (!email) {
        summary.unmatched++;
        continue;
      }

      const match = resolveByEmail({
        leadEmail: email,
        instantlyCampaignId: camp.instantly_campaign_id,
      });
      if (!match) {
        summary.unmatched++;
        continue;
      }

      if (dryRun) {
        const cur = sqlite
          .prepare("SELECT status FROM companies WHERE id = ?")
          .get(match.companyId) as { status: string | null } | undefined;
        const wouldProgress = !cur?.status ||
          ["prospect", "qualified_lead"].includes(cur.status);
        if (wouldProgress) {
          summary.progressed++;
          campProgressed++;
          if (summary.sample_progressed.length < 15) {
            summary.sample_progressed.push({
              email,
              interest_value: interestValue,
              campaign: camp.name,
              from: cur?.status ?? null,
            });
          }
        } else {
          summary.already_at_or_past++;
        }
        continue;
      }

      try {
        const result = progressCompanyStatus(match.companyId, "interested", {
          source: "instantly",
        });
        if (result.updated) {
          summary.progressed++;
          campProgressed++;
          if (summary.sample_progressed.length < 15) {
            summary.sample_progressed.push({
              email,
              interest_value: interestValue,
              campaign: camp.name,
              from: result.from,
            });
          }
        } else {
          summary.already_at_or_past++;
        }
      } catch (e) {
        console.error("[pull-interested] progressCompanyStatus failed:", e);
      }
    }

    summary.interested_found += interestedFound;
    summary.per_campaign.push({
      name: camp.name,
      leads_scanned: leadsScanned,
      interested_found: interestedFound,
      progressed: campProgressed,
    });
  }

  return NextResponse.json(summary);
}
