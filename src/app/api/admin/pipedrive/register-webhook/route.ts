export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { pdRequest, PipedriveError } from "@/modules/sales/lib/pipedrive-client";
import { registerInboundWebhook } from "@/modules/sales/lib/pipedrive-webhooks";

/**
 * POST /api/admin/pipedrive/register-webhook   (key-gated: x-admin-key: jaxy2026)
 *
 * Manage the inbound Pipedrive webhook (the pull half of the two-way sync).
 * Stores HTTP Basic creds in settings (the handler verifies them) and creates
 * the webhook in Pipedrive pointed at /api/webhooks/pipedrive.
 *
 * Body: { action?: "register" | "list" | "delete", id?, user?, password? }
 *   - register (default): create the webhook; generates a random password if
 *     none provided. Returns the creds once.
 *   - list: list webhooks currently registered in Pipedrive.
 *   - delete: remove a webhook by id.
 */
export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { action?: string; id?: number; user?: string; password?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body → register */
  }
  const action = body.action || "register";

  try {
    if (action === "list") {
      const hooks = await pdRequest<Array<Record<string, unknown>>>("GET", "/webhooks");
      return NextResponse.json({ ok: true, webhooks: hooks });
    }

    if (action === "delete") {
      if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
      await pdRequest("DELETE", `/webhooks/${body.id}`);
      return NextResponse.json({ ok: true, deleted: body.id });
    }

    // register (shared with the settings UI)
    const r = await registerInboundWebhook({ user: body.user, password: body.password });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    if (e instanceof PipedriveError) {
      return NextResponse.json({ error: e.message, status: e.status }, { status: 502 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
