export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { requireOpsToken } from "@/lib/ops-auth";
import { runDatabaseBackup, listBackups } from "@/modules/integrations/lib/backup/db-backup";

/**
 * Token-guarded database backup ops (x-ops-key: OPS_TOKEN).
 * GET            → list existing backups in the private R2 bucket (newest first)
 * POST ?confirm=1 → run a backup now (snapshot → gzip → private R2 → prune)
 */
export async function GET(req: NextRequest) {
  const denied = requireOpsToken(req);
  if (denied) return denied;
  return NextResponse.json({ backups: await listBackups() });
}

export async function POST(req: NextRequest) {
  const denied = requireOpsToken(req, { mutation: true });
  if (denied) return denied;
  return NextResponse.json(await runDatabaseBackup());
}
