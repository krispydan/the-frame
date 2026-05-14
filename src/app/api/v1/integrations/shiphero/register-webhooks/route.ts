export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { registerShipHeroWebhooks } from "@/modules/operations/lib/shiphero/register-webhooks";

/**
 * POST /api/v1/integrations/shiphero/register-webhooks
 *
 * Admin-triggered (from the integrations settings page) idempotent
 * reconciliation of ShipHero webhook subscriptions. Wraps
 * registerShipHeroWebhooks() and returns the per-topic result table so
 * the UI can render a status row for each.
 *
 * Base URL resolution mirrors the order_allocated handler: prefers
 * SHOPIFY_APP_URL / APP_BASE_URL env, falls back to the request origin
 * (useful for local development where envs aren't set).
 */
export async function POST(req: NextRequest) {
  const baseUrl =
    process.env.SHOPIFY_APP_URL ||
    process.env.APP_BASE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    new URL(req.url).origin;

  try {
    const results = await registerShipHeroWebhooks({ baseUrl });
    const anyError = results.some((r) => r.action === "error");
    return NextResponse.json(
      { ok: !anyError, baseUrl, results },
      { status: anyError ? 207 : 200 },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
