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
  // compareByAge was removed: AJ Morgan was a 40-year-old business, so
  // "each brand's first N months" compared Jaxy's real standing start against
  // an arbitrary slice of an established company — a meaningless baseline.
  const mode = req.nextUrl.searchParams.get("mode");
  return NextResponse.json(
    analyzeGap({ mode: mode === "overlap" || mode === "trailing12" ? mode : undefined }),
  );
}
