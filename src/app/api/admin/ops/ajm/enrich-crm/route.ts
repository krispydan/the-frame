export const dynamic = "force-dynamic";
export const maxDuration = 300;
import { NextRequest, NextResponse } from "next/server";
import { requireOpsToken } from "@/lib/ops-auth";
import { enrichFromOmsCrm } from "@/modules/sales/lib/ajm/enrich-crm";

/**
 * Enrich existing companies from A.J. Morgan's OMS wholesale customer file.
 *
 * POST ?confirm=1            multipart "file" — DRY RUN, reports what it would fill
 *      &apply=1              actually write
 *
 * Fills contact email, phone and address onto companies that are already in
 * The Frame. It never creates a company: the file holds 4,500+ accounts going
 * back to 1996 and importing the dead ones would bury the live book. It never
 * overwrites either — only blank fields are filled.
 */
export async function POST(req: NextRequest) {
  const denied = requireOpsToken(req, { mutation: true });
  if (denied) return denied;

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
    return NextResponse.json(enrichFromOmsCrm(text, { apply: req.nextUrl.searchParams.get("apply") === "1" }));
  } catch (e) {
    const err = e as Error;
    console.error("[ops/ajm/enrich-crm] failed:", err);
    return NextResponse.json({ error: err.message, rolledBack: true }, { status: 500 });
  }
}
