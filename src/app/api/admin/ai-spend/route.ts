/**
 * GET  /api/admin/ai-spend  → what the AI vision matcher is set to, what
 *                             it has actually been running on, and what
 *                             is still queued to spend money.
 * POST /api/admin/ai-spend  → cancel every queued/running identification
 *                             job. The emergency stop.
 *
 * Exists because a bulk identification run is the only thing in this app
 * that can spend real money unattended, and until now the only way to
 * know what it was costing was the invoice: the cost logger was pinned to
 * Haiku's rates no matter which model actually ran.
 *
 * Auth: x-admin-key (same key as the other admin routes).
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import {
  skuMatchModel,
  skuMatchDisabled,
  skuMatchMaxUsd,
  modelPricing,
  isCheapVisionModel,
} from "@/modules/marketing/lib/ai-model";

const AI_JOB_TYPES = ["marketing.media.frameshape-all", "marketing.media.identify"];

function snapshot() {
  const model = skuMatchModel();
  const price = modelPricing(model);

  // What the matcher has ACTUALLY been running on — the configured model
  // is only what it would use next.
  const modelsUsed = sqlite
    .prepare(
      `SELECT model, COUNT(*) AS n, MIN(created_at) AS firstAt, MAX(updated_at) AS lastAt
         FROM marketing_media_matches
        WHERE model IS NOT NULL AND model != 'filename'
        GROUP BY model ORDER BY n DESC`,
    )
    .all();

  const queued = sqlite
    .prepare(
      `SELECT type, status, COUNT(*) AS n FROM jobs
        WHERE type IN (${AI_JOB_TYPES.map(() => "?").join(",")})
          AND status IN ('pending','running')
        GROUP BY type, status`,
    )
    .all(...AI_JOB_TYPES);

  return {
    configured: {
      model,
      cheapTier: isCheapVisionModel(model),
      inputPerMillionUsd: price.inPerM,
      outputPerMillionUsd: price.outPerM,
      disabled: skuMatchDisabled(),
      maxUsdPerRun: skuMatchMaxUsd(),
    },
    modelsActuallyUsed: modelsUsed,
    queuedAiJobs: queued,
  };
}

export async function GET(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ ok: true, ...snapshot() });
}

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const before = snapshot();
  // Cancelled, not deleted: the row stays as a record of what was stopped.
  const res = sqlite
    .prepare(
      `UPDATE jobs
          SET status = 'failed',
              error = 'Cancelled: AI spend stop',
              completed_at = datetime('now')
        WHERE type IN (${AI_JOB_TYPES.map(() => "?").join(",")})
          AND status IN ('pending','running')`,
    )
    .run(...AI_JOB_TYPES);

  return NextResponse.json({
    ok: true,
    cancelled: res.changes,
    note: skuMatchDisabled()
      ? "Kill switch is ON — nothing can start again until SKU_MATCH_DISABLED is removed."
      : "Kill switch is OFF. Set SKU_MATCH_DISABLED=1 to stop anything new from starting.",
    before,
    after: snapshot(),
  });
}
