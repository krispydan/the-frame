/**
 * GET /api/v1/marketing/email/campaigns/[id]/export-image?kind=...
 *
 * Renders one section of the email and returns it as a JPG. Used
 * for pasting blocks into Faire / Omnisend / any platform whose
 * builder expects images rather than HTML.
 *
 * Valid kinds:
 *   hero        — hero block (any variant)
 *   sectionA    — text section A
 *   secondary   — secondary image block
 *   sectionB    — text section B + CTA
 *   full        — the entire assembled email
 *
 * Query params:
 *   kind            (required, one of above)
 *   width           (optional, default 600)  — viewport width
 *   scale           (optional, default 2)    — device-pixel ratio
 *   quality         (optional, default 92)   — JPG quality 0-100
 *   download=1      (optional)               — Content-Disposition: attachment
 *
 * Returns: image/jpeg
 *
 * Performance note: each request spins Playwright (or reuses the
 * cached browser singleton). First request ~1-2s, subsequent
 * requests ~300-500ms. The browser stays warm until the Node
 * process restarts.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { emailCampaigns } from "@/modules/marketing/schema";
import { eq } from "drizzle-orm";
import { renderEmailHtml, renderSectionHtml, SectionKind } from "@/modules/marketing/lib/render-email";
import { renderHtmlToJpg } from "@/modules/marketing/lib/render-screenshot";
import type { CampaignData } from "@/modules/marketing/components/email-template";

const VALID_KINDS = ["hero", "sectionA", "secondary", "sectionB", "full"] as const;
type ExportKind = (typeof VALID_KINDS)[number];

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(req.url);
  const kind = url.searchParams.get("kind") as ExportKind | null;
  const width = parseInt(url.searchParams.get("width") ?? "600", 10);
  const scale = parseFloat(url.searchParams.get("scale") ?? "2");
  const quality = parseInt(url.searchParams.get("quality") ?? "92", 10);
  const download = url.searchParams.get("download") === "1";

  if (!kind || !VALID_KINDS.includes(kind)) {
    return NextResponse.json(
      { error: `kind must be one of: ${VALID_KINDS.join(", ")}` },
      { status: 400 },
    );
  }
  if (!Number.isFinite(width) || width < 200 || width > 2000) {
    return NextResponse.json({ error: "width must be 200–2000" }, { status: 400 });
  }
  if (!Number.isFinite(scale) || scale < 1 || scale > 4) {
    return NextResponse.json({ error: "scale must be 1–4" }, { status: 400 });
  }

  const [row] = await db
    .select()
    .from(emailCampaigns)
    .where(eq(emailCampaigns.id, id))
    .limit(1);
  if (!row) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  // Coerce row to CampaignData — same coercion used by the preview
  // route. Variant strings come back as plain strings from sqlite;
  // the renderer narrows them via the union type.
  // `...row` already carries logoImagePath + the *_disabled flags
  // since they were added to the schema. The explicit casts below
  // only narrow the variant string columns to their union types.
  const campaign: CampaignData = {
    ...row,
    heroVariant: row.heroVariant as CampaignData["heroVariant"],
    sectionAVariant: row.sectionAVariant as CampaignData["sectionAVariant"],
    secondaryImageVariant: row.secondaryImageVariant as CampaignData["secondaryImageVariant"],
    sectionBVariant: row.sectionBVariant as CampaignData["sectionBVariant"],
    heroScrim: row.heroScrim as CampaignData["heroScrim"],
  };

  const html =
    kind === "full"
      ? renderEmailHtml(campaign)
      : renderSectionHtml(campaign, kind as SectionKind);

  let jpg: Buffer;
  try {
    jpg = await renderHtmlToJpg(html, {
      viewportWidth: width,
      deviceScaleFactor: scale,
      quality,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }

  const slug =
    (row.name ?? row.subject ?? row.id)
      .toString()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 40) || "campaign";
  const filename = `${slug}-${kind}.jpg`;

  const headers: Record<string, string> = {
    "Content-Type": "image/jpeg",
    "Cache-Control": "no-store",
    "Content-Length": String(jpg.length),
  };
  if (download) {
    headers["Content-Disposition"] = `attachment; filename="${filename}"`;
  } else {
    headers["Content-Disposition"] = `inline; filename="${filename}"`;
  }

  return new Response(new Uint8Array(jpg), { status: 200, headers });
}
