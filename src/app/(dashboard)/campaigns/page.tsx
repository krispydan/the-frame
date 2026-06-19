export const dynamic = "force-dynamic";
/**
 * F3-004: Campaign List & Dashboard
 */
import { sqlite } from "@/lib/db";
import { CampaignDashboard } from "@/modules/sales/components/campaign-dashboard";

interface CampaignRow {
  id: string;
  name: string;
  type: string;
  status: string;
  description: string | null;
  instantly_campaign_id: string | null;
  sent: number;
  delivered: number;
  /** Kept on the row so /campaigns/[id] can show opens if it ever wants
   *  to, but NOT surfaced on the dashboard — Daniel doesn't track open
   *  rate because of deliverability concerns with open tracking. */
  opened: number;
  replied: number;
  bounced: number;
  lead_count: number;
  /** Distinct companies in this campaign that have placed ≥1 order. */
  orders_count: number;
  /** Sum of order totals across those companies (USD). */
  orders_total: number;
  created_at: string;
  updated_at: string;
}

interface Summary {
  active_campaigns: number;
  total_sent: number;
  avg_reply_rate: number;
}

async function getCampaigns() {
  // orders_count: distinct companies in this campaign with ≥1 order (any
  // status). orders_total: sum of order totals across those companies.
  // Joins through campaign_leads → orders by company_id. NULL-safe via
  // COALESCE so a campaign with no orders shows 0, not blank.
  const rows = sqlite.prepare(`
    SELECT c.*,
      (SELECT count(*) FROM campaign_leads cl WHERE cl.campaign_id = c.id) as lead_count,
      COALESCE((
        SELECT COUNT(DISTINCT cl.company_id)
          FROM campaign_leads cl
          JOIN orders o ON o.company_id = cl.company_id
         WHERE cl.campaign_id = c.id
      ), 0) as orders_count,
      COALESCE((
        SELECT SUM(o.total)
          FROM campaign_leads cl
          JOIN orders o ON o.company_id = cl.company_id
         WHERE cl.campaign_id = c.id
      ), 0) as orders_total
    FROM campaigns c
    ORDER BY c.created_at DESC
  `).all() as CampaignRow[];

  const summary = sqlite.prepare(`
    SELECT
      count(CASE WHEN status = 'active' THEN 1 END) as active_campaigns,
      coalesce(sum(sent), 0) as total_sent,
      CASE WHEN sum(sent) > 0 THEN round(cast(sum(replied) as real) / sum(sent) * 100, 1) ELSE 0 END as avg_reply_rate
    FROM campaigns
  `).get() as Summary;

  return { campaigns: rows, summary };
}

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams?: Promise<{ segment?: string }>;
}) {
  const params = await searchParams;
  const { campaigns, summary } = await getCampaigns();
  return (
    <CampaignDashboard
      campaigns={campaigns}
      summary={summary}
      initialSegmentFilter={params?.segment || "all"}
    />
  );
}
