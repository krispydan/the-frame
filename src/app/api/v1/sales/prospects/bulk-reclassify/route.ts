export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { icpClassifierHandler } from "@/modules/sales/agents/icp-classifier";
import { sqlite } from "@/lib/db";

interface Body {
  ids?: string[];
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: "Invalid X-Classifier-Token" }, { status: 401 });
  }

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const ids = Array.isArray(body.ids) ? Array.from(new Set(body.ids.filter(Boolean))) : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: "ids[] required" }, { status: 400 });
  }

  const existing = sqlite.prepare(`SELECT id FROM companies WHERE id = ?`);
  const validIds = ids.filter((id) => !!existing.get(id));

  try {
    await icpClassifierHandler({ companyIds: validIds });
  } catch (err) {
    return NextResponse.json({ error: "Bulk reclassify failed", details: String(err), attempted: validIds.length }, { status: 500 });
  }

  return NextResponse.json({ ok: true, reclassified: validIds.length, ids: validIds });
}

function checkAuth(req: NextRequest): boolean {
  const provided = req.headers.get("x-classifier-token");
  const expected = process.env.CLASSIFIER_TOKEN;
  if (!expected) return false;
  return !!provided && provided === expected;
}
