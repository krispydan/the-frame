export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * GET /api/v1/intelligence/pipeline
 * Pipeline analytics: deals by stage, conversion rates, velocity
 */
export async function GET() {
  // Deals by stage
  const byStage = sqlite.prepare(`
    SELECT stage, count(*) as count, coalesce(sum(value), 0) as total_value,
           round(avg(julianday('now') - julianday(created_at)), 1) as avg_days
    FROM deals
    GROUP BY stage
    ORDER BY CASE stage
      WHEN 'outreach' THEN 1
      WHEN 'contact_made' THEN 2
      WHEN 'interested' THEN 3
      WHEN 'order_placed' THEN 4
      WHEN 'interested_later' THEN 5
      WHEN 'not_interested' THEN 6
    END
  `).all() as Array<{ stage: string; count: number; total_value: number; avg_days: number }>;

  // Total deals and conversion funnel
  const totalDeals = byStage.reduce((s, r) => s + r.count, 0);
  const stageMap = Object.fromEntries(byStage.map((r) => [r.stage, r]));
  const outreach = stageMap["outreach"]?.count || 0;
  const contactMade = stageMap["contact_made"]?.count || 0;
  const interested = stageMap["interested"]?.count || 0;
  const orderPlaced = stageMap["order_placed"]?.count || 0;

  // Stage change velocity (avg days between stage changes)
  const stageTransitions = sqlite.prepare(`
    SELECT
      json_extract(metadata, '$.fromStage') as from_stage,
      json_extract(metadata, '$.toStage') as to_stage,
      count(*) as transition_count,
      round(avg(julianday(created_at) - julianday(
        (SELECT da2.created_at FROM deal_activities da2
         WHERE da2.deal_id = deal_activities.deal_id
           AND da2.type = 'stage_change'
           AND da2.created_at < deal_activities.created_at
         ORDER BY da2.created_at DESC LIMIT 1)
      )), 1) as avg_days_between
    FROM deal_activities
    WHERE type = 'stage_change'
      AND json_extract(metadata, '$.fromStage') IS NOT NULL
    GROUP BY from_stage, to_stage
    ORDER BY transition_count DESC
    LIMIT 20
  `).all() as Array<{ from_stage: string; to_stage: string; transition_count: number; avg_days_between: number | null }>;

  // Recent deal activity (last 30 days)
  const dealsCreatedLast30 = (sqlite.prepare(
    "SELECT count(*) as c FROM deals WHERE created_at >= datetime('now', '-30 days')"
  ).get() as { c: number }).c;

  const dealsWonLast30 = (sqlite.prepare(
    "SELECT count(*) as c FROM deals WHERE stage = 'order_placed' AND updated_at >= datetime('now', '-30 days')"
  ).get() as { c: number }).c;

  const dealsLostLast30 = (sqlite.prepare(
    "SELECT count(*) as c FROM deals WHERE stage = 'not_interested' AND updated_at >= datetime('now', '-30 days')"
  ).get() as { c: number }).c;

  // Win rate
  const closedDeals = dealsWonLast30 + dealsLostLast30;
  const winRate = closedDeals > 0 ? Math.round((dealsWonLast30 / closedDeals) * 100) : 0;

  // Conversion funnel percentages
  const funnel = [
    { stage: "outreach", count: outreach, rate: 100 },
    { stage: "contact_made", count: contactMade, rate: outreach > 0 ? Math.round((contactMade / outreach) * 100) : 0 },
    { stage: "interested", count: interested, rate: contactMade > 0 ? Math.round((interested / contactMade) * 100) : 0 },
    { stage: "order_placed", count: orderPlaced, rate: interested > 0 ? Math.round((orderPlaced / interested) * 100) : 0 },
  ];

  return NextResponse.json({
    byStage,
    funnel,
    stageTransitions: stageTransitions.filter((t) => t.avg_days_between != null),
    summary: {
      totalDeals,
      dealsCreatedLast30,
      dealsWonLast30,
      dealsLostLast30,
      winRate,
    },
  });
}
