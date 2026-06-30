export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import {
  parseCatalogList,
  backfillCatalogInterest,
  startCatalogBackfill,
  readCatalogBackfillState,
} from "@/modules/sales/lib/catalog-interest-backfill";

/**
 * Catalog-interest backfill from a pasted PhoneBurner follow-up list.
 *
 *   GET                          → background run state
 *   POST { list, dryRun: true }  → parse + match + count (no writes), fast
 *   POST { list }                → start the background backfill, return immediately
 */
export async function GET() {
  return NextResponse.json({ ok: true, state: readCatalogBackfillState() });
}

export async function POST(req: NextRequest) {
  let body: { list?: string; dryRun?: boolean; createMissing?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "JSON body required" }, { status: 400 });
  }
  if (!body.list || typeof body.list !== "string") {
    return NextResponse.json({ ok: false, error: "list (string) required" }, { status: 400 });
  }

  const rows = parseCatalogList(body.list);
  if (rows.length === 0) return NextResponse.json({ ok: false, error: "no emails found in the list" }, { status: 400 });

  if (body.dryRun) {
    const preview = await backfillCatalogInterest(rows, { dryRun: true, createMissing: body.createMissing });
    return NextResponse.json({ ok: true, dryRun: true, preview });
  }

  const r = startCatalogBackfill(rows, { createMissing: body.createMissing });
  return NextResponse.json({ ok: r.started, ...r, parsed: rows.length });
}
