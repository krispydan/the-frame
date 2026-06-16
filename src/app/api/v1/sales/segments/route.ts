export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

type SegmentRow = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  status: string;
  prospect_count: number;
  qualified_count: number;
  customer_count: number;
  active_deals: number;
  pipeline_value: number;
  order_count: number;
  revenue: number;
  campaign_count: number;
};

export async function GET() {
  const rows = sqlite.prepare(`
    SELECT
      s.id,
      s.name,
      s.slug,
      s.description,
      s.status,
      count(DISTINCT c.id) as prospect_count,
      count(DISTINCT CASE WHEN c.status = 'qualified' THEN c.id END) as qualified_count,
      count(DISTINCT CASE WHEN c.status = 'customer' THEN c.id END) as customer_count,
      count(DISTINCT CASE WHEN d.stage NOT IN ('order_placed', 'not_interested') THEN d.id END) as active_deals,
      coalesce(sum(CASE WHEN d.stage NOT IN ('order_placed', 'not_interested') THEN coalesce(d.value, 0) ELSE 0 END), 0) as pipeline_value,
      count(DISTINCT o.id) as order_count,
      coalesce(sum(CASE WHEN o.status NOT IN ('cancelled', 'returned') THEN coalesce(o.total, 0) ELSE 0 END), 0) as revenue,
      count(DISTINCT camp.id) as campaign_count
    FROM segments s
    LEFT JOIN companies c ON c.segment_id = s.id OR lower(trim(c.segment)) = lower(trim(s.name))
    LEFT JOIN deals d ON d.company_id = c.id
    LEFT JOIN orders o ON o.company_id = c.id
    LEFT JOIN campaigns camp ON lower(trim(camp.target_segment)) = lower(trim(s.name))
    GROUP BY s.id, s.name, s.slug, s.description, s.status
    ORDER BY prospect_count DESC, s.name ASC
  `).all() as SegmentRow[];

  const summary = rows.reduce((acc, row) => {
    acc.segments += 1;
    acc.prospects += row.prospect_count;
    acc.qualified += row.qualified_count;
    acc.pipelineValue += row.pipeline_value;
    acc.revenue += row.revenue;
    return acc;
  }, {
    segments: 0,
    prospects: 0,
    qualified: 0,
    pipelineValue: 0,
    revenue: 0,
  });

  return NextResponse.json({ data: rows, summary });
}
