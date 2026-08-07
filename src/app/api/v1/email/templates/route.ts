export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/get-session";
import {
  archiveTemplate, canEdit, getTemplate, listTemplates, MERGE_FIELDS,
  restoreTemplate, saveTemplate, type TemplateVisibility,
} from "@/modules/email/lib/templates";

/**
 * Saved messages.
 *
 * GET    ?includeArchived=1     → templates visible to me + the merge-field palette
 * POST   { id?, name, ... }     → create or update
 * DELETE ?id= [&restore=1]      → archive (or un-archive)
 */

export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const includeArchived = req.nextUrl.searchParams.get("includeArchived") === "1";
  const templates = listTemplates(user.id, { includeArchived }).map((t) => ({
    ...t,
    canEdit: canEdit(t, user.id, user.role),
    mine: t.owner_id === user.id,
  }));
  return NextResponse.json({ ok: true, templates, mergeFields: MERGE_FIELDS });
}

interface Body {
  id?: string;
  name?: string;
  category?: string | null;
  subject?: string | null;
  bodyHtml?: string | null;
  visibility?: TemplateVisibility;
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as Body | null;
  const name = body?.name?.trim();
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  if (!body?.subject?.trim() && !body?.bodyHtml?.trim()) {
    return NextResponse.json({ error: "subject or body required" }, { status: 400 });
  }

  if (body.id) {
    const existing = getTemplate(body.id, user.id);
    if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (!canEdit(existing, user.id, user.role)) {
      return NextResponse.json({ error: "this is someone else's template" }, { status: 403 });
    }
  }

  const id = saveTemplate(
    {
      name,
      category: body.category ?? null,
      subject: body.subject ?? null,
      bodyHtml: body.bodyHtml ?? null,
      visibility: body.visibility,
    },
    { id: user.id, name: user.name },
    body.id,
  );
  return NextResponse.json({ ok: true, id });
}

export async function DELETE(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const existing = getTemplate(id, user.id);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!canEdit(existing, user.id, user.role)) {
    return NextResponse.json({ error: "this is someone else's template" }, { status: 403 });
  }

  if (req.nextUrl.searchParams.get("restore") === "1") restoreTemplate(id);
  else archiveTemplate(id);
  return NextResponse.json({ ok: true });
}
