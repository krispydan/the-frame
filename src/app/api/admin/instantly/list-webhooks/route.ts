export const dynamic = "force-dynamic";
export const maxDuration = 15;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * GET /api/admin/instantly/list-webhooks
 *
 * Diagnostics. Pulls the webhook registrations from Instantly's API
 * for the current workspace + summarizes recent inbound deliveries
 * from instantly_webhook_events for quick health checking.
 *
 * Auth: x-admin-key: jaxy2026
 */
const INSTANTLY_API = "https://api.instantly.ai/api/v2";

function getInstantlyApiKey(): string | null {
  if (process.env.INSTANTLY_API_KEY) return process.env.INSTANTLY_API_KEY;
  const row = sqlite
    .prepare("SELECT value FROM settings WHERE key = 'instantly_api_key' LIMIT 1")
    .get() as { value: string | null } | undefined;
  return row?.value ?? null;
}

export async function GET(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const apiKey = getInstantlyApiKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: "Instantly API key not configured" },
      { status: 500 },
    );
  }

  // 1. List registered webhooks (Instantly side).
  let registeredBody: unknown = null;
  let registeredStatus = 0;
  try {
    const res = await fetch(`${INSTANTLY_API}/webhooks`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    registeredStatus = res.status;
    const text = await res.text();
    try {
      registeredBody = JSON.parse(text);
    } catch {
      registeredBody = { raw: text.slice(0, 500) };
    }
  } catch (e) {
    registeredBody = { error: e instanceof Error ? e.message : String(e) };
  }

  // 2. Inbound delivery stats (our side).
  const deliveryStats = sqlite
    .prepare(
      `SELECT event_type, COUNT(*) AS n,
              SUM(CASE WHEN token_valid = 1 THEN 1 ELSE 0 END) AS valid,
              SUM(CASE WHEN handler_ok = 1 THEN 1 ELSE 0 END) AS processed,
              MAX(received_at) AS latest
         FROM instantly_webhook_events
        WHERE received_at >= datetime('now', '-7 days')
        GROUP BY event_type
        ORDER BY n DESC`,
    )
    .all();

  const recentSample = sqlite
    .prepare(
      `SELECT event_type, lead_email, campaign_name, token_valid, handler_ok,
              handler_message, received_at
         FROM instantly_webhook_events
        ORDER BY received_at DESC
        LIMIT 10`,
    )
    .all();

  const totals = sqlite
    .prepare(
      `SELECT COUNT(*) AS n,
              SUM(CASE WHEN handler_ok = 1 THEN 1 ELSE 0 END) AS ok,
              MIN(received_at) AS first,
              MAX(received_at) AS latest
         FROM instantly_webhook_events`,
    )
    .get();

  // 3. Local registration settings.
  const settings = sqlite
    .prepare(
      `SELECT key, updated_at FROM settings
        WHERE key IN ('instantly_webhook_id', 'instantly_webhook_token')`,
    )
    .all();

  return NextResponse.json({
    ok: true,
    instantly_side: {
      status: registeredStatus,
      body: registeredBody,
    },
    our_side: {
      settings,
      totals,
      last_7_days_by_event_type: deliveryStats,
      recent_deliveries: recentSample,
    },
  });
}
