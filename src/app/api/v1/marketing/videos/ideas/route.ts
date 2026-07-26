/**
 * Idea Bank API (engine #3 / #6).
 *   GET                       → list ideas (optionally ?status=new|used|dismissed)
 *   POST { count?, productId? } → generate a fresh batch (uses the vitality backbone)
 *   PATCH { id, status }      → mark an idea used / dismissed / new
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { listIdeas, generateIdeas, setIdeaStatus } from "@/modules/marketing/lib/video/video-ideas";

export async function GET(request: NextRequest) {
  const status = request.nextUrl.searchParams.get("status") as "new" | "used" | "dismissed" | null;
  return NextResponse.json({ ideas: listIdeas(status ?? undefined) });
}

export async function POST(request: NextRequest) {
  let body: { count?: unknown; productId?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    /* empty body = defaults */
  }

  let product: { id: string; name: string } | null = null;
  if (typeof body.productId === "string" && body.productId) {
    const row = sqlite.prepare(`SELECT id, name FROM catalog_products WHERE id = ?`).get(body.productId) as
      | { id: string; name: string }
      | undefined;
    if (!row) return NextResponse.json({ error: "Product not found" }, { status: 404 });
    product = { id: row.id, name: row.name };
  }

  const result = await generateIdeas({ count: typeof body.count === "number" ? body.count : undefined, product });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 });
  return NextResponse.json({ ideas: result.ideas });
}

export async function PATCH(request: NextRequest) {
  let body: { id?: unknown; status?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }
  const id = typeof body.id === "string" ? body.id : "";
  const status = String(body.status);
  if (!id || !["new", "used", "dismissed"].includes(status)) {
    return NextResponse.json({ error: "id and status (new|used|dismissed) required" }, { status: 400 });
  }
  const ok = setIdeaStatus(id, status as "new" | "used" | "dismissed");
  return NextResponse.json({ ok }, { status: ok ? 200 : 404 });
}
