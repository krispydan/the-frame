import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { sqlite } from "@/lib/db";

// PATCH /api/v1/settings/users/[id] — update role or active status
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "owner") {
    return NextResponse.json({ error: "Only owners can edit users" }, { status: 403 });
  }

  const { id } = await params;
  const body = await req.json();

  // Can't deactivate yourself
  if (body.is_active === false && id === session.user.id) {
    return NextResponse.json({ error: "You cannot deactivate yourself" }, { status: 400 });
  }

  const updates: string[] = [];
  const values: (string | number)[] = [];

  if (body.role !== undefined) {
    updates.push("role = ?");
    values.push(body.role);
  }
  if (body.is_active !== undefined) {
    updates.push("is_active = ?");
    values.push(body.is_active ? 1 : 0);
  }

  if (updates.length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  updates.push("updated_at = datetime('now')");
  values.push(id);

  sqlite.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`).run(...values);

  return NextResponse.json({ ok: true });
}
