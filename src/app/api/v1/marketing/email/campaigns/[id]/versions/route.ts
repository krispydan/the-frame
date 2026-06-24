export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { emailCampaigns } from "@/modules/marketing/schema";
import { eq } from "drizzle-orm";
import { listVersions, restoreVersion } from "@/modules/marketing/lib/copy-versions";

/**
 * GET  /campaigns/[id]/versions          — list copy snapshots (newest first)
 * POST /campaigns/[id]/versions { versionId } — restore a snapshot onto the campaign
 *
 * Snapshots are taken automatically before each AI regenerate, so this
 * is the "undo" for a regenerate that came back worse.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return NextResponse.json({ versions: listVersions(id) });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: { versionId?: string } = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: "JSON body required" }, { status: 400 }); }
  if (!body.versionId) return NextResponse.json({ error: "versionId required" }, { status: 400 });

  const ok = restoreVersion(id, body.versionId);
  if (!ok) return NextResponse.json({ error: "Version not found for this campaign" }, { status: 404 });

  const [campaign] = await db.select().from(emailCampaigns).where(eq(emailCampaigns.id, id)).limit(1);
  return NextResponse.json({ ok: true, campaign });
}
