export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { resetDoc, getDoc, isKnownDoc } from "@/modules/marketing/lib/prompt-store";

/**
 * POST /api/v1/marketing/email/prompts/[slug]/reset
 * Restores a document to the current on-disk (shipped) default.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  if (!isKnownDoc(slug)) {
    return NextResponse.json({ error: "Unknown document" }, { status: 404 });
  }
  resetDoc(slug);
  return NextResponse.json({ doc: getDoc(slug) });
}
