/**
 * GET /api/v1/marketing/videos/uploads/report
 *
 * What actually happened to everything uploaded so far: failed clips,
 * failed/empty sources, rows stuck mid-pipeline, and raw objects sitting
 * in storage with no DB row (uploads whose /register never landed — the
 * silent losses that look like a successful upload).
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

import { NextResponse } from "next/server";
import { buildUploadHealthReport } from "@/modules/marketing/lib/video/upload-preflight";

export async function GET() {
  try {
    return NextResponse.json(await buildUploadHealthReport());
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[upload report] failed:", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
