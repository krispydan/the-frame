export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import {
  syncAmazonSettlementsToXero,
  loadAmazonXeroConfig,
} from "@/modules/integrations/lib/amazon/payout-sync";

/**
 * GET /api/v1/finance/amazon/post-settlements — readiness check.
 *
 * Reports whether the account mappings resolve, without posting anything.
 * Worth having as its own call: "which mapping is missing" is the question
 * asked most often before the first run, and answering it should not require
 * attempting a post.
 */
export async function GET() {
  try {
    const config = await loadAmazonXeroConfig();
    return NextResponse.json({
      ok: true,
      ready: true,
      accounts: config,
      trackingConfigured: Boolean(config.tracking?.length),
      note: config.tracking?.length
        ? undefined
        : "No Xero tracking option is mapped for Amazon. Journals will post without a Sales Channel tag, so Amazon will not separate out in tracking-based reports.",
    });
  } catch (e) {
    return NextResponse.json({ ok: true, ready: false, error: (e as Error).message });
  }
}

/**
 * POST /api/v1/finance/amazon/post-settlements — post settlements to Xero.
 *
 * Body (all optional):
 *   { dryRun?: boolean, status?: "DRAFT" | "POSTED",
 *     settlementIds?: string[], limit?: number }
 *
 * Defaults to `dryRun: true`. Posting journals is not easily reversible — the
 * correction path is a reversing journal, not a delete — so the safe thing has
 * to be the thing that happens when you forget a parameter.
 *
 * Recommended first run:
 *   1. `{ "dryRun": true }`                       — build and balance everything
 *   2. `{ "dryRun": false, "status": "DRAFT", "limit": 1 }` — one journal, unapproved, eyeball it in Xero
 *   3. `{ "dryRun": false, "status": "POSTED" }`  — the rest
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { dryRun, status, settlementIds, limit } = body as {
      dryRun?: boolean; status?: string; settlementIds?: string[]; limit?: number;
    };

    if (status !== undefined && status !== "DRAFT" && status !== "POSTED") {
      return NextResponse.json({ ok: false, error: '`status` must be "DRAFT" or "POSTED"' }, { status: 400 });
    }
    if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
      return NextResponse.json({ ok: false, error: "`limit` must be a positive number" }, { status: 400 });
    }
    if (settlementIds !== undefined && !Array.isArray(settlementIds)) {
      return NextResponse.json({ ok: false, error: "`settlementIds` must be an array" }, { status: 400 });
    }

    const summary = await syncAmazonSettlementsToXero({
      // Explicit opt-out only. Omitting the flag must never post.
      dryRun: dryRun !== false,
      status: (status as "DRAFT" | "POSTED") ?? "POSTED",
      settlementIds,
      limit,
    });

    return NextResponse.json({
      ok: !summary.fatalError,
      dryRun: dryRun !== false,
      ...summary,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
