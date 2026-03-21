import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { contentCalendar } from "@/modules/marketing/schema";
import { eq, desc, and, like, sql } from "drizzle-orm";

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const status = url.searchParams.get("status");
  const platform = url.searchParams.get("platform");
  const type = url.searchParams.get("type");
  const search = url.searchParams.get("search") || "";

  try {
    const conditions: ReturnType<typeof eq>[] = [];
    if (status) conditions.push(eq(contentCalendar.status, status as any));
    if (platform) conditions.push(eq(contentCalendar.platform, platform as any));
    if (type) conditions.push(eq(contentCalendar.type, type as any));
    if (search) conditions.push(like(contentCalendar.title, `%${search}%`));

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const rows = db.select().from(contentCalendar).where(where).orderBy(desc(contentCalendar.scheduledDate)).all();
    return NextResponse.json({ data: rows, total: rows.length });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const id = crypto.randomUUID();
    db.insert(contentCalendar).values({ id, ...body }).run();
    const row = db.select().from(contentCalendar).where(eq(contentCalendar.id, id)).get();
    return NextResponse.json({ data: row }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
