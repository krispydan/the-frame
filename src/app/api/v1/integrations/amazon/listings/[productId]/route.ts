export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { db, sqlite } from "@/lib/db";
import { amazonListings, copyVersions } from "@/modules/catalog/schema";
import { eq } from "drizzle-orm";

/**
 * GET  /api/v1/integrations/amazon/listings/:productId
 * PATCH /api/v1/integrations/amazon/listings/:productId
 *
 * Per-product read + edit for the catalog_amazon_listings row. The
 * product detail page's Amazon tab uses this so users can review and
 * tighten Claude's draft before downloading the spreadsheet.
 *
 * PATCH body is a sparse object — only included keys are written, so
 * partial saves are safe. Every PATCH also appends a copyVersions audit
 * row with the post-edit content so we never lose what was AI-generated
 * vs human-edited.
 */

type ListingRow = typeof amazonListings.$inferSelect;

/** Fields the operator is allowed to edit. The suggested_* enums are
 *  editable but the validator will block invalid values at download
 *  time. modelUsed / promptVersion / generatedAt are AI provenance and
 *  not editable here — regeneration is the way to refresh them. */
const EDITABLE_FIELDS = [
  "amazonTitle",
  "bulletPoint1",
  "bulletPoint2",
  "bulletPoint3",
  "bulletPoint4",
  "bulletPoint5",
  "productDescription",
  "genericKeywords",
  "suggestedColorMap",
  "suggestedLensMaterial",
  "suggestedFrameMaterial",
  "suggestedPolarization",
  "suggestedItemShape",
] as const;
type EditableField = (typeof EDITABLE_FIELDS)[number];

const EDITABLE_FIELD_SET = new Set<string>(EDITABLE_FIELDS);

// Map TS camelCase → SQL snake_case for the dynamic UPDATE.
const COL_BY_KEY: Record<EditableField, string> = {
  amazonTitle: "amazon_title",
  bulletPoint1: "bullet_point_1",
  bulletPoint2: "bullet_point_2",
  bulletPoint3: "bullet_point_3",
  bulletPoint4: "bullet_point_4",
  bulletPoint5: "bullet_point_5",
  productDescription: "product_description",
  genericKeywords: "generic_keywords",
  suggestedColorMap: "suggested_color_map",
  suggestedLensMaterial: "suggested_lens_material",
  suggestedFrameMaterial: "suggested_frame_material",
  suggestedPolarization: "suggested_polarization",
  suggestedItemShape: "suggested_item_shape",
};

interface RouteContext {
  params: Promise<{ productId: string }>;
}

export async function GET(_req: NextRequest, ctx: RouteContext) {
  const { productId } = await ctx.params;
  const row = await db
    .select()
    .from(amazonListings)
    .where(eq(amazonListings.productId, productId))
    .get();
  return NextResponse.json({ ok: true, listing: row ?? null });
}

export async function PATCH(req: NextRequest, ctx: RouteContext) {
  const { productId } = await ctx.params;

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  // Pluck out only the fields we allow editing. Empty strings persist
  // (operator may want to blank a bullet to test how validation reacts);
  // null also persists. Other types are rejected.
  const updates: Partial<Record<EditableField, string | null>> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!EDITABLE_FIELD_SET.has(key)) continue;
    if (value === null) {
      updates[key as EditableField] = null;
    } else if (typeof value === "string") {
      updates[key as EditableField] = value;
    } else {
      return NextResponse.json(
        { ok: false, error: `Field ${key} must be string or null` },
        { status: 400 },
      );
    }
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ ok: false, error: "No editable fields in body" }, { status: 400 });
  }

  const existing = await db
    .select()
    .from(amazonListings)
    .where(eq(amazonListings.productId, productId))
    .get();
  if (!existing) {
    // We don't auto-create empty rows from the editor — the operator
    // should run Generate first. Surface a clear error so the UI can
    // suggest that path.
    return NextResponse.json(
      { ok: false, error: "No listing exists for this product yet. Run Generate first." },
      { status: 404 },
    );
  }

  // Dynamic UPDATE — only touch the columns the body actually mentioned.
  const setClauses: string[] = [];
  const setValues: (string | null)[] = [];
  for (const [key, value] of Object.entries(updates)) {
    setClauses.push(`${COL_BY_KEY[key as EditableField]} = ?`);
    setValues.push(value);
  }
  setClauses.push("updated_at = datetime('now')");

  sqlite
    .prepare(`UPDATE catalog_amazon_listings SET ${setClauses.join(", ")} WHERE product_id = ?`)
    .run(...setValues, productId);

  // Re-read so the response reflects the merged post-edit state.
  const fresh = await db
    .select()
    .from(amazonListings)
    .where(eq(amazonListings.productId, productId))
    .get();

  // Append an audit row capturing the full post-edit listing so we never
  // lose track of what was AI-generated vs human-edited. aiModel='manual'
  // distinguishes from the model-stamped rows the orchestrator writes.
  try {
    db.insert(copyVersions).values({
      productId,
      fieldName: "amazon_listing",
      content: JSON.stringify(serialiseForAudit(fresh)),
      aiModel: "manual",
    }).run();
  } catch (e) {
    console.error("[amazon listing PATCH] audit insert failed:", e);
  }

  return NextResponse.json({ ok: true, listing: fresh });
}

function serialiseForAudit(row: ListingRow | undefined) {
  if (!row) return null;
  return {
    title: row.amazonTitle,
    bullet_points: [
      row.bulletPoint1, row.bulletPoint2, row.bulletPoint3,
      row.bulletPoint4, row.bulletPoint5,
    ],
    description: row.productDescription,
    generic_keywords: row.genericKeywords,
    suggested_color_map: row.suggestedColorMap,
    suggested_lens_material: row.suggestedLensMaterial,
    suggested_frame_material: row.suggestedFrameMaterial,
    suggested_polarization: row.suggestedPolarization,
    suggested_item_shape: row.suggestedItemShape,
  };
}
