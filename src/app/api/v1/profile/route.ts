import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // Get first user (single-tenant for now)
    const user = sqlite
      .prepare(`SELECT id, email, name, role, is_active, last_login_at, created_at, updated_at FROM users LIMIT 1`)
      .get() as Record<string, unknown> | undefined;

    if (!user) {
      return NextResponse.json({ error: "No user found" }, { status: 404 });
    }

    // Get recent activity from change_logs
    let activity: Record<string, unknown>[] = [];
    try {
      activity = sqlite
        .prepare(
          `SELECT id, timestamp, entity_type, entity_id, field, old_value, new_value, source, agent_type
           FROM change_logs ORDER BY timestamp DESC LIMIT 20`
        )
        .all() as Record<string, unknown>[];
    } catch {
      // change_logs table may not exist yet
    }

    return NextResponse.json({ user, activity });
  } catch (error) {
    console.error("GET /api/v1/profile error:", error);
    return NextResponse.json({ error: "Failed to fetch profile" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, email } = body;

    if (!name && !email) {
      return NextResponse.json({ error: "Name or email required" }, { status: 400 });
    }

    // Get current user
    const user = sqlite
      .prepare(`SELECT id FROM users LIMIT 1`)
      .get() as { id: string } | undefined;

    if (!user) {
      return NextResponse.json({ error: "No user found" }, { status: 404 });
    }

    const updates: string[] = [];
    const params: Record<string, string> = {};

    if (name) {
      updates.push("name = @name");
      params.name = name;
    }
    if (email) {
      updates.push("email = @email");
      params.email = email;
    }
    updates.push("updated_at = datetime('now')");

    sqlite
      .prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = @id`)
      .run({ ...params, id: user.id });

    const updated = sqlite
      .prepare(`SELECT id, email, name, role, is_active, last_login_at, created_at, updated_at FROM users WHERE id = ?`)
      .get(user.id);

    return NextResponse.json({ user: updated });
  } catch (error) {
    console.error("PUT /api/v1/profile error:", error);
    return NextResponse.json({ error: "Failed to update profile" }, { status: 500 });
  }
}
