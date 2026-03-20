import { NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

export async function GET() {
  // Get top states with counts
  const states = sqlite.prepare(`
    SELECT state, count(*) as count FROM companies 
    WHERE state IS NOT NULL AND state != '' 
    GROUP BY state ORDER BY count DESC LIMIT 30
  `).all() as { state: string; count: number }[];

  // Get statuses with counts
  const statuses = sqlite.prepare(`
    SELECT status, count(*) as count FROM companies 
    GROUP BY status ORDER BY count DESC
  `).all() as { status: string; count: number }[];

  // Get unique sources (pipe-separated, so we need to split)
  const sourceRows = sqlite.prepare(`
    SELECT DISTINCT source FROM companies WHERE source IS NOT NULL AND source != ''
  `).all() as { source: string }[];
  
  const sourceCounts: Record<string, number> = {};
  for (const row of sourceRows) {
    for (const s of row.source.split("|")) {
      const trimmed = s.trim();
      if (trimmed) sourceCounts[trimmed] = (sourceCounts[trimmed] || 0) + 1;
    }
  }
  const sources = Object.entries(sourceCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([source, count]) => ({ source, count }));

  // Get categories from tags
  const tagRows = sqlite.prepare(`
    SELECT tags FROM companies WHERE tags IS NOT NULL AND tags != '[]' LIMIT 50000
  `).all() as { tags: string }[];
  
  const catCounts: Record<string, number> = {};
  for (const row of tagRows) {
    try {
      const tags: string[] = JSON.parse(row.tags);
      if (tags[0]) catCounts[tags[0]] = (catCounts[tags[0]] || 0) + 1; // first tag is category
    } catch { /* skip */ }
  }
  const categories = Object.entries(catCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([category, count]) => ({ category, count }));

  // ICP score range
  const icpRange = sqlite.prepare(`
    SELECT min(icp_score) as min, max(icp_score) as max 
    FROM companies WHERE icp_score IS NOT NULL
  `).get() as { min: number; max: number };

  return NextResponse.json({ states, statuses, sources, categories, icpRange });
}
