export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { requireOpsToken } from "@/lib/ops-auth";
import { buildCohort } from "@/modules/sales/lib/instantly-cohort";
import { verifyProspectEmails } from "@/modules/sales/lib/neverbounce/verify-prospects";

/**
 * The next Instantly cohort: who to push, and getting their emails verified.
 *
 * GET  ?limit=&minScore=[&full=1]        → funnel, breakdown, ranked selection
 * POST ?confirm=1 {action:'verify', limit, minScore, verifyLimit}
 *                                        → NeverBounce the cohort (spends credits)
 *
 * Verification is CHUNKED: `verifyLimit` (default 100) caps how many addresses
 * one call will check. Verifying a thousand at concurrency 5 takes far longer
 * than the ~100s an external request survives, and a request killed mid-flight
 * still spent every credit it used. Call repeatedly — already-verified rows are
 * skipped, so each call picks up where the last stopped.
 *
 * Deliberately has NO push action. Selecting and verifying is reversible;
 * pushing to Instantly starts mail going to real shops, and that decision stays
 * with a human until it is explicitly asked for.
 */

export async function GET(req: NextRequest) {
  const denied = requireOpsToken(req);
  if (denied) return denied;

  const p = req.nextUrl.searchParams;
  const limit = Math.min(Number(p.get("limit")) || 1000, 5000);
  const minScore = Number(p.get("minScore")) || 0;
  const res = buildCohort(limit, minScore);

  // The full list is large; summary by default, rows on request.
  if (p.get("full") !== "1") {
    return NextResponse.json({
      ok: true,
      ...res,
      selected: res.selected.slice(0, 25),
      note: `showing 25 of ${res.selected.length} — add &full=1 for all rows`,
    });
  }
  return NextResponse.json({ ok: true, ...res });
}

export async function POST(req: NextRequest) {
  const denied = requireOpsToken(req);
  if (denied) return denied;
  if (req.nextUrl.searchParams.get("confirm") !== "1") {
    return NextResponse.json({ error: "add ?confirm=1" }, { status: 400 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    action?: string; limit?: number; minScore?: number; concurrency?: number;
    verifyLimit?: number;
  };

  // Fail closed: an unrecognised action must never fall through to the
  // operation that spends money. See AGENTS.md, "Never poll a POST endpoint".
  if (body.action !== "verify") {
    return NextResponse.json(
      { error: `unknown action '${body.action ?? "(none)"}' — this endpoint supports: verify` },
      { status: 400 },
    );
  }

  const limit = Math.min(Number(body.limit) || 1000, 5000);
  const cohort = buildCohort(limit, Number(body.minScore) || 0);

  // Only pay for addresses whose status we do not already hold. verifyProspectEmails
  // skips already-verified rows itself, but filtering here keeps the reported
  // credit estimate honest.
  const needing = cohort.selected.filter((s) => !s.verification || s.verification === "error");
  const verifyLimit = Math.min(Number(body.verifyLimit) || 100, 500);
  const batch = needing.slice(0, verifyLimit);

  const stats = await verifyProspectEmails({
    companyIds: batch.map((s) => s.companyId),
    concurrency: Math.min(Number(body.concurrency) || 5, 10),
  });

  return NextResponse.json({
    ok: true,
    cohortSize: cohort.selected.length,
    stillNeedingVerification: Math.max(0, needing.length - batch.length),
    submittedThisCall: batch.length,
    stats,
  });
}
