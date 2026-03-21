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
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  db.delete(adCampaigns).where(eq(adCampaigns.id, id)).run();
  return NextResponse.json({ success: true });
}
