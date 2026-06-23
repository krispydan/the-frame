/**
 * GET  /api/v1/marketing/calendar/events
 *   Query params:
 *     from        ISO date (default = today)
 *     to          ISO date (default = today + 90 days)
 *     audience    all | retail | wholesale (default = all)
 *     event_type  optional filter
 *
 *   Returns: { events: CalendarEvent[] } sorted by date_start ASC.
 *
 * POST /api/v1/marketing/calendar/events
 *   Body: { eventType, dateStart, dateEnd?, audience?, title, description?,
 *           productSkus?, linkUrl?, priority?, tag? }
 *   Returns: { event }
 */

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { calendarEvents } from "@/modules/marketing/schema";
import { and, asc, eq, gte, lte } from "drizzle-orm";

const VALID_TYPES = ["holiday", "sale", "launch", "promotion"] as const;
const VALID_AUDIENCES = ["all", "retail", "wholesale"] as const;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
function plusDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const from = url.searchParams.get("from") ?? today();
  const to = url.searchParams.get("to") ?? plusDays(from, 90);
  const audience = url.searchParams.get("audience") as typeof VALID_AUDIENCES[number] | null;
  const eventType = url.searchParams.get("event_type") as typeof VALID_TYPES[number] | null;

  // Overlap check: an event overlaps the window when its dateStart <= to
  // AND its dateEnd >= from. We can't predicate-push a single column,
  // so we filter post-query in JS for the type/audience narrowing too —
  // table will be small (< 1k rows for the foreseeable future).
  const all = await db
    .select()
    .from(calendarEvents)
    .where(
      and(
        lte(calendarEvents.dateStart, to),
        gte(calendarEvents.dateEnd, from),
      ),
    )
    .orderBy(asc(calendarEvents.dateStart));

  const filtered = all.filter(e => {
    if (eventType && e.eventType !== eventType) return false;
    if (audience && audience !== "all" && e.audience !== "all" && e.audience !== audience) return false;
    return true;
  });

  return NextResponse.json({ events: filtered, summary: {
    total: filtered.length,
    byType: filtered.reduce<Record<string, number>>((acc, e) => {
      acc[e.eventType] = (acc[e.eventType] ?? 0) + 1;
      return acc;
    }, {}),
  } });
}

export async function POST(req: NextRequest) {
  let body: {
    eventType?: string;
    dateStart?: string;
    dateEnd?: string;
    audience?: string;
    title?: string;
    description?: string;
    productSkus?: string;
    linkUrl?: string;
    priority?: number;
    tag?: string;
  } = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: "JSON required" }, { status: 400 }); }

  if (!body.eventType || !VALID_TYPES.includes(body.eventType as never)) {
    return NextResponse.json({ error: `eventType must be one of: ${VALID_TYPES.join(", ")}` }, { status: 400 });
  }
  if (!body.dateStart || !/^\d{4}-\d{2}-\d{2}$/.test(body.dateStart)) {
    return NextResponse.json({ error: "dateStart (YYYY-MM-DD) required" }, { status: 400 });
  }
  if (body.dateEnd && !/^\d{4}-\d{2}-\d{2}$/.test(body.dateEnd)) {
    return NextResponse.json({ error: "dateEnd must be YYYY-MM-DD" }, { status: 400 });
  }
  if (body.audience && !VALID_AUDIENCES.includes(body.audience as never)) {
    return NextResponse.json({ error: `audience must be one of: ${VALID_AUDIENCES.join(", ")}` }, { status: 400 });
  }
  if (!body.title || body.title.trim().length === 0) {
    return NextResponse.json({ error: "title required" }, { status: 400 });
  }

  const id = crypto.randomUUID();
  await db.insert(calendarEvents).values({
    id,
    eventType: body.eventType as typeof VALID_TYPES[number],
    dateStart: body.dateStart,
    dateEnd: body.dateEnd ?? body.dateStart,
    audience: (body.audience ?? "all") as typeof VALID_AUDIENCES[number],
    title: body.title.trim(),
    description: body.description ?? null,
    productSkus: body.productSkus ?? null,
    linkUrl: body.linkUrl ?? null,
    priority: body.priority ?? 2,
    tag: body.tag ?? null,
  });

  const [event] = await db.select().from(calendarEvents).where(eq(calendarEvents.id, id)).limit(1);
  return NextResponse.json({ event });
}
