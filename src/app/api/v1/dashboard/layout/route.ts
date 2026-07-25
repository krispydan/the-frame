export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { getSessionUser } from "@/lib/get-session";
import { defaultLayout, sanitizeLayout, allowedWidgetIds } from "@/modules/dashboard/widgets";

/**
 * Per-user dashboard layout (ordered list of visible widget ids).
 *
 * GET  → { layout, allowed, isDefault } — the saved layout or the role default,
 *        plus the full set of widgets this role may add.
 * PUT  { widgets: string[] } → persist (sanitized to what the role may see).
 * DELETE → reset to the role default.
 *
 * Stored in the settings table under "dashboard:layout:<userId>".
 */

function key(userId: string) {
  return `dashboard:layout:${userId}`;
}

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const row = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(key(user.id)) as { value: string | null } | undefined;
  let layout = defaultLayout(user.role);
  let isDefault = true;
  if (row?.value) {
    try {
      const saved = JSON.parse(row.value) as { widgets?: string[] };
      const clean = sanitizeLayout(user.role, saved.widgets ?? []);
      if (clean.length) {
        layout = clean;
        isDefault = false;
      }
    } catch {
      /* fall back to default */
    }
  }
  return NextResponse.json({ layout, allowed: allowedWidgetIds(user.role), isDefault, role: user.role });
}

export async function PUT(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const widgets = sanitizeLayout(user.role, Array.isArray(body.widgets) ? body.widgets : []);
  sqlite
    .prepare(
      `INSERT INTO settings (key, value, type, module, updated_at)
       VALUES (?, ?, 'json', 'dashboard', datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    )
    .run(key(user.id), JSON.stringify({ widgets }));
  return NextResponse.json({ ok: true, layout: widgets });
}

export async function DELETE() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  sqlite.prepare("DELETE FROM settings WHERE key = ?").run(key(user.id));
  return NextResponse.json({ ok: true, layout: defaultLayout(user.role) });
}
