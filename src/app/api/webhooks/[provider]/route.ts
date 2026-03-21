export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { webhookRegistry } from "@/modules/core/lib/webhooks";
import { db } from "@/lib/db";
import { reportingLogs } from "@/modules/core/schema";

const SUPPORTED_PROVIDERS = ["shopify", "faire", "instantly", "xero", "test"];

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
