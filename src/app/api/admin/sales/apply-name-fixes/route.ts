export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * POST /api/admin/sales/apply-name-fixes
 *
 * Apply a pre-computed list of (companyId, newName) pairs in a single
 * transaction. Used to land the bulk name-cleanup produced by
 * scripts/fix-boutique-names.py.
 *
 * Body:
 *   {
 *     fixes: Array<{ id: string; before?: string; after: string; reasons?: string[] }>,
 *     dryRun?: boolean
 *   }
 *
 * The `before` field is optional but, when provided, is used as a safety
 * check — the update is skipped (and counted as `skipped_drift`) if the
 * current value doesn't match `before` anymore. This protects against
 * applying stale fixes if someone renamed the record in the meantime.
 *
 * Idempotent: applying twice is a no-op (the second pass sees the
 * already-fixed value and skips via the drift check).
 *
 * Auth: x-admin-key: jaxy2026
 */
interface Fix {
  id: string;
  before?: string;
  after: string;
  reasons?: string[];
}

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { fixes?: Fix[]; dryRun?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }
  const fixes = Array.isArray(body.fixes) ? body.fixes : [];
  if (fixes.length === 0) {
    return NextResponse.json({ error: "fixes[] required" }, { status: 400 });
  }
  const dryRun = body.dryRun === true;

  const getCurrent = sqlite.prepare("SELECT name FROM companies WHERE id = ?");
  const update = sqlite.prepare(
    "UPDATE companies SET name = ?, updated_at = datetime('now') WHERE id = ?",
  );

  let applied = 0;
  let skippedDrift = 0;
  let skippedMissing = 0;
  let skippedNoChange = 0;
  const driftSample: Array<{ id: string; expected: string; actual: string }> = [];

  const apply = (f: Fix): "ok" | "drift" | "missing" | "noop" => {
    const row = getCurrent.get(f.id) as { name: string | null } | undefined;
    if (!row) return "missing";
    const current = row.name ?? "";
    if (f.before !== undefined && current !== f.before) {
      if (driftSample.length < 10) {
        driftSample.push({ id: f.id, expected: f.before, actual: current });
      }
      return "drift";
    }
    if (current === f.after) return "noop";
    if (!dryRun) update.run(f.after, f.id);
    return "ok";
  };

  const txn = sqlite.transaction(() => {
    for (const f of fixes) {
      const r = apply(f);
      if (r === "ok") applied++;
      else if (r === "drift") skippedDrift++;
      else if (r === "missing") skippedMissing++;
      else skippedNoChange++;
    }
  });
  txn();

  return NextResponse.json({
    ok: true,
    dry_run: dryRun,
    counts: {
      total: fixes.length,
      applied,
      skippedDrift,
      skippedMissing,
      skippedNoChange,
    },
    driftSample,
  });
}
