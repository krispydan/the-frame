/**
 * POST /api/v1/marketing/email/campaigns/[id]/upload-image
 *
 * multipart/form-data:
 *   file   — required, image/* (designer's Higgsfield render)
 *   kind   — required, "hero" | "secondary" | "secondary_2"
 *
 * Writes the file to /data/images/email/{campaignId}/{kind}.{ext}
 * via saveImage(). Updates the campaign row's
 * {hero|secondary|secondary_2}_image_path column. If both hero and
 * secondary (and secondary_2 when grid_2up) are present after this
 * write, auto-advances status from image_pending → image_review.
 *
 * Unlike the catalog image pipeline, we DON'T run sharp / processing
 * — designer renders are already final. We just persist as-is and
 * trust the dimensions match the variant's spec.
 *
 * Response: { ok, kind, path, url, statusAfter }
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { imagesComplete } from "@/modules/marketing/lib/images-complete";
import { db, sqlite } from "@/lib/db";
import { emailCampaigns } from "@/modules/marketing/schema";
import { eq } from "drizzle-orm";
import { saveImage } from "@/lib/storage/local";
import { catalogImageUrl } from "@/lib/storage/image-url";

const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

const VALID_KINDS = ["hero", "secondary", "secondary_2"] as const;
type ImageKind = (typeof VALID_KINDS)[number];

const KIND_TO_COLUMN: Record<ImageKind, string> = {
  hero: "hero_image_path",
  secondary: "secondary_image_path",
  secondary_2: "secondary_image_path_2",
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: campaignId } = await params;

  // Verify campaign exists before touching disk
  const [campaign] = await db
    .select()
    .from(emailCampaigns)
    .where(eq(emailCampaigns.id, campaignId))
    .limit(1);
  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  // Parse multipart
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid multipart body" }, { status: 400 });
  }

  const file = formData.get("file");
  const kind = formData.get("kind");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file field is required" }, { status: 400 });
  }
  if (typeof kind !== "string" || !VALID_KINDS.includes(kind as ImageKind)) {
    return NextResponse.json(
      { error: `kind must be one of: ${VALID_KINDS.join(", ")}` },
      { status: 400 },
    );
  }
  if (!file.type.startsWith("image/")) {
    return NextResponse.json(
      { error: `Unsupported content type: ${file.type}. Must be image/*` },
      { status: 400 },
    );
  }
  if (file.size > MAX_SIZE) {
    return NextResponse.json(
      { error: `File too large: ${file.size}. Max ${MAX_SIZE}.` },
      { status: 413 },
    );
  }

  // grid_2up is the only variant that uses secondary_2 — reject
  // uploads to that slot when the variant doesn't need it.
  if (kind === "secondary_2" && campaign.secondaryImageVariant !== "grid_2up") {
    return NextResponse.json(
      { error: "secondary_2 only valid for grid_2up variant" },
      { status: 400 },
    );
  }

  // Derive extension from MIME type (fall back to .jpg)
  const ext = mimeToExt(file.type);
  const relPath = `email/${campaignId}/${kind}.${ext}`;

  // Persist bytes
  const buffer = Buffer.from(await file.arrayBuffer());
  try {
    await saveImage(buffer, relPath);
  } catch (e) {
    return NextResponse.json(
      { error: `Save failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }

  // Update the path + auto-advance status in a single transaction so
  // two concurrent uploads can't read stale state and both miss (or
  // both trigger) the photography→design_review hop. The UPDATE for
  // status uses a guarded WHERE clause that also prevents over-write
  // if another upload already advanced.
  const column = KIND_TO_COLUMN[kind as ImageKind];
  const tx = sqlite.transaction((relP: string, cid: string) => {
    // 1. Set the new image path
    sqlite
      .prepare(
        `UPDATE marketing_email_campaigns
          SET ${column} = ?, updated_at = datetime('now')
          WHERE id = ?`,
      )
      .run(relP, cid);
    // 2. Re-read inside the transaction for an isolated view
    const row = sqlite
      .prepare(
        `SELECT status, hero_disabled, secondary_disabled,
                hero_image_path, secondary_image_path,
                secondary_image_path_2, secondary_image_variant
           FROM marketing_email_campaigns WHERE id = ?`,
      )
      .get(cid) as {
        status: string | null;
        hero_disabled: number | null;
        secondary_disabled: number | null;
        hero_image_path: string | null;
        secondary_image_path: string | null;
        secondary_image_path_2: string | null;
        secondary_image_variant: string | null;
      } | undefined;
    if (!row) return { status: "photography", allReady: false };
    // Shared "images complete" definition (disabled sections don't block) —
    // keep in lockstep with the campaign PATCH route via images-complete.ts.
    const allReady = imagesComplete({
      heroDisabled: row.hero_disabled,
      heroImagePath: row.hero_image_path,
      secondaryDisabled: row.secondary_disabled,
      secondaryImagePath: row.secondary_image_path,
      secondaryImagePath2: row.secondary_image_path_2,
      secondaryImageVariant: row.secondary_image_variant,
    });
    let newStatus = row.status ?? "photography";
    if (allReady && row.status === "photography") {
      sqlite
        .prepare(
          `UPDATE marketing_email_campaigns
            SET status = 'design_review', updated_at = datetime('now')
            WHERE id = ? AND status = 'photography'`,
        )
        .run(cid);
      newStatus = "design_review";
    }
    return { status: newStatus, allReady };
  });

  const result = tx(relPath, campaignId);
  const statusAfter = result.status;
  const allReady = result.allReady;

  return NextResponse.json({
    ok: true,
    kind,
    path: relPath,
    url: catalogImageUrl(relPath),
    statusAfter,
    allImagesReady: allReady,
  });
}

function mimeToExt(mime: string): string {
  if (mime === "image/jpeg" || mime === "image/jpg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "image/avif") return "avif";
  return "jpg";
}
