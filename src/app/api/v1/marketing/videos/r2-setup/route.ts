/**
 * GET /api/v1/marketing/videos/r2-setup
 *
 * One-tap R2 bucket setup / status. Direct browser→R2 uploads need a
 * CORS policy on the bucket allowing cross-origin PUT; this configures it
 * from the server (where the R2 credentials live) so it can be done from
 * a phone without the Cloudflare dashboard.
 *
 *   ?apply=1            → set the CORS policy, then return it
 *   ?origin=https://…   → restrict AllowedOrigin (default "*", which is
 *                         safe: the presigned URL is the auth)
 *   (no params)         → just report configured state + current CORS
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { isR2Configured, r2PutBucketCors, r2GetBucketCors } from "@/lib/storage/r2";

export async function GET(request: NextRequest) {
  if (!isR2Configured()) {
    return NextResponse.json({
      configured: false,
      message: "R2 is not configured (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET).",
    });
  }

  const { searchParams } = new URL(request.url);
  const apply = searchParams.get("apply") === "1";
  const originParam = searchParams.get("origin");
  const origins = originParam ? [originParam] : ["*"];

  try {
    let applied = false;
    if (apply) {
      await r2PutBucketCors(origins);
      applied = true;
    }
    const cors = await r2GetBucketCors();
    return NextResponse.json({
      configured: true,
      applied,
      appliedOrigins: apply ? origins : undefined,
      cors,
      hint: apply
        ? "CORS applied — direct uploads should work now. Try dropping a clip."
        : "Add ?apply=1 to this URL to set the CORS policy for direct uploads.",
    });
  } catch (e) {
    return NextResponse.json(
      { configured: true, applied: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
