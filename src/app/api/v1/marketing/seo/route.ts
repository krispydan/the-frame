export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { seoKeywords } from "@/modules/marketing/schema";
import { desc, eq } from "drizzle-orm";

export async function GET() {
  try {
    const rows = db.select().from(seoKeywords).orderBy(desc(seoKeywords.searchVolume)).all();
    const ranked = rows.filter(r => r.currentRank != null);
    const improving = rows.filter(r => r.currentRank && r.previousRank && r.currentRank < r.previousRank).length;
    const declining = rows.filter(r => r.currentRank && r.previousRank && r.currentRank > r.previousRank).length;
    const avgRank = ranked.length > 0 ? Math.round(ranked.reduce((s, r) => s + (r.currentRank || 0), 0) / ranked.length) : 0;
    const inTop10 = ranked.filter(r => (r.currentRank || 999) <= 10).length;
    const inTop3 = ranked.filter(r => (r.currentRank || 999) <= 3).length;

    return NextResponse.json({
      data: rows,
      total: rows.length,
      summary: { improving, declining, avgRank, totalKeywords: rows.length, inTop10, inTop3 },
      contentPerformance: { pageViews: 12450, organicTraffic: 8320, bounceRate: 42.5, avgTimeOnPage: "2:34" },
      backlinks: { total: 234, newThisMonth: 18, dofollow: 189 },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { keyword, currentRank, searchVolume, difficulty, url } = body;
    if (!keyword) return NextResponse.json({ error: "keyword is required" }, { status: 400 });

    const id = crypto.randomUUID();
    db.insert(seoKeywords).values({
      id,
      keyword,
      currentRank: currentRank ? Number(currentRank) : null,
      previousRank: null,
      searchVolume: searchVolume ? Number(searchVolume) : null,
      difficulty: difficulty ? Number(difficulty) : null,
      url: url || null,
    }).run();

    return NextResponse.json({ id, keyword });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { id } = await req.json();
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    db.delete(seoKeywords).where(eq(seoKeywords.id, id)).run();
    return NextResponse.json({ deleted: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const { id, keyword, currentRank, searchVolume, difficulty, url } = body;
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

    // Move current rank to previous before updating
    const existing = db.select().from(seoKeywords).where(eq(seoKeywords.id, id)).get();
    if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

    db.update(seoKeywords).set({
      keyword: keyword ?? existing.keyword,
      previousRank: existing.currentRank,
      currentRank: currentRank !== undefined ? Number(currentRank) : existing.currentRank,
      searchVolume: searchVolume !== undefined ? Number(searchVolume) : existing.searchVolume,
      difficulty: difficulty !== undefined ? Number(difficulty) : existing.difficulty,
      url: url !== undefined ? url : existing.url,
    }).where(eq(seoKeywords.id, id)).run();

    return NextResponse.json({ updated: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
