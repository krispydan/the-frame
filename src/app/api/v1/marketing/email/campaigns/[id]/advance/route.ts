export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { db, sqlite } from "@/lib/db";
import { emailCampaigns } from "@/modules/marketing/schema";
import { eq } from "drizzle-orm";
import {
  STATUS_ORDER,
  type Status,
  statusIndex,
  gateFor,
  nextStatus,
  prevStatus,
} from "@/modules/marketing/lib/workflow";

/**
 * POST /api/v1/marketing/email/campaigns/[id]/advance
 *
 * Body (all optional):
 *   direction: "forward" | "back"  (default "forward")
 *   to:        an explicit target status (overrides direction)
 *   force:     boolean — skip gate validation (manual override)
 *
 * Forward moves validate the gate for the target stage and return
 * { ok:false, blocked:[...] } if requirements aren't met. Backward
 * moves are always allowed (fixing mistakes). Returns the updated row.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: { direction?: "forward" | "back"; to?: string; force?: boolean } = {};
  try { body = await req.json(); } catch { /* empty body fine */ }

  const [campaign] = await db
    .select()
    .from(emailCampaigns)
    .where(eq(emailCampaigns.id, id))
    .limit(1);
  if (!campaign) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const current = campaign.status;
  let target: Status | null;
  if (body.to) {
    if (!(STATUS_ORDER as readonly string[]).includes(body.to)) {
      return NextResponse.json({ error: `Unknown status "${body.to}"` }, { status: 400 });
    }
    target = body.to as Status;
  } else if (body.direction === "back") {
    target = prevStatus(current);
  } else {
    target = nextStatus(current);
  }

  if (!target) {
    return NextResponse.json({ error: "No further status in that direction.", status: current });
  }

  const movingForward = statusIndex(target) > statusIndex(current);
  let blocked: string[] = [];
  if (movingForward && !body.force) {
    blocked = gateFor(target, campaign as never);
  }
  if (blocked.length > 0) {
    return NextResponse.json({ ok: false, status: current, target, blocked });
  }

  sqlite
    .prepare(
      `UPDATE marketing_email_campaigns SET status = ?, updated_at = datetime('now') WHERE id = ?`,
    )
    .run(target, id);

  const [updated] = await db
    .select()
    .from(emailCampaigns)
    .where(eq(emailCampaigns.id, id))
    .limit(1);

  return NextResponse.json({ ok: true, status: target, campaign: updated });
}
