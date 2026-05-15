export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: "Invalid X-Classifier-Token" }, { status: 401 });
  }

  const limit = Math.min(parseInt(req.nextUrl.searchParams.get("limit") ?? "500", 10) || 500, 2000);

  const rows = sqlite.prepare(`
    SELECT id, name, website, city, state, status, category, disqualify_reason, notes, tags, updated_at
    FROM companies
    WHERE status = 'not_qualified'
      AND (
        lower(coalesce(name, '')) LIKE '%hotel%'
        OR lower(coalesce(name, '')) LIKE '%resort%'
        OR lower(coalesce(name, '')) LIKE '%lodge%'
        OR lower(coalesce(name, '')) LIKE '%inn%'
        OR lower(coalesce(name, '')) LIKE '%villa%'
        OR lower(coalesce(name, '')) LIKE '%marina%'
        OR lower(coalesce(name, '')) LIKE '%spa%'
        OR lower(coalesce(disqualify_reason, '')) LIKE '%hotel%'
        OR lower(coalesce(disqualify_reason, '')) LIKE '%resort%'
        OR lower(coalesce(disqualify_reason, '')) LIKE '%lodge%'
        OR lower(coalesce(disqualify_reason, '')) LIKE '%inn%'
        OR lower(coalesce(disqualify_reason, '')) LIKE '%villa%'
        OR lower(coalesce(disqualify_reason, '')) LIKE '%marina%'
        OR lower(coalesce(disqualify_reason, '')) LIKE '%spa%'
      )
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(limit) as Array<Record<string, unknown>>;

  const candidates = rows.map((r) => ({
    ...r,
    tags: safeJsonArray(r.tags),
  }));

  return NextResponse.json({ count: candidates.length, candidates });
}

function safeJsonArray(v: unknown): string[] {
  if (!v || typeof v !== 'string') return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function checkAuth(req: NextRequest): boolean {
  const provided = req.headers.get("x-classifier-token");
  const expected = process.env.CLASSIFIER_TOKEN;
  if (!expected) return false;
  return !!provided && provided === expected;
}
