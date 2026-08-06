export const dynamic = "force-dynamic";
export const maxDuration = 300;
import { NextRequest, NextResponse } from "next/server";
import { requireOpsToken } from "@/lib/ops-auth";
import { importAjmCsv, rematchAjmOrders, ajmStats, type AjmSource } from "@/modules/sales/lib/ajm/import";
import { categorizeAjmItems } from "@/modules/sales/lib/ajm/categorize";

/**
 * Token-guarded AJ Morgan history ops (x-ops-key: OPS_TOKEN).
 *
 * GET  → import stats by source + distinct customer count
 * POST ?confirm=1&source=faire|shopify_wholesale|shopify_retail|faire_payouts|faire_emails
 *      multipart "file" (the export CSV) → import/enrich, then rematch
 * POST ?confirm=1&source=rematch (no file) → re-run company matching only
 */
export async function GET(req: NextRequest) {
  const denied = requireOpsToken(req);
  if (denied) return denied;
  return NextResponse.json(ajmStats());
}

const SOURCES: AjmSource[] = ["faire", "shopify_wholesale", "shopify_retail", "oms", "faire_payouts", "faire_emails"];

export async function POST(req: NextRequest) {
  const denied = requireOpsToken(req, { mutation: true });
  if (denied) return denied;

  const source = req.nextUrl.searchParams.get("source") ?? "";
  if (source === "rematch") {
    return NextResponse.json({ rematch: rematchAjmOrders() });
  }
  if (source === "categorize") {
    return NextResponse.json(categorizeAjmItems());
  }
  if (!SOURCES.includes(source as AjmSource)) {
    return NextResponse.json({ error: `source must be one of ${SOURCES.join(", ")} or rematch` }, { status: 400 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart form data with 'file'" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Missing 'file' upload" }, { status: 400 });

  try {
    const text = await file.text();
    const result = importAjmCsv(source as AjmSource, text);
    const rematch = rematchAjmOrders();
    // Newly imported lines arrive uncategorized; classify immediately so the
    // reader-target list is never stale relative to the data.
    const categories = categorizeAjmItems();
    return NextResponse.json({ ...result, rematch, categoryCoverage: categories.coverage });
  } catch (e) {
    console.error("[ops/ajm] import failed:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
