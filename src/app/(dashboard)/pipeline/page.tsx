import { sqlite } from "@/lib/db";
import { PipelineBoard } from "@/modules/sales/components/pipeline-board";
import { DEAL_STAGES, DEAL_STAGE_LABELS } from "@/modules/sales/schema/pipeline";

interface DealRow {
  id: string;
  company_id: string;
  company_name: string;
  company_city: string;
  company_state: string;
  title: string;
  value: number | null;
  stage: string;
  channel: string | null;
  owner_id: string | null;
  snooze_until: string | null;
  snooze_reason: string | null;
  last_activity_at: string;
  created_at: string;
  reorder_due_at: string | null;
}

async function getDeals() {
  const rows = sqlite.prepare(`
    SELECT d.*, c.name as company_name, c.city as company_city, c.state as company_state
    FROM deals d
    LEFT JOIN companies c ON c.id = d.company_id
    ORDER BY d.last_activity_at DESC
  `).all() as DealRow[];
  return rows;
}

async function getCompaniesForSearch() {
  const rows = sqlite.prepare(`
    SELECT id, name, city, state FROM companies ORDER BY name LIMIT 500
  `).all() as { id: string; name: string; city: string; state: string }[];
  return rows;
}

async function getUsers() {
  const rows = sqlite.prepare(`SELECT id, name, email FROM users WHERE is_active = 1`).all();
  return rows as { id: string; name: string; email: string }[];
}

export default async function PipelinePage() {
  const [deals, companies, users] = await Promise.all([getDeals(), getCompaniesForSearch(), getUsers()]);

  // Build stage summaries
  const stageSummaries = DEAL_STAGES.map((stage) => {
    const stageDeals = deals.filter((d) => d.stage === stage);
    return {
      stage,
      label: DEAL_STAGE_LABELS[stage],
      count: stageDeals.length,
      totalValue: stageDeals.reduce((sum, d) => sum + (d.value || 0), 0),
    };
  });

  return (
    <div className="space-y-4">
      <PipelineBoard
        deals={deals}
        stageSummaries={stageSummaries}
        companies={companies}
        users={users}
      />
    </div>
  );
}
