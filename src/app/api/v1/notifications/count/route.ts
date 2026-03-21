export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

export async function GET() {
  const row = sqlite.prepare("SELECT COUNT(*) as unread FROM notifications WHERE read = 0 AND dismissed = 0").get() as any;
  return NextResponse.json({ unread: row?.unread ?? 0 });
}
