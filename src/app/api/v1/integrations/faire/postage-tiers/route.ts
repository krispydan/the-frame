export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_TIERS,
  getPostageTiers,
  savePostageTiers,
  type PostageTier,
} from "@/modules/integrations/lib/faire/postage-tiers";

/**
 * GET  /api/v1/integrations/faire/postage-tiers
 * PUT  /api/v1/integrations/faire/postage-tiers
 *
 * Reads / writes the configurable postage tier table used when we mark
 * US Faire orders shipped. Body validation lives in
 * modules/integrations/lib/faire/postage-tiers.ts (savePostageTiers)
 * so the same rules apply to UI and to direct API callers.
 */

export async function GET() {
  return NextResponse.json({
    tiers: getPostageTiers(),
    defaults: DEFAULT_TIERS,
  });
}

export async function PUT(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const tiers = (body as { tiers?: PostageTier[] })?.tiers;
  if (!Array.isArray(tiers) || tiers.length === 0) {
    return NextResponse.json({ ok: false, error: "Body must be { tiers: [...] } with at least one tier" }, { status: 400 });
  }
  try {
    savePostageTiers(tiers);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
  return NextResponse.json({ ok: true, tiers: getPostageTiers() });
}
