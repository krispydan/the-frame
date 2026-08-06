export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { requireOpsToken } from "@/lib/ops-auth";
import { analyzeGap } from "@/modules/sales/lib/ajm/gap-analysis";

/**
 * GET /api/admin/ops/ajm/gap?mode=overlap|trailing12
 * Token-guarded gap decomposition — why Jaxy's revenue trails AJM's.
 */
export async function GET(req: NextRequest) {
  const denied = requireOpsToken(req);
  if (denied) return denied;
  const mode = req.nextUrl.searchParams.get("mode");
  return NextResponse.json(
    analyzeGap({ mode: mode === "overlap" || mode === "trailing12" ? mode : undefined }),
  );
}
