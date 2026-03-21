export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

export async function GET() {
  const totalProspects = (sqlite.prepare("SELECT count(*) as c FROM companies").get() as { c: number }).c;

  const outreachReady = (sqlite.prepare(
    "SELECT count(*) as c FROM companies WHERE email IS NOT NULL AND email != '' AND status = 'qualified'"
  ).get() as { c: number }).c;

  const icpABCount = (sqlite.prepare(
    "SELECT count(*) as c FROM companies WHERE icp_tier IN ('A', 'B')"
  ).get() as { c: number }).c;

  const unscoredCount = (sqlite.prepare(
    "SELECT count(*) as c FROM companies WHERE icp_score IS NULL"
  ).get() as { c: number }).c;

  const recentActivity = sqlite.prepare(
    "SELECT * FROM activity_feed ORDER BY created_at DESC LIMIT 20"
  ).all();

  return NextResponse.json({
    totalProspects,
    outreachReady,
    pipelineValue: 0, // Phase 2
    icpABCount,
    unscoredCount,
    recentActivity,
  });
}
