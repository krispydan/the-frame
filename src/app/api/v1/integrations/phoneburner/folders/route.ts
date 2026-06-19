export const dynamic = "force-dynamic";
export const maxDuration = 30;

import { NextResponse } from "next/server";
import { phoneBurnerClient } from "@/modules/sales/lib/phoneburner-client";

/**
 * GET /api/v1/integrations/phoneburner/folders
 *
 * Lists every folder in the connected PhoneBurner account so the
 * Campaign detail page can show a picker before pushing. Lets the
 * operator either re-use an existing folder ("Brand Carriers" they
 * created manually) or auto-create one from the campaign name on
 * first push.
 *
 * Returns: { folders: [{ id, name }] }
 *
 * Auth: same session gate as the rest of /api/v1.
 */
export async function GET() {
  try {
    const folders = await phoneBurnerClient.listFolders();
    return NextResponse.json({
      folders: folders.map((f) => ({
        id: String(f.id ?? ""),
        name: String(f.name ?? "Unnamed folder"),
      })),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
