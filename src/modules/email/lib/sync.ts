/**
 * Incremental Gmail read-sync, one connection at a time.
 *
 * The cursor model is compai's: `history_cursor` holds a Gmail historyId;
 * each tick asks "what arrived since", fetches only those messages, and
 * advances the cursor only when everything fetched was written — a crashed
 * tick re-reads the same window and the thread-writer's rfc-id idempotency
 * makes the overlap free. First sync stores the CURRENT historyId and walks
 * forward from "now" — we deliberately do not backfill years of mailbox
 * (that's a separate, explicit action if ever wanted).
 *
 * A 404 on the history cursor means Gmail expired it (~1 week of inactivity):
 * reset to "now" rather than failing forever.
 */

import { sqlite } from "@/lib/db";
import {
  accessTokenFor, connectionById, getMessage, listHistory, profile,
} from "./gmail-client";
import {
  header, htmlBody, listAttachments, normalizeRfcId, parseAddress,
  parseAddressList, plainTextBody, rootMessageId,
} from "./mime";
import { writeMessage } from "./thread-writer";

const MAX_MESSAGES_PER_TICK = 60;

export interface SyncResult {
  connectionId: string;
  email?: string;
  status: "synced" | "started" | "skipped" | "reconnect" | "failed";
  written?: number;
  reason?: string;
}

export async function syncConnection(connectionId: string): Promise<SyncResult> {
  const conn = connectionById(connectionId);
  if (!conn || conn.status === "disconnected") {
    return { connectionId, status: "skipped", reason: "not connected" };
  }

  const token = await accessTokenFor(conn);
  if (!token.ok) return { connectionId, email: conn.email, status: "reconnect", reason: token.reason };

  if (!conn.history_cursor) {
    const p = await profile(token.token);
    if (!p.ok || !p.data?.historyId) {
      return { connectionId, email: conn.email, status: "failed", reason: p.error ?? "no historyId" };
    }
    sqlite
      .prepare("UPDATE gmail_connections SET history_cursor = ?, last_synced_at = datetime('now') WHERE id = ?")
      .run(p.data.historyId, conn.id);
    return { connectionId, email: conn.email, status: "started" };
  }

  const history = await listHistory(token.token, conn.history_cursor);
  if (!history.ok) {
    if (history.status === 404) {
      // Cursor expired — resume from now; mail in the gap is lost to sync
      // (acceptable: threads self-heal as replies arrive).
      sqlite.prepare("UPDATE gmail_connections SET history_cursor = NULL WHERE id = ?").run(conn.id);
      return { connectionId, email: conn.email, status: "synced", reason: "cursor expired; reset to now" };
    }
    if (history.status === 401 || history.status === 403) {
      sqlite
        .prepare("UPDATE gmail_connections SET status = 'needs_reconnect', status_reason = ? WHERE id = ?")
        .run(`HTTP ${history.status}`, conn.id);
      return { connectionId, email: conn.email, status: "reconnect", reason: history.error };
    }
    return { connectionId, email: conn.email, status: "failed", reason: history.error };
  }

  const ids: string[] = [];
  for (const entry of history.data?.history ?? []) {
    for (const added of entry.messagesAdded ?? []) {
      if (added.message?.id && !ids.includes(added.message.id)) ids.push(added.message.id);
    }
  }

  const batch = ids.slice(0, MAX_MESSAGES_PER_TICK);
  let written = 0;
  for (const id of batch) {
    const already = sqlite.prepare("SELECT 1 FROM email_messages WHERE gmail_message_id = ?").get(id);
    if (already) continue;

    const msg = await getMessage(token.token, id);
    if (!msg.ok || !msg.data?.payload) continue;

    const labels = msg.data.labelIds ?? [];
    // Skip chats/drafts/spam/promotions — same intent as compai's WORK_MAIL_QUERY.
    if (labels.includes("DRAFT") || labels.includes("SPAM") || labels.includes("TRASH") || labels.includes("CATEGORY_PROMOTIONS") || labels.includes("CATEGORY_SOCIAL")) {
      continue;
    }

    const headers = msg.data.payload.headers;
    const from = parseAddress(header(headers, "from"));
    const result = writeMessage({
      rfcMessageId: normalizeRfcId(header(headers, "message-id")),
      rootMessageId: rootMessageId(headers),
      gmailMessageId: id,
      connectionId: conn.id,
      direction: labels.includes("SENT") ? "outbound" : "inbound",
      fromEmail: from.email,
      fromName: from.name,
      to: parseAddressList(header(headers, "to")),
      cc: parseAddressList(header(headers, "cc")),
      subject: header(headers, "subject"),
      snippet: msg.data.snippet ?? null,
      bodyText: plainTextBody(msg.data.payload) || null,
      bodyHtml: htmlBody(msg.data.payload),
      attachments: listAttachments(msg.data.payload),
      sentAt: msg.data.internalDate ? new Date(Number(msg.data.internalDate)).toISOString() : null,
    });
    if (result?.new) written++;
  }

  const remaining = ids.length - batch.length;
  sqlite
    .prepare("UPDATE gmail_connections SET history_cursor = ?, last_synced_at = datetime('now') WHERE id = ?")
    .run(remaining > 0 ? conn.history_cursor : (history.data?.historyId ?? conn.history_cursor), conn.id);

  return { connectionId, email: conn.email, status: "synced", written };
}

/** Cron entry: sync every connected mailbox; one failure never blocks the rest. */
export async function syncAllConnections(): Promise<SyncResult[]> {
  const rows = sqlite
    .prepare("SELECT id FROM gmail_connections WHERE status = 'connected'")
    .all() as Array<{ id: string }>;
  const out: SyncResult[] = [];
  for (const r of rows) {
    try {
      out.push(await syncConnection(r.id));
    } catch (e) {
      out.push({ connectionId: r.id, status: "failed", reason: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    }
  }
  return out;
}
