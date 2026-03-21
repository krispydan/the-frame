import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { adCampaigns } from "@/modules/marketing/schema";
import { eq, desc, and } from "drizzle-orm";

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const platform = url.searchParams.get("platform");
  const status = url.searchParams.get("status");

  try {
    const conditions: ReturnType<typeof eq>[] = [];
    if (platform) conditions.push(eq(adCampaigns.platform, platform as any));
    if (status) conditions.push(eq(adCampaigns.status, status as any));

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const rows = db.select().from(adCampaigns).where(where).orderBy(desc(adCampaigns.createdAt)).all();

    const totalSpend = rows.reduce((s, r) => s + (r.spend || 0), 0);
    const totalBudget = rows.reduce((s, r) => s + (r.monthlyBudget || 0), 0);
    const totalRevenue = rows.reduce((s, r) => s + (r.revenue || 0), 0);

    return NextResponse.json({ data: rows, total: rows.length, summary: { totalSpend, totalBudget, totalRevenue, roas: totalSpend > 0 ? totalRevenue / totalSpend : 0 } });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const id = crypto.randomUUID();
    db.insert(adCampaigns).values({ id, ...body }).run();
    const row = db.select().from(adCampaigns).where(eq(adCampaigns.id, id)).get();
    return NextResponse.json({ data: row }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
