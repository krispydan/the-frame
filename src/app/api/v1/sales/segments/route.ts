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
      (
        SELECT count(*)
        FROM companies c
        WHERE c.segment_id = s.id OR lower(trim(c.segment)) = lower(trim(s.name))
      ) as prospect_count,
      (
        SELECT count(*)
        FROM companies c
        WHERE (c.segment_id = s.id OR lower(trim(c.segment)) = lower(trim(s.name)))
          AND c.status = 'qualified'
      ) as qualified_count,
      (
        SELECT count(*)
        FROM companies c
        WHERE (c.segment_id = s.id OR lower(trim(c.segment)) = lower(trim(s.name)))
          AND c.status = 'customer'
      ) as customer_count,
      (
        SELECT count(*)
        FROM deals d
        JOIN companies c ON c.id = d.company_id
        WHERE (c.segment_id = s.id OR lower(trim(c.segment)) = lower(trim(s.name)))
          AND d.stage NOT IN ('order_placed', 'not_interested')
      ) as active_deals,
      (
        SELECT coalesce(sum(coalesce(d.value, 0)), 0)
        FROM deals d
        JOIN companies c ON c.id = d.company_id
        WHERE (c.segment_id = s.id OR lower(trim(c.segment)) = lower(trim(s.name)))
          AND d.stage NOT IN ('order_placed', 'not_interested')
      ) as pipeline_value,
      (
        SELECT count(*)
        FROM orders o
        JOIN companies c ON c.id = o.company_id
        WHERE c.segment_id = s.id OR lower(trim(c.segment)) = lower(trim(s.name))
      ) as order_count,
      (
        SELECT coalesce(sum(coalesce(o.total, 0)), 0)
        FROM orders o
        JOIN companies c ON c.id = o.company_id
        WHERE (c.segment_id = s.id OR lower(trim(c.segment)) = lower(trim(s.name)))
          AND o.status NOT IN ('cancelled', 'returned')
      ) as revenue,
      (
        SELECT count(*)
        FROM campaigns camp
        WHERE lower(trim(camp.target_segment)) = lower(trim(s.name))
      ) as campaign_count
    FROM segments s
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
