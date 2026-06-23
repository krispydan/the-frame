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
import { db, sqlite } from "@/lib/db";
import { emailCampaigns } from "@/modules/marketing/schema";
import { eq } from "drizzle-orm";
import { saveImage } from "@/lib/storage/local";
import { catalogImageUrl } from "@/lib/storage/image-url";

const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

const VALID_KINDS = ["hero", "secondary", "secondary_2", "logo"] as const;
type ImageKind = (typeof VALID_KINDS)[number];

const KIND_TO_COLUMN: Record<ImageKind, string> = {
  hero: "hero_image_path",
  secondary: "secondary_image_path",
  secondary_2: "secondary_image_path_2",
  logo: "logo_image_path",
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

  // Update the campaign row's image path column
  const column = KIND_TO_COLUMN[kind as ImageKind];
  sqlite
    .prepare(
      `UPDATE marketing_email_campaigns
        SET ${column} = ?, updated_at = datetime('now')
        WHERE id = ?`,
    )
    .run(relPath, campaignId);

  // Auto-advance status if all required images are present.
  // Required images: hero + secondary; plus secondary_2 if grid_2up.
  const [after] = await db
    .select()
    .from(emailCampaigns)
    .where(eq(emailCampaigns.id, campaignId))
    .limit(1);

  const hasHero = !!after?.heroImagePath;
  const hasSecondary = !!after?.secondaryImagePath;
  const needsSecondary2 = after?.secondaryImageVariant === "grid_2up";
  const hasSecondary2 = !!after?.secondaryImagePath2;
  const allReady = hasHero && hasSecondary && (!needsSecondary2 || hasSecondary2);

  let statusAfter = after?.status ?? "photography";
  if (allReady && after?.status === "photography") {
    sqlite
      .prepare(
        `UPDATE marketing_email_campaigns
          SET status = 'design_review', updated_at = datetime('now')
          WHERE id = ?`,
      )
      .run(campaignId);
    statusAfter = "design_review";
  }

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
