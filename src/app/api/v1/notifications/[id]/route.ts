export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const fields: string[] = [];
  const values: any[] = [];

  if (body.read !== undefined) {
    fields.push("read = ?");
    values.push(body.read ? 1 : 0);
  }
  if (body.dismissed !== undefined) {
    fields.push("dismissed = ?");
    values.push(body.dismissed ? 1 : 0);
  }

  if (fields.length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  values.push(id);
  sqlite.prepare(`UPDATE notifications SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return NextResponse.json({ success: true });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  sqlite.prepare("DELETE FROM notifications WHERE id = ?").run(id);
  return NextResponse.json({ success: true });
}
