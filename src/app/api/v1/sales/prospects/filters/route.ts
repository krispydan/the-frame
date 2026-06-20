export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { INDUSTRY_DISPLAY, type Industry } from "@/modules/sales/lib/industry-mapping";

/**
 * Filter options for /prospects.
 *
 * Cleanup history (May 2026):
 *  - REPLACED  `categories` (317 distinct raw tag values) with `industries`
 *              (16 curated buckets from industry-mapping.ts)
 *  - REINTRODUCED `segments` after JAX-355 so the review queue and prospect
 *                 views can filter on the structured segment model again
 *  - REMOVED   `sourceIds` (32K+ near-unique values, unusable as a filter)
 *  - RENAMED   `companyCategories` → `productsCarried` to disambiguate from
 *              the industry filter
 */
export async function GET() {
  // Top states with counts
  const states = sqlite.prepare(`
    SELECT state, count(*) as count FROM companies
    WHERE state IS NOT NULL AND state != ''
    GROUP BY state ORDER BY count DESC LIMIT 30
  `).all() as { state: string; count: number }[];

  // Statuses with counts
  const statuses = sqlite.prepare(`
    SELECT status, count(*) as count FROM companies
    GROUP BY status ORDER BY count DESC
  `).all() as { status: string; count: number }[];

  // Unique sources (pipe-separated, split them)
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

  // ── Curated industry buckets ──
  // Joined with INDUSTRY_DISPLAY metadata so the UI can show label + tier
  // without duplicating that config.
  const industryCounts = sqlite.prepare(`
    SELECT industry, count(*) as count FROM companies
    WHERE industry IS NOT NULL AND industry != ''
    GROUP BY industry ORDER BY count DESC
  `).all() as { industry: string; count: number }[];

  const industries = industryCounts.map((row) => {
    const meta = INDUSTRY_DISPLAY[row.industry as Industry];
    return {
      industry: row.industry,
      label: meta?.label ?? row.industry,
      tier: meta?.tier ?? "C",
      description: meta?.description ?? "",
      count: row.count,
    };
  });

  // Segment filters should come from the structured segment catalog, not
  // only from whatever happens to be present on current company rows.
  // We still preserve counted legacy values so older uncataloged data
  // remains filterable until it gets normalized into segments.
  const segmentCounts = sqlite.prepare(`
    SELECT COALESCE(s.name, c.segment) as segment, count(*) as count
    FROM companies c
    LEFT JOIN segments s ON s.id = c.segment_id
    WHERE COALESCE(s.name, c.segment) IS NOT NULL
      AND COALESCE(s.name, c.segment) != ''
    GROUP BY COALESCE(s.name, c.segment)
  `).all() as { segment: string; count: number }[];

  const catalogSegments = sqlite.prepare(`
    SELECT name as segment, status
    FROM segments
    WHERE name IS NOT NULL
      AND trim(name) != ''
  `).all() as { segment: string; status: string }[];

  const segmentCountMap = new Map(
    segmentCounts.map((row) => [row.segment.trim(), row.count]),
  );

  const segments = [
    ...catalogSegments
      .filter((row) => row.status !== "retired" || (segmentCountMap.get(row.segment.trim()) || 0) > 0)
      .map((row) => ({
        segment: row.segment.trim(),
        count: segmentCountMap.get(row.segment.trim()) || 0,
      })),
    ...segmentCounts
      .filter((row) => {
        const normalized = row.segment.trim().toLowerCase();
        return !catalogSegments.some((segment) => segment.segment.trim().toLowerCase() === normalized);
      })
      .map((row) => ({
        segment: row.segment.trim(),
        count: row.count,
      })),
  ].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.segment.localeCompare(b.segment);
  });

  // Products carried (formerly mislabeled as "category") — what eyewear
  // categories the prospect already merchandises.
  const productsCarried = sqlite.prepare(`
    SELECT category, count(*) as count FROM companies
    WHERE category IS NOT NULL AND category != ''
    GROUP BY category ORDER BY count DESC LIMIT 30
  `).all() as { category: string; count: number }[];

  // ICP score range
  const icpRange = sqlite.prepare(`
    SELECT min(icp_score) as min, max(icp_score) as max
    FROM companies WHERE icp_score IS NOT NULL
  `).get() as { min: number; max: number };

  // Source types with counts
  const sourceTypes = sqlite.prepare(`
    SELECT source_type, count(*) as count FROM companies
    WHERE source_type IS NOT NULL AND source_type != ''
    GROUP BY source_type ORDER BY count DESC
  `).all() as { source_type: string; count: number }[];

  return NextResponse.json({
    states,
    statuses,
    sources,
    industries,
    segments,
    productsCarried,
    icpRange,
    sourceTypes,
  });
}
