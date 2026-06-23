export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { emailCampaigns } from "@/modules/marketing/schema";
import { eq } from "drizzle-orm";
import { lintCopy } from "@/modules/marketing/lib/copy-quality";

/**
 * GET /api/v1/marketing/email/campaigns/[id]/validate
 *
 * Deterministic, server-side QA: runs the copy linter (brand + hard
 * shape rules) and a readiness check (everything the email needs to
 * render before you export it to an image). The editor calls this to
 * show red (errors) / amber (warnings).
 */
function readiness(c: Record<string, unknown>): { ready: boolean; missing: string[] } {
  const has = (k: string) => typeof c[k] === "string" && (c[k] as string).trim().length > 0;
  const missing: string[] = [];
  if (!has("subject")) missing.push("subject");
  if (!has("heroHeadline")) missing.push("hero headline");
  if (!has("sectionABody")) missing.push("section A body");
  if (!has("sectionBBody")) missing.push("section B body");
  if (!has("heroImagePath")) missing.push("hero image");
  if (!has("secondaryImagePath")) missing.push("secondary image");
  if (c.secondaryImageVariant === "grid_2up" && !has("secondaryImagePath2")) missing.push("secondary image 2");
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
