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
  opened: number;
  replied: number;
  bounced: number;
  meetings_booked: number;
  orders_placed: number;
  lead_count: number;
  created_at: string;
  updated_at: string;
}

interface Summary {
  active_campaigns: number;
  total_sent: number;
  avg_open_rate: number;
  avg_reply_rate: number;
}

async function getCampaigns() {
  const rows = sqlite.prepare(`
    SELECT c.*,
      (SELECT count(*) FROM campaign_leads cl WHERE cl.campaign_id = c.id) as lead_count
    FROM campaigns c
    ORDER BY c.created_at DESC
  `).all() as CampaignRow[];

  const summary = sqlite.prepare(`
    SELECT
      count(CASE WHEN status = 'active' THEN 1 END) as active_campaigns,
      coalesce(sum(sent), 0) as total_sent,
      CASE WHEN sum(sent) > 0 THEN round(cast(sum(opened) as real) / sum(sent) * 100, 1) ELSE 0 END as avg_open_rate,
      CASE WHEN sum(sent) > 0 THEN round(cast(sum(replied) as real) / sum(sent) * 100, 1) ELSE 0 END as avg_reply_rate
    FROM campaigns
  `).get() as Summary;

  return { campaigns: rows, summary };
}

export default async function CampaignsPage() {
  const { campaigns, summary } = await getCampaigns();
  return <CampaignDashboard campaigns={campaigns} summary={summary} />;
}
