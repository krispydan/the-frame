import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { influencers } from "@/modules/marketing/schema";
import { eq, desc, and } from "drizzle-orm";

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const platform = url.searchParams.get("platform");
  const status = url.searchParams.get("status");

  try {
    const conditions: ReturnType<typeof eq>[] = [];
    if (platform) conditions.push(eq(influencers.platform, platform as any));
    if (status) conditions.push(eq(influencers.status, status as any));

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const rows = db.select().from(influencers).where(where).orderBy(desc(influencers.createdAt)).all();
    return NextResponse.json({ data: rows, total: rows.length });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const id = crypto.randomUUID();
    db.insert(influencers).values({ id, ...body }).run();
    const row = db.select().from(influencers).where(eq(influencers.id, id)).get();
    return NextResponse.json({ data: row }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
