export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { emailCampaigns } from "@/modules/marketing/schema";
import { eq } from "drizzle-orm";

/**
 * POST /api/v1/marketing/email/campaigns/[id]/duplicate
 *
 * Clones a campaign as a fresh Draft: keeps the brief, variants, copy,
 * and image prompts (a good starting point), but resets status to
 * draft, renames "<name> (copy)", and clears the things that are
 * specific to the original — uploaded image paths (they live on disk
 * under the old id), export artifact, send/utm metadata. The operator
 * sets a new date in the editor.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const [row] = await db
    .select()
    .from(emailCampaigns)
    .where(eq(emailCampaigns.id, id))
    .limit(1);
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Strip identity/lifecycle fields (id + timestamps regenerate via
  // their column defaults); clone the rest with the typed row so
  // Drizzle's insert shape is preserved.
  const { id: _omitId, createdAt: _omitCreated, updatedAt: _omitUpdated, ...rest } = row;
  void _omitId; void _omitCreated; void _omitUpdated;

  const [created] = await db
    .insert(emailCampaigns)
    .values({
      ...rest,
      name: row.name ? `${row.name} (copy)` : "Untitled (copy)",
      status: "draft",
      // These point at the original campaign's assets / lifecycle.
      heroImagePath: null,
      secondaryImagePath: null,
      secondaryImagePath2: null,
      exportedHtmlPath: null,
      utmCampaign: null,
      aiCopyRawJson: null,
      aiImagePromptRawJson: null,
    })
    .returning();
  return NextResponse.json({ campaign: created }, { status: 201 });
}
