export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { webhookRegistry } from "@/modules/core/lib/webhooks";
// Side-effect imports — each module registers its handler with
// webhookRegistry at load. Required because the dispatcher route is
// the only path Next.js guarantees will be loaded for these providers.
import "@/modules/sales/lib/instantly-webhooks";
import "@/modules/sales/lib/phoneburner-webhooks";
import "@/modules/sales/lib/pipedrive-webhooks";
import { db } from "@/lib/db";
import { reportingLogs } from "@/modules/core/schema";

const SUPPORTED_PROVIDERS = ["shopify", "faire", "instantly", "phoneburner", "pipedrive", "xero", "test"];

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;

  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
  }

  const body = await request.text();
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body);
  } catch {
    parsedBody = body;
  }

  // Extract headers
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });

  // PhoneBurner's webhook UI accepts a URL only — no custom-header
  // field. Daniel pastes URLs of the form:
  //   /api/webhooks/phoneburner?secret=<token>&event=<hint>
  // Pull both into the headers map so the handler reads them the same
  // way it would read any other normalized header.
  const url = request.nextUrl;
  const querySecret = url.searchParams.get("secret");
  if (querySecret) headers["x-pb-webhook-secret"] = querySecret;
  const queryEvent = url.searchParams.get("event");
  if (queryEvent) {
    headers["x-pb-event"] = queryEvent;
    // Also inject into parsedBody as a fallback hint for the handler's
    // detectEventType walk.
    if (parsedBody && typeof parsedBody === "object") {
      (parsedBody as Record<string, unknown>).event = (parsedBody as Record<string, unknown>).event ?? queryEvent;
    }
  }

  // Log incoming webhook
  try {
    await db.insert(reportingLogs).values({
      eventType: "webhook_received",
      module: provider,
      metadata: { provider, bodyLength: body.length, contentType: headers["content-type"] },
    });
  } catch {
    // Don't fail the webhook if logging fails
  }

  const handler = webhookRegistry.getHandler(provider);
  if (!handler) {
    return NextResponse.json(
      { ok: true, message: `Webhook received for ${provider} (no handler registered yet)` },
      { status: 200 }
    );
  }

  try {
    const result = await handler({ provider, headers, body, parsedBody });
    return NextResponse.json(result);
  } catch (error) {
    console.error(`Webhook handler error for ${provider}:`, error);
    return NextResponse.json(
      { error: "Webhook processing failed" },
      { status: 500 }
    );
  }
}
