export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import {
  seedAjmToPipedrive,
  backfillInterested,
  backfillOrderDeals,
  ensureCustomFields,
  PipedriveNotReadyError,
} from "@/modules/sales/lib/pipedrive-sync";

/**
 * POST /api/admin/pipedrive/sync   (key-gated: x-admin-key: jaxy2026)
 *
 * Trigger the Pipedrive push jobs. All default to a dry run — pass
 * { "dryRun": false } to actually write. Curl-friendly (exempt from login).
 *
 * Body: { action, dryRun?, limit?, backfillRunId? }
 *   action = "ensure-custom-fields" | "seed-ajm" | "backfill-interested" | "backfill-orders"
 *
 * Examples:
 *   curl -XPOST .../api/admin/pipedrive/sync -H 'x-admin-key: jaxy2026' \
 *        -H 'content-type: application/json' -d '{"action":"seed-ajm"}'           # dry run
 *   ... -d '{"action":"seed-ajm","dryRun":false}'                                 # for real
 *   ... -d '{"action":"backfill-orders","dryRun":false,"backfillRunId":"2026-06-30"}'
 */
export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { action?: string; dryRun?: boolean; limit?: number; backfillRunId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON body required" }, { status: 400 });
  }

  // Default to dry-run unless explicitly disabled — a write only happens when
  // the caller passes dryRun:false.
  const dryRun = body.dryRun !== false;

  try {
    switch (body.action) {
      case "ensure-custom-fields": {
        const keys = await ensureCustomFields();
        return NextResponse.json({ ok: true, customFields: keys });
      }
      case "seed-ajm": {
        const r = await seedAjmToPipedrive({ dryRun, limit: body.limit });
        return NextResponse.json({ ok: true, ...r });
      }
      case "backfill-interested": {
        const r = await backfillInterested({ dryRun });
        return NextResponse.json({ ok: true, ...r });
      }
      case "backfill-orders": {
        const r = await backfillOrderDeals({ dryRun, limit: body.limit, backfillRunId: body.backfillRunId });
        return NextResponse.json({ ok: true, ...r });
      }
      default:
        return NextResponse.json(
          { error: `Unknown action "${body.action}". Use ensure-custom-fields | seed-ajm | backfill-interested | backfill-orders` },
          { status: 400 },
        );
    }
  } catch (e) {
    if (e instanceof PipedriveNotReadyError) {
      return NextResponse.json({ error: e.message, hint: "Connect Pipedrive and create pipelines first" }, { status: 409 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
