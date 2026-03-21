export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { classifyReply } from "@/modules/sales/agents/response-classifier";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();

  // Handle dismiss action
  if (body.dismiss) {
    sqlite.prepare("UPDATE campaign_leads SET dismissed = 1 WHERE id = ?").run(id);
    return NextResponse.json({ success: true, dismissed: true });
  }

  // Auto-classify using the agent
  if (body.auto) {
    const lead = sqlite.prepare("SELECT reply_text FROM campaign_leads WHERE id = ?").get(id) as { reply_text: string | null } | undefined;
    if (!lead?.reply_text) {
      return NextResponse.json({ error: "No reply text to classify" }, { status: 400 });
    }
    const result = classifyReply(lead.reply_text);
    sqlite.prepare("UPDATE campaign_leads SET reply_classification = ? WHERE id = ?").run(result.classification, id);
    updateDealStage(id, result.classification);
    return NextResponse.json({ success: true, classification: result.classification, confidence: result.confidence });
  }

  // Manual classification
  const { classification } = body;
  if (!classification) {
    return NextResponse.json({ error: "classification required" }, { status: 400 });
  }

  sqlite.prepare("UPDATE campaign_leads SET reply_classification = ? WHERE id = ?").run(classification, id);
  updateDealStage(id, classification);

  return NextResponse.json({ success: true, classification });
}

function updateDealStage(campaignLeadId: string, classification: string) {
  const stageMap: Record<string, string> = {
    interested: "interested",
    not_interested: "not_interested",
  };
  const newStage = stageMap[classification];
  if (newStage) {
    const lead = sqlite.prepare("SELECT company_id FROM campaign_leads WHERE id = ?").get(campaignLeadId) as { company_id: string } | undefined;
    if (lead) {
      sqlite.prepare(
        "UPDATE deals SET stage = ?, previous_stage = stage, updated_at = datetime('now') WHERE company_id = ? AND stage IN ('outreach','contact_made')"
      ).run(newStage, lead.company_id);
    }
  }
}
