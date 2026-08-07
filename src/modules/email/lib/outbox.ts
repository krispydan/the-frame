/**
 * The send side: drafts, scheduled sends, and dispatch.
 *
 * Lifecycle:  draft ─► scheduled ─► queued ─► sending ─► sent
 *                  └────────────────► cancelled     └──► failed
 *
 * Dispatch rules (each one bought by a prior incident in this repo):
 * - `sending` is written BEFORE the Gmail API call. A crash/deploy between
 *   the call and the confirmation leaves a `sending` row that is flagged for
 *   a human, never auto-retried — a double email to a customer is worse than
 *   a delayed one.
 * - Suppression is checked at DISPATCH time, not compose time — state
 *   changes while a scheduled send sits in the queue.
 * - Sent mail is echo-written into email_threads/email_messages immediately
 *   (with the real RFC id fetched back from Gmail), so the thread view shows
 *   it without waiting a sync tick, and the reply chain has its parent.
 */

import { readFile, mkdir, writeFile, rm } from "fs/promises";
import path from "path";
import { sqlite } from "@/lib/db";
import { checkSuppression } from "@/modules/sales/lib/suppression";
import {
  accessTokenFor, connectionById, getMessage, sendRaw,
} from "./gmail-client";
import { buildRawMessage, header, normalizeRfcId, stripHtml, type OutboundAttachment } from "./mime";
import { writeMessage } from "./thread-writer";

const ATTACHMENTS_ROOT =
  process.env.EMAIL_ATTACHMENTS_PATH || path.join(process.cwd(), "data", "email-attachments");

/** Gmail's hard message cap is 25MB encoded; leave headroom for base64 + body. */
export const MAX_TOTAL_ATTACHMENT_BYTES = 18 * 1024 * 1024;

export interface OutboxAttachment {
  id: string;
  filename: string;
  size: number;
  mime: string;
}

export interface OutboxInput {
  connectionId: string;
  createdBy: string;
  companyId?: string | null;
  contactId?: string | null;
  replyToMessageId?: string | null;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyHtml: string;
  attachments?: OutboxAttachment[];
}

function attachmentPath(outboxId: string, attachmentId: string, filename: string): string {
  // attachmentId is a server-minted UUID; filename is display-only in the path.
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  return path.join(ATTACHMENTS_ROOT, outboxId, `${attachmentId}_${safe}`);
}

export async function storeAttachment(
  outboxId: string,
  filename: string,
  mime: string,
  content: Buffer,
): Promise<OutboxAttachment> {
  const id = crypto.randomUUID();
  const p = attachmentPath(outboxId, id, filename);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, content);
  return { id, filename, size: content.length, mime };
}

export function saveOutbox(input: OutboxInput, status: "draft" | "scheduled" | "queued", scheduledFor?: string | null, existingId?: string): string {
  const id = existingId ?? crypto.randomUUID();
  const bodyText = stripHtml(input.bodyHtml);
  if (existingId) {
    sqlite
      .prepare(
        `UPDATE email_outbox SET
           connection_id=?, company_id=?, contact_id=?, reply_to_message_id=?,
           to_json=?, cc_json=?, bcc_json=?, subject=?, body_html=?, body_text=?,
           attachments_json=?, status=?, scheduled_for=?, updated_at=datetime('now')
         WHERE id=? AND status IN ('draft','scheduled')`,
      )
      .run(
        input.connectionId, input.companyId ?? null, input.contactId ?? null, input.replyToMessageId ?? null,
        JSON.stringify(input.to), JSON.stringify(input.cc ?? []), JSON.stringify(input.bcc ?? []),
        input.subject, input.bodyHtml, bodyText,
        input.attachments?.length ? JSON.stringify(input.attachments) : null,
        status, scheduledFor ?? null, id,
      );
  } else {
    sqlite
      .prepare(
        `INSERT INTO email_outbox
           (id, connection_id, created_by, company_id, contact_id, reply_to_message_id,
            to_json, cc_json, bcc_json, subject, body_html, body_text, attachments_json,
            status, scheduled_for)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id, input.connectionId, input.createdBy, input.companyId ?? null, input.contactId ?? null,
        input.replyToMessageId ?? null,
        JSON.stringify(input.to), JSON.stringify(input.cc ?? []), JSON.stringify(input.bcc ?? []),
        input.subject, input.bodyHtml, bodyText,
        input.attachments?.length ? JSON.stringify(input.attachments) : null,
        status, scheduledFor ?? null,
      );
  }
  return id;
}

export function cancelOutbox(id: string, userId: string): boolean {
  const res = sqlite
    .prepare(
      `UPDATE email_outbox SET status='cancelled', updated_at=datetime('now')
        WHERE id=? AND created_by=? AND status IN ('draft','scheduled','queued')`,
    )
    .run(id, userId);
  return (res.changes ?? 0) > 0;
}

interface OutboxRow {
  id: string;
  connection_id: string;
  created_by: string;
  company_id: string | null;
  reply_to_message_id: string | null;
  to_json: string;
  cc_json: string | null;
  bcc_json: string | null;
  subject: string | null;
  body_html: string | null;
  body_text: string | null;
  attachments_json: string | null;
  status: string;
}

export interface SendOutcome {
  id: string;
  status: "sent" | "failed" | "blocked" | "skipped";
  reason?: string;
}

/**
 * Dispatch one outbox row. Callable from the job handler (send now) and the
 * scheduled-drain cron. Safe to call twice: only a `queued`/`scheduled` row
 * transitions to `sending`.
 */
export async function dispatchOutbox(outboxId: string): Promise<SendOutcome> {
  // Atomic claim — the transition IS the lock.
  const claim = sqlite
    .prepare(
      `UPDATE email_outbox SET status='sending', updated_at=datetime('now')
        WHERE id=? AND status IN ('queued','scheduled')`,
    )
    .run(outboxId);
  if ((claim.changes ?? 0) === 0) return { id: outboxId, status: "skipped", reason: "not in a sendable state" };

  const row = sqlite.prepare("SELECT * FROM email_outbox WHERE id = ?").get(outboxId) as OutboxRow;

  const fail = (reason: string, status: "failed" | "blocked" = "failed"): SendOutcome => {
    sqlite
      .prepare("UPDATE email_outbox SET status='failed', error=?, updated_at=datetime('now') WHERE id=?")
      .run(reason.slice(0, 400), outboxId);
    return { id: outboxId, status, reason };
  };

  // Suppression at dispatch time. A rep-composed 1:1 email to a suppressed
  // company is blocked with the reason surfaced — un-suppressing is a
  // deliberate separate act, never a send-path bypass.
  if (row.company_id) {
    const sup = checkSuppression(row.company_id);
    if (sup.suppressed) return fail(`suppressed: ${sup.reason}`, "blocked");
  }

  const conn = connectionById(row.connection_id);
  if (!conn) return fail("Gmail connection missing");
  const token = await accessTokenFor(conn);
  if (!token.ok) return fail(`Gmail auth: ${token.reason}`);

  // Threading: pull the parent's RFC id + thread root for References.
  let inReplyTo: string | null = null;
  let references: string[] = [];
  let gmailThreadId: string | null = null;
  if (row.reply_to_message_id) {
    const parent = sqlite
      .prepare(
        `SELECT m.rfc_message_id, m.gmail_message_id, t.root_message_id
           FROM email_messages m JOIN email_threads t ON t.id = m.thread_id
          WHERE m.id = ?`,
      )
      .get(row.reply_to_message_id) as { rfc_message_id: string | null; gmail_message_id: string | null; root_message_id: string } | undefined;
    if (parent?.rfc_message_id) {
      inReplyTo = parent.rfc_message_id;
      references = parent.root_message_id === parent.rfc_message_id
        ? [parent.root_message_id]
        : [parent.root_message_id, parent.rfc_message_id];
    }
    // Same-mailbox replies also pass Gmail's own threadId so the REP's sent
    // folder threads correctly too.
    if (parent?.gmail_message_id) {
      const t = await getMessage(token.token, parent.gmail_message_id);
      gmailThreadId = t.ok ? (t.data?.threadId ?? null) : null;
    }
  }

  // Load attachments from disk.
  const attachmentMeta = row.attachments_json ? (JSON.parse(row.attachments_json) as OutboxAttachment[]) : [];
  const attachments: OutboundAttachment[] = [];
  for (const a of attachmentMeta) {
    try {
      attachments.push({ filename: a.filename, mime: a.mime, content: await readFile(attachmentPath(outboxId, a.id, a.filename)) });
    } catch {
      return fail(`attachment missing on disk: ${a.filename}`);
    }
  }

  const raw = buildRawMessage({
    from: conn.email,
    to: JSON.parse(row.to_json) as string[],
    cc: row.cc_json ? (JSON.parse(row.cc_json) as string[]) : [],
    bcc: row.bcc_json ? (JSON.parse(row.bcc_json) as string[]) : [],
    subject: row.subject ?? "",
    html: row.body_html ?? "",
    text: row.body_text ?? "",
    attachments,
    inReplyTo,
    references,
  });

  const sent = await sendRaw(token.token, raw, gmailThreadId);
  if (!sent.ok || !sent.data?.id) {
    // The API call itself failed — we KNOW nothing was sent, so a clean
    // `failed` (visible, retryable by a human) is correct.
    return fail(`Gmail send failed (HTTP ${sent.status}): ${sent.error ?? "unknown"}`);
  }

  // Fetch back the real RFC id Gmail assigned, echo into the thread store.
  let rfcId: string | null = null;
  let sentAtIso = new Date().toISOString();
  const echo = await getMessage(token.token, sent.data.id);
  if (echo.ok && echo.data?.payload) {
    rfcId = normalizeRfcId(header(echo.data.payload.headers, "message-id"));
    if (echo.data.internalDate) sentAtIso = new Date(Number(echo.data.internalDate)).toISOString();
    const { parseAddressList, rootMessageId: rootOf, plainTextBody, htmlBody, listAttachments } = await import("./mime");
    writeMessage({
      rfcMessageId: rfcId,
      rootMessageId: rootOf(echo.data.payload.headers),
      gmailMessageId: sent.data.id,
      connectionId: conn.id,
      direction: "outbound",
      fromEmail: conn.email,
      fromName: null,
      to: parseAddressList(header(echo.data.payload.headers, "to")),
      cc: parseAddressList(header(echo.data.payload.headers, "cc")),
      subject: row.subject,
      snippet: echo.data.snippet ?? null,
      bodyText: plainTextBody(echo.data.payload) || row.body_text,
      bodyHtml: htmlBody(echo.data.payload) ?? row.body_html,
      attachments: listAttachments(echo.data.payload),
      sentAt: sentAtIso,
    });
  }

  sqlite
    .prepare(
      `UPDATE email_outbox
          SET status='sent', sent_at=?, sent_rfc_message_id=?, gmail_message_id=?, error=NULL, updated_at=datetime('now')
        WHERE id=?`,
    )
    .run(sentAtIso, rfcId, sent.data.id, outboxId);

  // Attachments served their purpose; free volume space (best-effort).
  if (attachmentMeta.length) {
    rm(path.join(ATTACHMENTS_ROOT, outboxId), { recursive: true, force: true }).catch(() => null);
  }

  return { id: outboxId, status: "sent" };
}

/** Cron: dispatch due scheduled sends + flag stranded 'sending' rows. */
export async function drainOutbox(): Promise<{ sent: number; failed: number; stranded: number }> {
  // A row stuck in 'sending' >10 min means the process died mid-send. The
  // email may or may not have left — a human decides; we never re-fire it.
  const stranded = sqlite
    .prepare(
      `UPDATE email_outbox
          SET status='failed',
              error='Process died mid-send — the email MAY have been delivered. Check the Gmail Sent folder before retrying.',
              updated_at=datetime('now')
        WHERE status='sending' AND updated_at < datetime('now', '-10 minutes')`,
    )
    .run().changes ?? 0;

  const due = sqlite
    .prepare(
      `SELECT id FROM email_outbox
        WHERE status='scheduled' AND scheduled_for IS NOT NULL AND scheduled_for <= datetime('now')
        ORDER BY scheduled_for ASC LIMIT 20`,
    )
    .all() as Array<{ id: string }>;

  let sent = 0, failed = 0;
  for (const r of due) {
    const res = await dispatchOutbox(r.id);
    if (res.status === "sent") sent++;
    else if (res.status !== "skipped") failed++;
  }
  return { sent, failed, stranded };
}
