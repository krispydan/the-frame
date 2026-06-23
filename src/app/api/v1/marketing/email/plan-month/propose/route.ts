/**
 * POST /api/v1/marketing/email/plan-month/propose
 *
 * Body: { audience: "retail" | "wholesale", startDate: ISO, weeks: number }
 *
 * Walks the strategy engine for the given window, loads calendar
 * events overlapping that range, and asks Claude to propose one
 * BRIEF per slot. Returns the proposals + the resolved slot
 * dimensions side-by-side so the user can review before accepting.
 *
 * This endpoint does NOT create campaigns — just proposes. The
 * /create endpoint takes the user-approved briefs and bulk-inserts.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 90;

import { NextRequest, NextResponse } from "next/server";
import { planMonth } from "@/modules/marketing/lib/email-ai";
import { getCalendarContextForRange, loadEventsInRange } from "@/modules/marketing/lib/calendar-context";
import { recommendForWeeks } from "@/modules/marketing/lib/email-strategy";

function plusDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function POST(req: NextRequest) {
  try {
    let body: { audience?: string; startDate?: string; weeks?: number } = {};
    try { body = await req.json(); } catch {}

    if (body.audience !== "retail" && body.audience !== "wholesale") {
      return NextResponse.json({ error: "audience must be 'retail' or 'wholesale'" }, { status: 400 });
    }
    if (!body.startDate || !/^\d{4}-\d{2}-\d{2}$/.test(body.startDate)) {
      return NextResponse.json({ error: "startDate (YYYY-MM-DD) required" }, { status: 400 });
    }
    const weeks = Number(body.weeks ?? 4);
    if (!Number.isFinite(weeks) || weeks < 1 || weeks > 12) {
      return NextResponse.json({ error: "weeks must be 1–12" }, { status: 400 });
    }

    const audience = body.audience as "retail" | "wholesale";

    // Walk the strategy engine for the window. Returns 2 slots per
    // week (Mon + Thu for retail, Tue + Fri for wholesale) with
    // layout/image/angle dimensions pre-assigned for visual variety.
    const slots = recommendForWeeks(audience, body.startDate, weeks);
    if (slots.length === 0) {
      return NextResponse.json({ error: "Strategy engine returned no slots" }, { status: 500 });
    }

    // Date range = first slot to last slot (inclusive).
    const startDate = slots[0].scheduledDate;
    const endDate = plusDays(slots[slots.length - 1].scheduledDate, 1);

    const calendarEvents = await getCalendarContextForRange({
      startDate, endDate, audience,
    });
    const rawEvents = await loadEventsInRange({ startDate, endDate, audience });

    const aiResult = await planMonth({
      audience,
      startDate,
      endDate,
      slots: slots.map(s => ({
        date: s.scheduledDate,
        slotInWeek: s.slotInWeek,
        layoutProfile: s.layoutProfile,
        imageStyle: s.imageStyle,
        subjectAngle: s.subjectAngle,
      })),
      calendarEvents,
    });

    if (!aiResult.ok) {
      return NextResponse.json({ error: aiResult.error }, { status: 502 });
    }

    const briefs = (aiResult.output as { briefs?: Array<unknown> }).briefs ?? [];
    if (briefs.length !== slots.length) {
      return NextResponse.json({
        error: `AI returned ${briefs.length} briefs but ${slots.length} slots were requested. Try again.`,
      }, { status: 502 });
    }

    // Zip briefs with their slot dimensions so the UI can render
    // a unified review table.
    const proposals = slots.map((slot, i) => {
      const brief = briefs[i] as Record<string, string>;
      return {
        slotIndex: i,
        scheduledDate: slot.scheduledDate,
        slotInWeek: slot.slotInWeek,
        weekOf: slot.weekOf,
        layoutProfile: slot.layoutProfile,
        imageStyle: slot.imageStyle,
        subjectAngle: slot.subjectAngle,
        layoutVariants: slot.layoutVariants,
        rationale: slot.rationale,
        brief: {
          name: brief.name ?? "",
          angle: brief.angle ?? "",
          productHook: brief.productHook ?? "",
          seasonalContext: brief.seasonalContext ?? "",
          rationale: brief.rationale ?? "",
        },
      };
    });

    return NextResponse.json({
      ok: true,
      audience,
      window: { startDate, endDate, weeks },
      eventsConsidered: rawEvents.length,
      proposals,
      usage: aiResult.usage,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[plan-month/propose] unhandled:", e);
    return NextResponse.json({ error: `Server error: ${message}` }, { status: 500 });
  }
}
