export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { classification } = await req.json();

  sqlite.prepare("UPDATE campaign_leads SET reply_classification = ? WHERE id = ?").run(classification, id);

  // Update deal stage
  const stageMap: Record<string, string> = { interested: "interested", not_interested: "not_interested" };
  const newStage = stageMap[classification];
  if (newStage) {
    const lead = sqlite.prepare("SELECT company_id FROM campaign_leads WHERE id = ?").get(id) as { company_id: string } | undefined;
    if (lead) {
      sqlite.prepare("UPDATE deals SET stage = ?, previous_stage = stage, updated_at = datetime('now') WHERE company_id = ? AND stage IN ('outreach','contact_made')").run(newStage, lead.company_id);
    }
  }

  return NextResponse.json({ success: true });
}
