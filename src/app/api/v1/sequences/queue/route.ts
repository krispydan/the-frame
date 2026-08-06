/** Review queue: list items, and act on one (sent / skip / replied). */
import { NextRequest, NextResponse } from "next/server";
import { getQueue, queueCounts, markSent, markSkipped, markReplied } from "@/modules/sequences/lib/queue";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const brand = req.nextUrl.searchParams.get("brand") || undefined;
  const rawStatus = req.nextUrl.searchParams.get("status") || undefined;
  const ALLOWED = ["queued_review", "approved", "task_open", "sent", "skipped"];
  const status = rawStatus && ALLOWED.includes(rawStatus) ? rawStatus : undefined;
  // NaN or a negative limit reaches SQLite as a datatype error / "no limit".
  const limit = Math.min(Math.max(1, Number(req.nextUrl.searchParams.get("limit")) || 100), 500);
  return NextResponse.json({ items: getQueue({ brand, status, limit }), counts: queueCounts() });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { id, action, editedBody, by, reason } = body as {
    id?: string; action?: string; editedBody?: string; by?: string; reason?: string;
  };
  if (!id || !action) return NextResponse.json({ error: "id and action are required" }, { status: 400 });
  // A refusal must NOT return 200 — the client treated that as success, so a
  // suppressed or unsendable message vanished from the queue and was counted
  // as sent.
  const respond = (r: { ok: boolean; reason?: string }) =>
    NextResponse.json(r, { status: r.ok ? 200 : r.reason === "not_found" ? 404 : 409 });
  switch (action) {
    case "sent":    return respond(markSent(id, by || "user", editedBody));
    case "skip":    return respond(markSkipped(id, reason || "skipped by user"));
    case "replied": return respond(markReplied(id));
    default:        return NextResponse.json({ error: `unknown action: ${action}` }, { status: 400 });
  }
}
