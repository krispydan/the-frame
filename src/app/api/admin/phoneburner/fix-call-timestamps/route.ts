export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { pbTimeToUtcIso } from "@/modules/sales/lib/phoneburner-sync";

/**
 * POST /api/admin/phoneburner/fix-call-timestamps
 *
 * One-shot backfill. PhoneBurner webhooks stored call_log.called_at as
 * naive Central-time strings ("2026-06-19 12:21:41"). The digest's
 * PT-day-bounds comparison is against UTC ISO, so those rows sorted
 * below the lower bound and got excluded → digest showed 0 calls.
 *
 * This rewrites every non-ISO called_at to proper UTC ISO via
 * pbTimeToUtcIso() (Central → UTC, DST-safe). Idempotent: rows already
 * ending in 'Z' are skipped.
 *
 * Auth: x-admin-key: jaxy2026
 */
export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const rows = sqlite
    .prepare(
      "SELECT id, called_at FROM phoneburner_call_log WHERE called_at NOT LIKE '%Z'",
    )
    .all() as Array<{ id: string; called_at: string }>;

  const upd = sqlite.prepare(
    "UPDATE phoneburner_call_log SET called_at = ? WHERE id = ?",
  );
  let fixed = 0;
  const samples: Array<{ before: string; after: string }> = [];
  const txn = sqlite.transaction(() => {
    for (const r of rows) {
      const iso = pbTimeToUtcIso(r.called_at);
      if (iso !== r.called_at) {
        upd.run(iso, r.id);
        if (samples.length < 5) samples.push({ before: r.called_at, after: iso });
        fixed++;
      }
    }
  });
  txn();

  return NextResponse.json({
    ok: true,
    scanned: rows.length,
    fixed,
    samples,
  });
}
