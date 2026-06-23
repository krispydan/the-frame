export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { db, sqlite } from "@/lib/db";
import { emailCampaigns } from "@/modules/marketing/schema";
import { eq } from "drizzle-orm";

/**
 * Whitelist of columns clients can PATCH directly. Everything else
 * (status transitions, AI metadata, exported_html_path) is set by
 * dedicated endpoints — never via free-form PATCH — to keep the
 * workflow explicit.
 */
const PATCHABLE_COLUMNS = new Set([
  "audience",
  "scheduledDate",
  "weekOf",
  "themeId",
  "subject",
  "preheader",
  "heroVariant",
  "sectionAVariant",
  "secondaryImageVariant",
  "sectionBVariant",
  "heroHeadline",
  "heroSubtitle",
  "heroCtaLabel",
  "heroCtaUrl",
  "heroScrim",
  "heroImagePath",
  "heroImageAlt",
  "heroImagePrompt",
  "sectionAHeading",
  "sectionABody",
  "secondaryImagePath",
  "secondaryImagePath2",
  "secondaryImageAlt",
  "secondaryImageAlt2",
  "secondaryImagePrompt",
  "secondaryImagePrompt2",
  "sectionBHeading",
  "sectionBBody",
  "sectionBCtaLabel",
  "sectionBCtaUrl",
  "utmCampaign",
  "designerNotes",
]);

/** Convert camelCase → snake_case for raw SQL UPDATE. */
function toSnake(s: string): string {
  return s.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase());
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const [row] = await db
    .select()
    .from(emailCampaigns)
    .where(eq(emailCampaigns.id, id))
    .limit(1);
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ campaign: row });
}

/**
 * Partial update of any whitelisted column. Unknown keys are
 * silently dropped (not echoed back as errors) — the client may
 * send full row JSON and only changed fields actually persist.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }

  const [existing] = await db
    .select()
    .from(emailCampaigns)
    .where(eq(emailCampaigns.id, id))
    .limit(1);
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [key, val] of Object.entries(body)) {
    if (!PATCHABLE_COLUMNS.has(key)) continue;
    sets.push(`${toSnake(key)} = ?`);
    vals.push(val);
  }

  if (sets.length === 0) {
    return NextResponse.json({ campaign: existing });
  }

  sets.push(`updated_at = datetime('now')`);
  vals.push(id);
  sqlite
    .prepare(`UPDATE marketing_email_campaigns SET ${sets.join(", ")} WHERE id = ?`)
    .run(...vals);

  const [row] = await db
    .select()
    .from(emailCampaigns)
    .where(eq(emailCampaigns.id, id))
    .limit(1);
  return NextResponse.json({ campaign: row });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  await db.delete(emailCampaigns).where(eq(emailCampaigns.id, id));
  return NextResponse.json({ ok: true });
}
