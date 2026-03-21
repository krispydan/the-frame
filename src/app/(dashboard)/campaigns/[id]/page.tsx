export const dynamic = "force-dynamic";
/**
 * F3-006: Campaign Detail + A/B Test Comparison + ICP Classification
 */
import { sqlite } from "@/lib/db";
import { notFound } from "next/navigation";
import { CampaignDetail } from "@/modules/sales/components/campaign-detail";

interface CampaignRow {
  id: string;
  name: string;
  type: string;
  status: string;
  description: string | null;
  instantly_campaign_id: string | null;
  target_segment: string | null;
  variant_a_subject: string | null;
  variant_b_subject: string | null;
  sent: number;
  delivered: number;
  opened: number;
  replied: number;
  bounced: number;
  meetings_booked: number;
  orders_placed: number;
  variant_a_sent: number;
  variant_a_opened: number;
  variant_a_replied: number;
  variant_b_sent: number;
  variant_b_opened: number;
  variant_b_replied: number;
  created_at: string;
  updated_at: string;
}

interface LeadRow {
  id: string;
  company_id: string;
  company_name: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  status: string;
  reply_text: string | null;
  reply_classification: string | null;
  sent_at: string | null;
  opened_at: string | null;
  replied_at: string | null;
  icp_tier: string | null;
  icp_score: number | null;
  icp_reasoning: string | null;
}

async function getCampaign(id: string) {
  const campaign = sqlite.prepare(`
    SELECT c.*,
      (SELECT count(*) FROM campaign_leads cl WHERE cl.campaign_id = c.id) as lead_count,
      (SELECT count(*) FROM campaign_leads cl WHERE cl.campaign_id = c.id AND cl.status = 'replied') as reply_count
    FROM campaigns c WHERE c.id = ?
  `).get(id) as (CampaignRow & { lead_count: number; reply_count: number }) | undefined;

  if (!campaign) return null;

  const leads = sqlite.prepare(`
    SELECT cl.id, cl.company_id, cl.email, cl.status, cl.reply_text, cl.reply_classification,
      cl.sent_at, cl.opened_at, cl.replied_at,
      co.name as company_name, co.icp_tier, co.icp_score, co.icp_reasoning,
      ct.first_name, ct.last_name
    FROM campaign_leads cl
    LEFT JOIN companies co ON co.id = cl.company_id
    LEFT JOIN contacts ct ON ct.id = cl.contact_id
    WHERE cl.campaign_id = ?
    ORDER BY cl.created_at DESC
    LIMIT 200
  `).all(id) as LeadRow[];

  return { ...campaign, leads };
}

export default async function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const campaign = await getCampaign(id);
  if (!campaign) notFound();
  return <CampaignDetail campaign={campaign} />;
}
