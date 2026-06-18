export const dynamic = "force-dynamic";
export const maxDuration = 15;

import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { sqlite } from "@/lib/db";

/**
 * POST /api/admin/phoneburner/register-webhook
 *
 * One-time bootstrap. PB's webhook settings UI accepts a URL only —
 * no programmatic registration is available (per webhooksSettings.pdf).
 * This endpoint mints a random secret, stores it in
 * settings.phoneburner_webhook_token, and returns the list of URLs
 * Daniel must paste into PB's UI (Settings → Webhooks).
 *
 * Idempotent: if a token is already stored, the existing URLs are
 * returned. Pass ?force=true to mint a fresh token and rotate.
 *
 * Body: optional { baseUrl?: string }   default: derived from request
 * Auth: x-admin-key: jaxy2026
 */
function getInferredBase(req: NextRequest): string {
  // Same fallback chain as attach-faire-slip's getAppBaseUrl —
  // the request origin from inside Railway is http://localhost:3456,
  // so prefer env-configured public URLs.
  const env =
    process.env.SHOPIFY_APP_URL ||
    process.env.APP_BASE_URL ||
    process.env.NEXT_PUBLIC_APP_URL;
  if (env) return env.replace(/\/$/, "");
  return new URL(req.url).origin;
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
       VALUES (?, ?, 'string', 'phoneburner', datetime('now'))
       ON CONFLICT(key) DO UPDATE
         SET value = excluded.value,
             updated_at = datetime('now')`,
    )
    .run(key, value);
}

function preview(s: string): string {
  if (s.length < 16) return "***";
  return `${s.slice(0, 8)}...${s.slice(-4)}`;
}

interface WebhookConfig {
  /** Webhook category label shown in PB's settings UI */
  pbField: string;
  /** event query param the URL embeds */
  event: string;
  /** Description / hint Daniel will see */
  hint: string;
}

const PB_WEBHOOK_FIELDS: WebhookConfig[] = [
  { pbField: "Call Begin",          event: "call_begin",         hint: "Dial session starts a call" },
  { pbField: "Call End",            event: "call_end",           hint: "Call ends, disposition is set (PRIMARY — this drives the prospect timeline)" },
  { pbField: "Contact Displayed",   event: "contact_displayed",  hint: "Agent loads a contact card in PB UI" },
  { pbField: "Email Unsubscribe",   event: "email_unsubscribe",  hint: "Contact unsubscribes from a One-Touch email" },
  { pbField: "SMS Opt Out",         event: "sms_opt_out",        hint: "Contact replies STOP" },
  { pbField: "Contact Activities",  event: "activity",           hint: "Tick the boxes you want (Email Opened, Clicked, Appointment Scheduled, Task Created, etc.). All flow through this single URL." },
  { pbField: "Manual Webhook",      event: "manual",             hint: "Optional — fires when an agent clicks the manual webhook button" },
];

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { baseUrl?: string } = {};
  try {
    body = await req.json();
  } catch { /* empty body OK */ }

  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "true";

  const base = (body.baseUrl ?? getInferredBase(req)).replace(/\/$/, "");
  if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(base)) {
    return NextResponse.json(
      {
        error: "Refusing to bake localhost URLs — PB can't reach them",
        hint: "Pass body.baseUrl explicitly, or set SHOPIFY_APP_URL env var",
      },
      { status: 400 },
    );
  }

  let token = getSetting("phoneburner_webhook_token");
  let mode: "issued" | "rotated" | "existing";

  if (!token || force) {
    token = randomBytes(32).toString("hex");
    setSetting("phoneburner_webhook_token", token);
    mode = force && getSetting("phoneburner_webhook_token") ? "rotated" : "issued";
  } else {
    mode = "existing";
  }

  const urls_to_configure: Record<string, { url: string; pb_field: string; hint: string }> = {};
  for (const w of PB_WEBHOOK_FIELDS) {
    urls_to_configure[w.event] = {
      url: `${base}/api/webhooks/phoneburner?secret=${token}&event=${w.event}`,
      pb_field: w.pbField,
      hint: w.hint,
    };
  }

  return NextResponse.json({
    ok: true,
    mode,
    token_preview: preview(token),
    base_url: base,
    instructions: [
      "1. Open PhoneBurner → Settings → Webhooks",
      "2. Paste each URL below into the corresponding field (pb_field)",
      "3. For Contact Activities, also tick the event checkboxes you want (Email Opened, Clicked, Appointment Scheduled, etc.)",
      "4. Make a test call — within 5s a row should appear in phoneburner_webhook_events and on the prospect page",
      "5. Pass ?force=true to rotate the secret (will invalidate the URLs you previously pasted)",
    ],
    urls_to_configure,
  });
}
