export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextResponse } from "next/server";
import { importCampaignsFromInstantly } from "@/modules/sales/lib/instantly-sync";
import { instantlyClient } from "@/modules/sales/lib/instantly-client";

/**
 * POST /api/v1/integrations/instantly/sync-campaigns
 *
 * Pulls every campaign from Instantly via /campaigns and upserts it
 * into our local `campaigns` table, keyed by `instantly_campaign_id`.
 * Safe to re-run — see importCampaignsFromInstantly for the upsert
 * semantics.
 *
 * Returns:
 *   { ok: true, isMock: boolean, stats: ImportCampaignsStats }
 *   { ok: false, error }
 *
 * `isMock=true` means no API key is resolvable (neither env var
 * INSTANTLY_API_KEY nor the `instantly_api_key` row in settings)
 * so the client returned mock data. Caller should warn the operator.
 */
export async function POST() {
  try {
    const isMock = instantlyClient.isMock;
    const stats = await importCampaignsFromInstantly();
    return NextResponse.json({ ok: true, isMock, stats });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
