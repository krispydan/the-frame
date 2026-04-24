export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/get-session";
import { sqlite } from "@/lib/db";
import bcrypt from "bcryptjs";

// POST /api/v1/settings/users/[id]/password — admin set/reset a user's password
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await getSessionUser();
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (admin.role !== "owner") {
    return NextResponse.json({ error: "Only owners can reset passwords" }, { status: 403 });
  }

  const { id } = await params;
  const { password } = await req.json();

  if (!password || password.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
  }

  const user = sqlite.prepare("SELECT id, name, email FROM users WHERE id = ?").get(id) as { id: string; name: string; email: string } | undefined;
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const hash = await bcrypt.hash(password, 10);
  sqlite
    .prepare("UPDATE users SET password_hash = ?, password_reset_token = NULL, password_reset_expires = NULL, updated_at = datetime('now') WHERE id = ?")
    .run(hash, id);

  return NextResponse.json({ ok: true, message: `Password set for ${user.name}` });
}

// DELETE /api/v1/settings/users/[id]/password — clear a user's password (force magic link only)
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await getSessionUser();
  if (!admin) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (admin.role !== "owner") {
    return NextResponse.json({ error: "Only owners can manage passwords" }, { status: 403 });
  }

  const { id } = await params;
  sqlite
    .prepare("UPDATE users SET password_hash = NULL, updated_at = datetime('now') WHERE id = ?")
    .run(id);

  return NextResponse.json({ ok: true });
}
