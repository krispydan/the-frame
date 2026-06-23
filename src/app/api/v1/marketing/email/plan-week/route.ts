export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { planWeeks } from "@/modules/marketing/lib/plan-week";

/**
 * POST /api/v1/marketing/email/plan-week
 *
 * Body: { audience, weekStart?, weeks?, createCampaigns? }
 *
 * Self-serve planning (the same engine the MCP plan_week tool uses):
 * generates themes + seeds campaign slots on the cadence with per-slot
 * briefs + strategy-driven variant layouts.
 */
export async function POST(req: NextRequest) {
  let body: {
    audience?: "retail" | "wholesale";
    weekStart?: string;
    weeks?: number;
    createCampaigns?: boolean;
  } = {};
  try { body = await req.json(); } catch { /* empty body fine */ }

  if (body.audience !== "retail" && body.audience !== "wholesale") {
    return NextResponse.json({ error: "audience must be 'retail' or 'wholesale'" }, { status: 400 });
  }

  const result = await planWeeks({
    audience: body.audience,
    weekStart: body.weekStart,
    weeks: body.weeks,
    createCampaigns: body.createCampaigns,
  });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 });
  return NextResponse.json(result);
}
