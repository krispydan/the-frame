export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const unread = url.searchParams.get("unread");
  const limit = parseInt(url.searchParams.get("limit") || "50");
  const offset = parseInt(url.searchParams.get("offset") || "0");
  const type = url.searchParams.get("type");

  let query = "SELECT * FROM notifications WHERE dismissed = 0";
  const params: any[] = [];

  if (unread === "true") {
    query += " AND read = 0";
  }
  if (type) {
    query += " AND type = ?";
    params.push(type);
  }

  query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);

  const rows = sqlite.prepare(query).all(...params);
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { type, title, message, severity, module, entity_id, entity_type } = body;

  if (!type || !title || !message || !severity || !module) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const id = crypto.randomUUID();
  sqlite.prepare(
    `INSERT INTO notifications (id, type, title, message, severity, module, entity_id, entity_type, read, dismissed, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, datetime('now'))`
  ).run(id, type, title, message, severity, module, entity_id || null, entity_type || null);

  return NextResponse.json({ id, success: true }, { status: 201 });
}
