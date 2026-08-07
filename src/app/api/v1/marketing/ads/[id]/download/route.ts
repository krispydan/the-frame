/**
 * GET /api/v1/marketing/ads/[id]/download — every finished render of an
 * ad as one zip, files named per the convention (…_4x5.mp4), ready to
 * drag into Meta Ads Manager. STORE compression: mp4/jpg don't deflate,
 * so we skip burning CPU pretending otherwise.
 */
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import JSZip from "jszip";
import { sqlite } from "@/lib/db";
import { readVideo } from "@/lib/storage/videos";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ad = sqlite.prepare(`SELECT id, name FROM marketing_ads WHERE id = ?`).get(id) as
    | { id: string; name: string } | undefined;
  if (!ad) return NextResponse.json({ error: "Ad not found" }, { status: 404 });

  const renders = sqlite.prepare(
    `SELECT ratio, r2_key FROM marketing_ad_renders WHERE ad_id = ? AND status = 'done' AND r2_key IS NOT NULL ORDER BY ratio`,
  ).all(id) as Array<{ ratio: string; r2_key: string }>;
  if (!renders.length) {
    return NextResponse.json({ error: "No finished renders to download yet" }, { status: 409 });
  }

  const zip = new JSZip();
  for (const r of renders) {
    // Key basename already follows the convention (name_ratio.ext).
    const fileName = r.r2_key.split("/").pop()!;
    zip.file(fileName, await readVideo(r.r2_key));
  }
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "STORE" });

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${ad.name}.zip"`,
      "Content-Length": String(buffer.length),
    },
  });
}
