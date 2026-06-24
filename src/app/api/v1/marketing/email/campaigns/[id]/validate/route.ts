export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { emailCampaigns } from "@/modules/marketing/schema";
import { eq } from "drizzle-orm";
import { lintCopy } from "@/modules/marketing/lib/copy-quality";

/**
 * GET /api/v1/marketing/email/campaigns/[id]/validate
 *
 * On-demand QA: runs the deterministic copy linter (brand + hard-shape
 * rules) and a readiness check on the CURRENT row — so hand-edited copy
 * gets the same QA the AI output does, not just at generate time.
 */
function readiness(c: Record<string, unknown>): { ready: boolean; missing: string[] } {
  const has = (k: string) => typeof c[k] === "string" && (c[k] as string).trim().length > 0;
  const missing: string[] = [];
  if (!has("subject")) missing.push("subject");
  if (!has("heroHeadline") && !c.heroDisabled) missing.push("hero headline");
  if (!has("sectionABody") && !c.sectionADisabled) missing.push("section A body");
  if (!has("sectionBBody") && !c.sectionBDisabled) missing.push("section B body");
  if (!has("heroImagePath") && !c.heroDisabled) missing.push("hero image");
  if (!has("secondaryImagePath") && !c.secondaryDisabled) missing.push("secondary image");
  if (c.secondaryImageVariant === "grid_2up" && !c.secondaryDisabled && !has("secondaryImagePath2"))
    missing.push("secondary image 2");
  return { ready: missing.length === 0, missing };
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
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const lint = lintCopy(row, row.audience as "retail" | "wholesale");
  const ready = readiness(row as unknown as Record<string, unknown>);
  return NextResponse.json({ ok: lint.ok && ready.ready, lint, readiness: ready });
}
