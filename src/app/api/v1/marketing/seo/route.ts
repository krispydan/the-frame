export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { seoKeywords } from "@/modules/marketing/schema";
import { desc } from "drizzle-orm";

export async function GET() {
  try {
    const rows = db.select().from(seoKeywords).orderBy(desc(seoKeywords.searchVolume)).all();
    const improving = rows.filter(r => r.currentRank && r.previousRank && r.currentRank < r.previousRank).length;
    const declining = rows.filter(r => r.currentRank && r.previousRank && r.currentRank > r.previousRank).length;
    const avgRank = rows.length > 0 ? Math.round(rows.reduce((s, r) => s + (r.currentRank || 0), 0) / rows.length) : 0;

    return NextResponse.json({
      data: rows,
      total: rows.length,
      summary: { improving, declining, avgRank, totalKeywords: rows.length },
      // Placeholder metrics
      contentPerformance: {
        pageViews: 12450,
        organicTraffic: 8320,
        bounceRate: 42.5,
        avgTimeOnPage: "2:34",
      },
      backlinks: { total: 234, newThisMonth: 18, dofollow: 189 },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
