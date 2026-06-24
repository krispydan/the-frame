/**
 * POST /api/v1/marketing/email/plan-month/revise
 *
 * Revise a SINGLE proposed brief from natural-language operator
 * feedback, before any campaigns are created. Used by the planner's
 * per-card "Suggest changes" control.
 *
 * Body: {
 *   audience: "retail" | "wholesale",
 *   scheduledDate: "YYYY-MM-DD",
 *   slotContext?: string,
 *   current: { name, angle, productHook?, seasonalContext? },
 *   feedback: string            // the operator's natural-language ask
 * }
 *
 * Returns: { ok, brief: { name, angle, productHook, seasonalContext, rationale } }
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { reviseBrief } from "@/modules/marketing/lib/email-ai";
import { getCalendarContextForCampaign } from "@/modules/marketing/lib/calendar-context";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      audience?: string;
      scheduledDate?: string;
      slotContext?: string;
      current?: { name?: string; angle?: string; productHook?: string | null; seasonalContext?: string | null };
      feedback?: string;
    };

    if (body.audience !== "retail" && body.audience !== "wholesale") {
      return NextResponse.json({ error: "audience must be 'retail' or 'wholesale'" }, { status: 400 });
    }
    if (!body.scheduledDate || !/^\d{4}-\d{2}-\d{2}$/.test(body.scheduledDate)) {
      return NextResponse.json({ error: "scheduledDate (YYYY-MM-DD) required" }, { status: 400 });
    }
    if (!body.feedback || !body.feedback.trim()) {
      return NextResponse.json({ error: "feedback required" }, { status: 400 });
    }
    if (!body.current || (!body.current.name && !body.current.angle)) {
      return NextResponse.json({ error: "current brief required" }, { status: 400 });
    }

    const calendarEvents = await getCalendarContextForCampaign({
      scheduledDate: body.scheduledDate,
      audience: body.audience,
    });

    const result = await reviseBrief({
      audience: body.audience,
      scheduledDate: body.scheduledDate,
      slotContext: body.slotContext ?? null,
      calendarEvents,
      current: {
        name: body.current.name ?? "",
        angle: body.current.angle ?? "",
        productHook: body.current.productHook ?? null,
        seasonalContext: body.current.seasonalContext ?? null,
      },
      feedback: body.feedback,
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 502 });
    }
    return NextResponse.json({ ok: true, brief: result.output, usage: result.usage });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[plan-month/revise] unhandled:", e);
    return NextResponse.json({ error: `Server error: ${message}` }, { status: 500 });
  }
}
