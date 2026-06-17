export const dynamic = "force-dynamic";
export const maxDuration = 15;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * POST /api/admin/instantly/delete-webhook
 *
 * Delete a webhook registration on Instantly's side and (if the id
 * matches what we have stored) also clear our local settings rows so
 * the next register-webhook call mints a fresh token cleanly.
 *
 * Body:
 *   { webhookId: "<uuid>" }   // required
 *
 * Auth: x-admin-key: jaxy2026
 *
 * Use case: cleaning up a misconfigured registration without having
 * to go to the Instantly dashboard.
 */
const INSTANTLY_API = "https://api.instantly.ai/api/v2";

function getInstantlyApiKey(): string | null {
  if (process.env.INSTANTLY_API_KEY) return process.env.INSTANTLY_API_KEY;
  const row = sqlite
    .prepare("SELECT value FROM settings WHERE key = 'instantly_api_key' LIMIT 1")
    .get() as { value: string | null } | undefined;
  return row?.value ?? null;
}

export async function POST(req: NextRequest) {
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

  let body: { webhookId?: string } = {};
  try {
    body = await req.json();
  } catch { /* empty */ }
  const webhookId = (body.webhookId ?? "").trim();
  if (!webhookId) {
    return NextResponse.json({ error: "webhookId required" }, { status: 400 });
  }

  let res: Response;
  try {
    res = await fetch(`${INSTANTLY_API}/webhooks/${webhookId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (e) {
    return NextResponse.json(
      { error: `Instantly API call failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }

  const respText = await res.text();
  if (!res.ok) {
    return NextResponse.json(
      {
        error: `Instantly returned ${res.status}`,
        body: respText.slice(0, 500),
      },
      { status: 502 },
    );
  }

  // If the deleted id matches what we have stored locally, clear those
  // settings so the next register-webhook call doesn't short-circuit.
  const localId = sqlite
    .prepare("SELECT value FROM settings WHERE key = 'instantly_webhook_id'")
    .get() as { value: string | null } | undefined;
  let clearedLocal = false;
  if (localId?.value === webhookId) {
    sqlite
      .prepare("DELETE FROM settings WHERE key IN ('instantly_webhook_id', 'instantly_webhook_token')")
      .run();
    clearedLocal = true;
  }

  return NextResponse.json({
    ok: true,
    deleted_webhook_id: webhookId,
    cleared_local_settings: clearedLocal,
    instantly_response: respText.slice(0, 500),
  });
}
