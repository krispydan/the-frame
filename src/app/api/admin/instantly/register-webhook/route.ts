export const dynamic = "force-dynamic";
export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { sqlite } from "@/lib/db";

/**
 * POST /api/admin/instantly/register-webhook
 *
 * One-time bootstrap. Mints a random token, stores it in
 * settings.instantly_webhook_token, calls Instantly's /api/v2/webhooks
 * to register our public URL with that token wired into the custom
 * `headers` field, and stores the returned webhook ID in
 * settings.instantly_webhook_id.
 *
 * Instantly doesn't sign webhook deliveries, so the X-Webhook-Token
 * header (injected by Instantly on every call) is our only auth.
 *
 * Body (all optional):
 *   {
 *     webhookUrl?: string,    // default: deduced from request origin + standard path
 *     campaignId?: string,    // default: null (workspace-wide)
 *     eventType?: string      // default: "all_events"
 *   }
 *
 * Auth: x-admin-key: jaxy2026
 *
 * Idempotent: if a webhook is already registered (id stored in
 * settings.instantly_webhook_id), the call returns the existing
 * registration without minting a new token or making the API call —
 * unless ?force=true is passed.
 */
const INSTANTLY_API = "https://api.instantly.ai/api/v2";

function getInstantlyApiKey(): string | null {
  if (process.env.INSTANTLY_API_KEY) return process.env.INSTANTLY_API_KEY;
  const row = sqlite
    .prepare("SELECT value FROM settings WHERE key = 'instantly_api_key' LIMIT 1")
    .get() as { value: string | null } | undefined;
  return row?.value ?? null;
}

function getSetting(key: string): string | null {
  const row = sqlite
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string | null } | undefined;
  return row?.value ?? null;
}

function setSetting(key: string, value: string): void {
  sqlite
    .prepare(
      `INSERT INTO settings (key, value, type, module, updated_at)
       VALUES (?, ?, 'string', 'instantly', datetime('now'))
       ON CONFLICT(key) DO UPDATE
         SET value = excluded.value,
             updated_at = datetime('now')`,
    )
    .run(key, value);
}

function preview(s: string): string {
  if (s.length < 12) return "***";
  return `${s.slice(0, 8)}...${s.slice(-4)}`;
}

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const apiKey = getInstantlyApiKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: "Instantly API key not configured (env INSTANTLY_API_KEY or settings.instantly_api_key)" },
      { status: 500 },
    );
  }

  let body: { webhookUrl?: string; campaignId?: string | null; eventType?: string } = {};
  try {
    body = await req.json();
  } catch {
    // empty body OK
  }

  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "true";

  // Idempotency check — short-circuit if already bootstrapped.
  const existingId = getSetting("instantly_webhook_id");
  const existingToken = getSetting("instantly_webhook_token");
  if (existingId && existingToken && !force) {
    return NextResponse.json({
      ok: true,
      mode: "already_registered",
      webhook_id: existingId,
      token_preview: preview(existingToken),
      message:
        "Webhook already registered. Re-run with ?force=true to mint a fresh token and re-register.",
    });
  }

  // Receiver URL resolution. Inside the Railway container, request.url
  // resolves to http://localhost:3456 — Instantly can't reach that. So
  // prefer env-configured public URLs first (same fallback chain as
  // attach-faire-slip.ts:getAppBaseUrl), then fall back to request
  // origin for local dev, then allow the body to override either.
  const envBaseUrl =
    process.env.SHOPIFY_APP_URL ||
    process.env.APP_BASE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    null;
  const inferredBase = envBaseUrl
    ? envBaseUrl.replace(/\/$/, "")
    : url.origin;
  const webhookUrl =
    body.webhookUrl ??
    `${inferredBase}/api/webhooks/instantly`;

  // Refuse to register a localhost URL — Instantly can't reach it and
  // we'd end up with another orphan webhook to clean up.
  if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(webhookUrl)) {
    return NextResponse.json(
      {
        error: "Refusing to register a localhost webhook URL — Instantly can't reach it",
        webhookUrl,
        hint: "Pass body.webhookUrl explicitly, or set SHOPIFY_APP_URL env var to the public URL",
      },
      { status: 400 },
    );
  }

  const token = randomBytes(32).toString("hex");
  const eventType = body.eventType ?? "all_events";
  const campaignId = body.campaignId ?? null;

  // Persist the token FIRST. If the Instantly call later fails, we
  // discard it. (Better to have an orphan token than miss-store one
  // after a successful registration.)
  setSetting("instantly_webhook_token", token);

  // Per https://developer.instantly.ai/api-reference/webhook/create-webhook
  // The URL field is `target_hook_url` (not `url`). event_type accepts
  // `all_events` to catch everything. campaign=null = all campaigns in
  // workspace. headers is injected on every outbound delivery.
  const reqBody = {
    target_hook_url: webhookUrl,
    name: "The Frame — all events",
    event_type: eventType,
    campaign: campaignId,
    headers: { "X-Webhook-Token": token },
  };

  let res: Response;
  try {
    res = await fetch(`${INSTANTLY_API}/webhooks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(reqBody),
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

  let parsed: { id?: string } = {};
  try {
    parsed = JSON.parse(respText) as { id?: string };
  } catch {
    return NextResponse.json(
      { error: "Instantly returned non-JSON", body: respText.slice(0, 500) },
      { status: 502 },
    );
  }

  if (!parsed.id) {
    return NextResponse.json(
      { error: "Instantly response missing id field", body: respText.slice(0, 500) },
      { status: 502 },
    );
  }

  setSetting("instantly_webhook_id", parsed.id);

  return NextResponse.json({
    ok: true,
    mode: force && existingId ? "re_registered" : "registered",
    webhook_id: parsed.id,
    webhook_url: webhookUrl,
    event_type: eventType,
    campaign: campaignId,
    token_preview: preview(token),
    message:
      "Webhook registered. Test by triggering an event in Instantly (mark a lead Interested, send a campaign step) and checking instantly_webhook_events for the row.",
  });
}
