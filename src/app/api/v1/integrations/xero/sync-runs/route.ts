export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { xeroSyncRuns } from "@/modules/integrations/schema/xero";
import { desc } from "drizzle-orm";

/**
 * GET /api/v1/integrations/xero/sync-runs
 *
 * Returns the most recent sync runs (latest first), capped at 25 rows.
 * Used by the integrations page to show the last run status under the
 * "Run sync" button.
 */
export async function GET() {
  const runs = await db.select().from(xeroSyncRuns).orderBy(desc(xeroSyncRuns.startedAt)).limit(25);
  return NextResponse.json({ runs });
}
