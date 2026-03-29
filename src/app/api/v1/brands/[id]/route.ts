export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const brand = sqlite.prepare(`
    SELECT b.*, count(cbl.id) as match_count
    FROM brand_accounts b
    LEFT JOIN company_brand_links cbl ON cbl.brand_account_id = b.id
    WHERE b.id = ?
    GROUP BY b.id
  `).get(id) as Record<string, unknown> | undefined;

  if (!brand) {
    return NextResponse.json({ error: "Brand not found" }, { status: 404 });
  }

  // Get linked companies
  const companies = sqlite.prepare(`
    SELECT c.id, c.name, c.status, c.icp_score, c.icp_tier, c.city, c.state,
           c.email, c.website, c.phone, c.disqualify_reason
    FROM companies c
    INNER JOIN company_brand_links cbl ON cbl.company_id = c.id
    WHERE cbl.brand_account_id = ?
    ORDER BY c.icp_score DESC NULLS LAST, c.name ASC
  `).all(id) as Record<string, unknown>[];

  return NextResponse.json({ brand, companies });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json();

  const allowedFields: Record<string, string> = {
    name: "name",
    website: "website",
    sector: "sector",
    relevance: "relevance",
    brand_type: "brand_type",
  };

  const setClauses: string[] = [];
  const setParams: unknown[] = [];

  for (const [key, col] of Object.entries(allowedFields)) {
    if (key in body) {
      setClauses.push(`${col} = ?`);
      setParams.push(body[key]);
    }
  }

  if (setClauses.length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  setClauses.push("updated_at = ?");
  setParams.push(new Date().toISOString());
  setParams.push(id);

  const result = sqlite.prepare(`UPDATE brand_accounts SET ${setClauses.join(", ")} WHERE id = ?`).run(...setParams);

  if (result.changes === 0) {
    return NextResponse.json({ error: "Brand not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
