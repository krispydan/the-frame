export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/get-session";
import { getTemplate, markUsed, renderForCompany } from "@/modules/email/lib/templates";

/**
 * Resolve a template's merge fields for a specific store, ready to paste.
 *
 * POST { templateId, companyId?, preview? }
 *   → { subject, bodyHtml, missing[], warnings[] }
 *
 * `preview: true` renders without counting a use — the editor's live preview
 * should not inflate the picker's usage ranking.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | { templateId?: string; companyId?: string | null; preview?: boolean }
    | null;
  if (!body?.templateId) return NextResponse.json({ error: "templateId required" }, { status: 400 });

  const t = getTemplate(body.templateId, user.id);
  if (!t) return NextResponse.json({ error: "not found" }, { status: 404 });

  const rendered = renderForCompany(t, body.companyId ?? null, {
    my_first_name: (user.name || "").split(" ")[0],
    my_name: user.name,
    my_email: user.email,
  });

  if (!body.preview) markUsed(t.id);

  return NextResponse.json({ ok: true, ...rendered });
}
