export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { listDocs } from "@/modules/marketing/lib/prompt-store";

/**
 * GET /api/v1/marketing/email/prompts
 * Lists every editable AI document (prompts + brand-voice docs) with
 * metadata + whether it's been edited away from the shipped default.
 */
export async function GET() {
  return NextResponse.json({ docs: listDocs() });
}
