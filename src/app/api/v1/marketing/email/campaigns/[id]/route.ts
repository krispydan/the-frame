export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { db, sqlite } from "@/lib/db";
import { emailCampaigns } from "@/modules/marketing/schema";
import { eq } from "drizzle-orm";
import { validateCampaignPatch } from "@/modules/marketing/lib/campaign-validation";
import { serializeFeaturedIds } from "@/modules/marketing/lib/featured-products";

/**
 * Whitelist of columns clients can PATCH directly. Everything else
 * (status transitions, AI metadata, exported_html_path) is set by
 * dedicated endpoints — never via free-form PATCH — to keep the
 * workflow explicit.
 */
const PATCHABLE_COLUMNS = new Set([
  "name",
  "status",
  "audience",
  "scheduledDate",
  "weekOf",
  "themeId",
  "briefTitle",
  "briefAngle",
  "briefProductHook",
  "briefSeasonalContext",
  "logoImagePath",
  "heroDisabled",
  "sectionADisabled",
  "secondaryDisabled",
  "sectionBDisabled",
  "subject",
  "preheader",
  "subjectAlt",
  "preheaderAlt",
  "heroVariant",
  "sectionAVariant",
  "secondaryImageVariant",
  "sectionBVariant",
  "heroHeadline",
  "heroSubtitle",
  "heroCtaLabel",
  "heroCtaUrl",
  "heroScrim",
  "heroTextPlacement",
  "heroImageFocal",
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
  "featuredProductIds",
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

  // Tight enum check — `status` is in PATCHABLE_COLUMNS but Drizzle's
  // enum isn't enforced at the SQL layer. Reject obvious garbage.
  if ("status" in body) {
    const VALID_STATUSES = ["draft", "copywriting", "photography", "design_review", "scheduled", "sent", "analyzed"];
    if (typeof body.status !== "string" || !VALID_STATUSES.includes(body.status)) {
      return NextResponse.json(
        { error: `status must be one of: ${VALID_STATUSES.join(", ")}` },
        { status: 400 },
      );
    }
  }
  if ("audience" in body) {
    if (body.audience !== "retail" && body.audience !== "wholesale") {
      return NextResponse.json(
        { error: "audience must be 'retail' or 'wholesale'" },
        { status: 400 },
      );
    }
  }

  // Variant enums / CTA URLs / date format / oversize-field guards.
  // (status + audience already checked above.)
  const validationErrors = validateCampaignPatch(body);
  if (validationErrors.length > 0) {
    return NextResponse.json(
      { error: "Validation failed", details: validationErrors },
      { status: 400 },
    );
  }

  // Defense-in-depth: belt + suspenders on the column name. The
  // PATCHABLE_COLUMNS allowlist is the primary gate, but in case
  // someone adds a column with an unsafe name in the future,
  // require the snake_cased name match [a-z_][a-z0-9_]* before
  // string-concatenating into the UPDATE.
  const COLUMN_NAME_RE = /^[a-z][a-z0-9_]*$/;

  // featured_product_ids is a JSON-array column — accept either a
  // pre-serialized string or a raw string[] from the client and store
  // a normalized JSON string (or NULL when empty).
  if ("featuredProductIds" in body) {
    const v = body.featuredProductIds;
    body.featuredProductIds = Array.isArray(v)
      ? serializeFeaturedIds(v as string[])
      : typeof v === "string" || v === null
      ? v
      : null;
  }

  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [key, val] of Object.entries(body)) {
    if (!PATCHABLE_COLUMNS.has(key)) continue;
    const column = toSnake(key);
    if (!COLUMN_NAME_RE.test(column)) continue;
    sets.push(`${column} = ?`);
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
