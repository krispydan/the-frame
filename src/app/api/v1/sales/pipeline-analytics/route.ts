export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { getSessionUser } from "@/lib/get-session";
import { getPipedriveConnectionStatus } from "@/modules/sales/lib/pipedrive-client";

/**
 * GET /api/v1/sales/pipeline-analytics
 *
 * Pipedrive deal analytics from the frame's `pipedrive_deals` projection:
 * funnel by pipeline/stage, win rate, deal ageing and stalled deals.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const many = <T,>(sql: string, ...args: unknown[]): T[] => {
    try { return sqlite.prepare(sql).all(...args) as T[]; } catch { return []; }
  };
  const one = <T,>(sql: string, ...args: unknown[]): T | undefined => {
    try { return sqlite.prepare(sql).get(...args) as T; } catch { return undefined; }
  };

  const totals = one<{ open: number; won: number; lost: number; openValue: number; wonValue: number }>(
    `SELECT
       SUM(CASE WHEN is_open = 1 THEN 1 ELSE 0 END) open,
       SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END) won,
       SUM(CASE WHEN status = 'lost' THEN 1 ELSE 0 END) lost,
       COALESCE(SUM(CASE WHEN is_open = 1 THEN value ELSE 0 END), 0) openValue,
       COALESCE(SUM(CASE WHEN status = 'won' THEN value ELSE 0 END), 0) wonValue
     FROM pipedrive_deals`) ?? { open: 0, won: 0, lost: 0, openValue: 0, wonValue: 0 };

  const byPipeline = many<{ pipeline: string; deals: number; value: number }>(
    `SELECT COALESCE(pipeline,'(none)') pipeline, COUNT(*) deals, COALESCE(SUM(value),0) value
       FROM pipedrive_deals WHERE is_open = 1 GROUP BY pipeline ORDER BY deals DESC`);

  const byStage = many<{ pipeline: string; stage: string; deals: number; value: number }>(
    `SELECT COALESCE(pipeline,'(none)') pipeline, COALESCE(stage,'(none)') stage,
            COUNT(*) deals, COALESCE(SUM(value),0) value
       FROM pipedrive_deals WHERE is_open = 1
      GROUP BY pipeline, stage ORDER BY pipeline, deals DESC`);

  // Ageing buckets on open deals (how long since last movement).
  const ageing = one<{ fresh: number; week: number; month: number; stale: number }>(
    `SELECT
       SUM(CASE WHEN julianday('now') - julianday(updated_at) <= 7 THEN 1 ELSE 0 END) fresh,
       SUM(CASE WHEN julianday('now') - julianday(updated_at) > 7 AND julianday('now') - julianday(updated_at) <= 30 THEN 1 ELSE 0 END) week,
       SUM(CASE WHEN julianday('now') - julianday(updated_at) > 30 AND julianday('now') - julianday(updated_at) <= 90 THEN 1 ELSE 0 END) month,
       SUM(CASE WHEN julianday('now') - julianday(updated_at) > 90 THEN 1 ELSE 0 END) stale
     FROM pipedrive_deals WHERE is_open = 1`) ?? { fresh: 0, week: 0, month: 0, stale: 0 };

  const stalled = many<{ deal_id: number; title: string; pipeline: string; stage: string; value: number; days: number; company_id: string; company_name: string }>(
    `SELECT d.pipedrive_deal_id deal_id, d.title, d.pipeline, d.stage, COALESCE(d.value,0) value,
            CAST(julianday('now') - julianday(d.updated_at) AS INTEGER) days,
            d.company_id, c.name company_name
       FROM pipedrive_deals d LEFT JOIN companies c ON c.id = d.company_id
      WHERE d.is_open = 1 AND julianday('now') - julianday(d.updated_at) > 30
      ORDER BY days DESC LIMIT 15`);

  const recentWins = many<{ deal_id: number; title: string; value: number; updated_at: string; company_id: string; company_name: string }>(
    `SELECT d.pipedrive_deal_id deal_id, d.title, COALESCE(d.value,0) value, d.updated_at,
            d.company_id, c.name company_name
       FROM pipedrive_deals d LEFT JOIN companies c ON c.id = d.company_id
      WHERE d.status = 'won' ORDER BY d.updated_at DESC LIMIT 10`);

  const decided = (totals.won ?? 0) + (totals.lost ?? 0);
  return NextResponse.json({
    ok: true,
    apiDomain: getPipedriveConnectionStatus().apiDomain ?? null,
    totals: { ...totals, winRate: decided ? (totals.won / decided) * 100 : null },
    byPipeline,
    byStage,
    ageing,
    stalled,
    recentWins,
  });
}
