/** Review queue: list items, and act on one (sent / skip / replied). */
import { NextRequest, NextResponse } from "next/server";
import { getQueue, queueCounts, markSent, markSkipped, markReplied } from "@/modules/sequences/lib/queue";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const brand = req.nextUrl.searchParams.get("brand") || undefined;
  const status = req.nextUrl.searchParams.get("status") || undefined;
  const limit = Number(req.nextUrl.searchParams.get("limit") || 100);
  return NextResponse.json({ items: getQueue({ brand, status, limit }), counts: queueCounts() });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { id, action, editedBody, by, reason } = body as {
    id?: string; action?: string; editedBody?: string; by?: string; reason?: string;
  };
  if (!id || !action) return NextResponse.json({ error: "id and action are required" }, { status: 400 });
  switch (action) {
    case "sent":    return NextResponse.json(markSent(id, by || "user", editedBody));
    case "skip":    return NextResponse.json(markSkipped(id, reason || "skipped by user"));
    case "replied": return NextResponse.json(markReplied(id));
    default:        return NextResponse.json({ error: `unknown action: ${action}` }, { status: 400 });
  }
}
