/**
 * Manual ad-campaign spend tracking (Google/Meta/TikTok rollups typed in
 * by hand). Moved here from /api/v1/marketing/ads when the Ad Studio
 * (creative generation) took over that path — same handlers, new URL.
 */
export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { adCampaigns } from "@/modules/marketing/schema";
import { eq } from "drizzle-orm";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const row = db.select().from(adCampaigns).where(eq(adCampaigns.id, id)).get();
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ data: row });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body = await req.json();
    db.update(adCampaigns).set(body).where(eq(adCampaigns.id, id)).run();
    const row = db.select().from(adCampaigns).where(eq(adCampaigns.id, id)).get();
    return NextResponse.json({ data: row });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  db.delete(adCampaigns).where(eq(adCampaigns.id, id)).run();
  return NextResponse.json({ success: true });
}
