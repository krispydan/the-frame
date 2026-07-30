/**
 * GET /api/v1/marketing/videos/product-videos/download?productId=…
 *
 * Streams the rendered product video back with a Content-Disposition
 * attachment header so the browser saves it under a sane filename
 * (`deco.mp4`, not `p_01H….mp4`).
 *
 * This exists because the master lives on R2 in production: linking
 * straight at the public CDN URL makes the browser *play* the file
 * cross-origin and ignore the `download` attribute. Going through the
 * app keeps it same-origin, so "Download video" actually downloads.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { readVideo } from "@/lib/storage/videos";

export async function GET(request: NextRequest) {
  const productId = request.nextUrl.searchParams.get("productId") ?? "";
  if (!productId) return NextResponse.json({ error: "productId required" }, { status: 400 });

  const row = sqlite
    .prepare(
      `SELECT pv.file_path AS filePath, pv.status, p.name AS productName
         FROM marketing_product_videos pv
         JOIN catalog_products p ON p.id = pv.product_id
        WHERE pv.product_id = ?`,
    )
    .get(productId) as { filePath: string | null; status: string; productName: string } | undefined;

  if (!row || row.status !== "ready" || !row.filePath) {
    return NextResponse.json({ error: "No rendered video for this product" }, { status: 404 });
  }

  let bytes: Buffer;
  try {
    bytes = await readVideo(row.filePath);
  } catch (e) {
    console.error("[product-video download] failed:", e);
    return NextResponse.json({ error: "Couldn't read the rendered video — rebuild it" }, { status: 500 });
  }

  const slug = row.productName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "product";
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(bytes.length),
      "Content-Disposition": `attachment; filename="${slug}.mp4"`,
      "Cache-Control": "no-store",
    },
  });
}
