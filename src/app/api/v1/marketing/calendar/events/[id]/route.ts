/**
 * GET    /api/v1/marketing/calendar/events/[id]
 * PATCH  /api/v1/marketing/calendar/events/[id]
 * DELETE /api/v1/marketing/calendar/events/[id]
 */

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { db, sqlite } from "@/lib/db";
import { calendarEvents } from "@/modules/marketing/schema";
import { eq } from "drizzle-orm";

const PATCHABLE = new Set([
  "eventType",
  "dateStart",
  "dateEnd",
  "audience",
  "title",
  "description",
  "productSkus",
  "linkUrl",
  "priority",
  "tag",
]);

const KEY_TO_COL: Record<string, string> = {
  eventType: "event_type",
  dateStart: "date_start",
  dateEnd: "date_end",
  audience: "audience",
  title: "title",
  description: "description",
  productSkus: "product_skus",
  linkUrl: "link_url",
  priority: "priority",
  tag: "tag",
};

const VALID_TYPES = ["holiday", "sale", "launch", "promotion"];
const VALID_AUDIENCES = ["all", "retail", "wholesale"];

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [event] = await db.select().from(calendarEvents).where(eq(calendarEvents.id, id)).limit(1);
  if (!event) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ event });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: "JSON required" }, { status: 400 }); }

  // Enum validation
  if ("eventType" in body && (typeof body.eventType !== "string" || !VALID_TYPES.includes(body.eventType))) {
    return NextResponse.json({ error: `eventType must be one of: ${VALID_TYPES.join(", ")}` }, { status: 400 });
  }
  if ("audience" in body && (typeof body.audience !== "string" || !VALID_AUDIENCES.includes(body.audience))) {
    return NextResponse.json({ error: `audience must be one of: ${VALID_AUDIENCES.join(", ")}` }, { status: 400 });
  }
  for (const k of ["dateStart", "dateEnd"]) {
    if (k in body && typeof body[k] === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(body[k] as string)) {
      return NextResponse.json({ error: `${k} must be YYYY-MM-DD` }, { status: 400 });
    }
  }

  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [key, val] of Object.entries(body)) {
    if (!PATCHABLE.has(key)) continue;
    const col = KEY_TO_COL[key];
    if (!col || !/^[a-z][a-z0-9_]*$/.test(col)) continue;
    sets.push(`${col} = ?`);
    vals.push(val);
  }
  if (sets.length === 0) {
    const [event] = await db.select().from(calendarEvents).where(eq(calendarEvents.id, id)).limit(1);
    if (!event) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ event });
  }
  sets.push(`updated_at = datetime('now')`);
  vals.push(id);
  const result = sqlite
    .prepare(`UPDATE marketing_calendar_events SET ${sets.join(", ")} WHERE id = ?`)
    .run(...vals);
  if (result.changes === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const [event] = await db.select().from(calendarEvents).where(eq(calendarEvents.id, id)).limit(1);
  return NextResponse.json({ event });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = sqlite.prepare(`DELETE FROM marketing_calendar_events WHERE id = ?`).run(id);
  if (result.changes === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true, id });
}
