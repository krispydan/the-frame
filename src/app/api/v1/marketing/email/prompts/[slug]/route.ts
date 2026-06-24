export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getDoc, updateDoc, isKnownDoc } from "@/modules/marketing/lib/prompt-store";

/**
 * GET  /api/v1/marketing/email/prompts/[slug]  → full editor view
 * PUT  /api/v1/marketing/email/prompts/[slug]  → save edited content
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const doc = getDoc(slug);
  if (!doc) return NextResponse.json({ error: "Unknown document" }, { status: 404 });
  return NextResponse.json({ doc });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  if (!isKnownDoc(slug)) {
    return NextResponse.json({ error: "Unknown document" }, { status: 404 });
  }
  let body: { content?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }
  if (typeof body.content !== "string") {
    return NextResponse.json({ error: "content (string) required" }, { status: 400 });
  }
  // Guard against blanking a prompt — that would silently break
  // generation. Reset-to-default is the way to clear an edit.
  if (!body.content.trim()) {
    return NextResponse.json({ error: "content cannot be empty (use reset to restore the default)" }, { status: 400 });
  }
  updateDoc(slug, body.content);
  return NextResponse.json({ doc: getDoc(slug) });
}
