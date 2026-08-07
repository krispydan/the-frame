export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { getSessionUser } from "@/lib/get-session";
import { jobQueue } from "@/modules/core/lib/job-queue";
import { connectionForUser } from "@/modules/email/lib/gmail-client";
import { cancelOutbox, saveOutbox, type OutboxAttachment } from "@/modules/email/lib/outbox";

/**
 * The compose lifecycle.
 *
 * POST  { action: draft|schedule|send, ...fields }  → create (or update with id)
 * GET   ?status=draft|scheduled|sent|failed          → my outbox rows
 * DELETE ?id=                                        → cancel draft/scheduled
 *
 * "send" queues a job (sub-5-min latency via the worker tick) rather than
 * sending inline — an HTTP request that dies mid-Gmail-call would strand a
 * 'sending' row on the user's click path; the job path owns that risk.
 */

interface ComposeBody {
  id?: string;
  action: "draft" | "schedule" | "send";
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  bodyHtml?: string;
  companyId?: string | null;
  contactId?: string | null;
  replyToMessageId?: string | null;
  scheduledFor?: string | null;
  attachments?: OutboxAttachment[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as ComposeBody | null;
  if (!body?.action) return NextResponse.json({ error: "action required" }, { status: 400 });

  const conn = connectionForUser(user.id);
  if (!conn) {
    return NextResponse.json({ error: "Connect your Gmail account first (Settings → Integrations → Gmail)" }, { status: 400 });
  }
  if (conn.status !== "connected") {
    return NextResponse.json({ error: `Gmail connection needs attention: ${conn.status}` }, { status: 400 });
  }

  const to = (body.to ?? []).map((e) => e.trim()).filter(Boolean);
  if (body.action !== "draft") {
    if (to.length === 0) return NextResponse.json({ error: "at least one recipient" }, { status: 400 });
    const bad = [...to, ...(body.cc ?? []), ...(body.bcc ?? [])].filter((e) => e && !EMAIL_RE.test(e));
    if (bad.length) return NextResponse.json({ error: `invalid address: ${bad[0]}` }, { status: 400 });
    if (!body.subject?.trim() && !body.bodyHtml?.trim()) {
      return NextResponse.json({ error: "subject or body required" }, { status: 400 });
    }
  }

  let scheduledFor: string | null = null;
  if (body.action === "schedule") {
    if (!body.scheduledFor) return NextResponse.json({ error: "scheduledFor required" }, { status: 400 });
    const t = Date.parse(body.scheduledFor);
    if (Number.isNaN(t) || t < Date.now() - 60_000) {
      return NextResponse.json({ error: "scheduledFor must be in the future" }, { status: 400 });
    }
    scheduledFor = new Date(t).toISOString();
  }

  // If updating, the row must be the user's own and still editable.
  if (body.id) {
    const owned = sqlite
      .prepare("SELECT 1 FROM email_outbox WHERE id=? AND created_by=? AND status IN ('draft','scheduled')")
      .get(body.id, user.id);
    if (!owned) return NextResponse.json({ error: "not editable" }, { status: 404 });
  }

  const status = body.action === "draft" ? "draft" : body.action === "schedule" ? "scheduled" : "queued";
  const id = saveOutbox(
    {
      connectionId: conn.id,
      createdBy: user.id,
      companyId: body.companyId ?? null,
      contactId: body.contactId ?? null,
      replyToMessageId: body.replyToMessageId ?? null,
      to,
      cc: body.cc ?? [],
      bcc: body.bcc ?? [],
      subject: body.subject ?? "",
      bodyHtml: body.bodyHtml ?? "",
      attachments: body.attachments ?? [],
    },
    status,
    scheduledFor,
    body.id,
  );

  if (body.action === "send") {
    jobQueue.enqueue("email.send_outbox", "email", { outboxId: id }, { priority: 1 });
  }

  return NextResponse.json({ ok: true, id, status });
}

export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const status = req.nextUrl.searchParams.get("status");
  const companyId = req.nextUrl.searchParams.get("companyId");
  const clauses = ["created_by = ?"];
  const args: unknown[] = [user.id];
  if (status) { clauses.push("status = ?"); args.push(status); }
  if (companyId) { clauses.push("company_id = ?"); args.push(companyId); }

  const rows = sqlite
    .prepare(
      `SELECT id, company_id, to_json, cc_json, subject, status, scheduled_for, sent_at, error,
              attachments_json, reply_to_message_id, updated_at,
              substr(COALESCE(body_text,''), 1, 160) AS preview
         FROM email_outbox
        WHERE ${clauses.join(" AND ")}
        ORDER BY updated_at DESC LIMIT 100`,
    )
    .all(...args);

  return NextResponse.json({ ok: true, rows });
}

export async function DELETE(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const ok = cancelOutbox(id, user.id);
  return ok
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "not cancellable (already sent?)" }, { status: 409 });
}
