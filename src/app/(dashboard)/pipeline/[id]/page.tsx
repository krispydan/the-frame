export const dynamic = "force-dynamic";
import { sqlite } from "@/lib/db";
import { notFound } from "next/navigation";
import { DealDetail } from "@/modules/sales/components/deal-detail";

async function getDeal(id: string) {
  const deal = sqlite.prepare(`
    SELECT d.*, c.name as company_name, c.city as company_city, c.state as company_state,
           c.email as company_email, c.phone as company_phone, c.website as company_website,
           c.icp_tier, c.icp_score
    FROM deals d
    LEFT JOIN companies c ON c.id = d.company_id
    WHERE d.id = ?
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  `).get(id) as any;
  return deal;
}

async function getActivities(dealId: string) {
  return sqlite.prepare(`
    SELECT * FROM deal_activities WHERE deal_id = ? ORDER BY created_at DESC
  `).all(dealId) as Record<string, unknown>[];
}

async function getContacts(companyId: string) {
  return sqlite.prepare(`
    SELECT * FROM contacts WHERE company_id = ? ORDER BY is_primary DESC
  `).all(companyId) as Record<string, unknown>[];
}

async function getUsers() {
  return sqlite.prepare(`SELECT id, name FROM users WHERE is_active = 1`).all() as { id: string; name: string }[];
}

export default async function DealDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [deal, activities, users] = await Promise.all([getDeal(id), getActivities(id), getUsers()]);
  if (!deal) notFound();

  const contacts = await getContacts(deal.company_id as string);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return <DealDetail deal={deal as any} activities={activities} contacts={contacts as any[]} users={users} />;
}
