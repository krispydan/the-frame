/**
 * The ONLY writer of email_threads and email_messages — the single-writer
 * rule ported from compai's ThreadWriterService, because two writers with
 * two upsert strategies is how threads fork.
 *
 * Threads key on the root RFC message id. Company/contact linking is
 * match-only: we link a thread to a company when a participant's address
 * matches a known contact email or a company domain. Unlike compai we do
 * NOT auto-create companies/contacts from mail — this inbox feeds a CRM
 * with 30k+ curated companies; silently minting records from every
 * correspondent would pollute it. Unmatched mail is stored unlinked and
 * visible in the sender's own views only.
 */

import { sqlite } from "@/lib/db";

export interface IncomingMessage {
  rfcMessageId: string | null;
  rootMessageId: string | null;
  gmailMessageId: string | null;
  connectionId: string;
  direction: "inbound" | "outbound";
  fromEmail: string | null;
  fromName: string | null;
  to: string[];
  cc: string[];
  subject: string | null;
  snippet: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  attachments: Array<{ filename: string; size: number; mime: string; gmailAttachmentId: string | null }>;
  sentAt: string | null;
}

function matchCompany(addresses: string[]): { companyId: string | null; contactId: string | null } {
  for (const email of addresses) {
    if (!email) continue;
    const contact = sqlite
      .prepare(
        `SELECT id, company_id FROM contacts
          WHERE lower(email) = lower(?) AND company_id IS NOT NULL LIMIT 1`,
      )
      .get(email) as { id: string; company_id: string } | undefined;
    if (contact) return { companyId: contact.company_id, contactId: contact.id };
  }
  // Domain fallback — skip free-mail domains so "someone@gmail.com" doesn't
  // link to whichever company once had a gmail contact.
  const FREE = new Set(["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com", "me.com", "msn.com", "live.com", "comcast.net", "att.net"]);
  for (const email of addresses) {
    const domain = email?.split("@")[1]?.toLowerCase();
    if (!domain || FREE.has(domain)) continue;
    const company = sqlite
      .prepare(`SELECT id FROM companies WHERE lower(domain) = ? LIMIT 1`)
      .get(domain) as { id: string } | undefined;
    if (company) return { companyId: company.id, contactId: null };
  }
  return { companyId: null, contactId: null };
}

/**
 * Idempotent: an rfc_message_id we already hold is a no-op (Gmail history
 * replays, the 1-second overlap, and our own sent-mail echo all hit this).
 */
export function writeMessage(msg: IncomingMessage): { threadId: string; messageId: string; new: boolean } | null {
  if (msg.rfcMessageId) {
    const existing = sqlite
      .prepare("SELECT id, thread_id FROM email_messages WHERE rfc_message_id = ?")
      .get(msg.rfcMessageId) as { id: string; thread_id: string } | undefined;
    if (existing) return { threadId: existing.thread_id, messageId: existing.id, new: false };
  }

  const root = msg.rootMessageId ?? msg.rfcMessageId;
  if (!root) return null;

  const write = sqlite.transaction(() => {
    let thread = sqlite
      .prepare("SELECT id, company_id, contact_id, message_count, first_message_at FROM email_threads WHERE root_message_id = ?")
      .get(root) as { id: string; company_id: string | null; contact_id: string | null; message_count: number; first_message_at: string | null } | undefined;

    if (!thread) {
      // The external side of the correspondence decides the link — never our
      // own address (every thread would match our own domain otherwise).
      const ourEmail = (sqlite
        .prepare("SELECT email FROM gmail_connections WHERE id = ?")
        .get(msg.connectionId) as { email: string } | undefined)?.email?.toLowerCase();
      const participants = [msg.fromEmail, ...msg.to, ...msg.cc]
        .filter((e): e is string => !!e)
        .map((e) => e.toLowerCase())
        .filter((e) => e !== ourEmail);
      const { companyId, contactId } = matchCompany(participants);

      const threadId = crypto.randomUUID();
      sqlite
        .prepare(
          `INSERT INTO email_threads (id, root_message_id, subject, company_id, contact_id, first_message_at, last_message_at, message_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
        )
        .run(threadId, root, msg.subject, companyId, contactId, msg.sentAt, msg.sentAt);
      thread = { id: threadId, company_id: companyId, contact_id: contactId, message_count: 0, first_message_at: msg.sentAt };
    }

    const messageId = crypto.randomUUID();
    sqlite
      .prepare(
        `INSERT INTO email_messages
           (id, thread_id, rfc_message_id, gmail_message_id, connection_id, direction,
            from_email, from_name, to_json, cc_json, subject, snippet, body_text, body_html,
            has_attachments, attachments_json, sent_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        messageId, thread.id, msg.rfcMessageId, msg.gmailMessageId, msg.connectionId, msg.direction,
        msg.fromEmail, msg.fromName, JSON.stringify(msg.to), JSON.stringify(msg.cc),
        msg.subject, msg.snippet, msg.bodyText, msg.bodyHtml,
        msg.attachments.length ? 1 : 0,
        msg.attachments.length ? JSON.stringify(msg.attachments) : null,
        msg.sentAt,
      );

    sqlite
      .prepare(
        `UPDATE email_threads
            SET message_count = message_count + 1,
                last_message_at = MAX(COALESCE(last_message_at, ''), COALESCE(?, '')),
                first_message_at = CASE WHEN first_message_at IS NULL OR (? != '' AND ? < first_message_at) THEN ? ELSE first_message_at END
          WHERE id = ?`,
      )
      .run(msg.sentAt ?? "", msg.sentAt ?? "", msg.sentAt ?? "", msg.sentAt, thread.id);

    // Surface on the record timeline (the prospect page reads activity_feed) —
    // and this is the event the Pipedrive activity mirror will pick up during
    // the CRM-migration overlap.
    if (thread.company_id) {
      sqlite
        .prepare(
          `INSERT INTO activity_feed (id, event_type, module, entity_type, entity_id, data)
           VALUES (?, ?, 'sales', 'company', ?, ?)`,
        )
        .run(
          crypto.randomUUID(),
          msg.direction === "outbound" ? "gmail_email_sent" : "gmail_email_received",
          thread.company_id,
          JSON.stringify({
            thread_id: thread.id, subject: msg.subject,
            from: msg.fromEmail, to: msg.to, snippet: msg.snippet?.slice(0, 200) ?? null,
          }),
        );
    }

    return { threadId: thread.id, messageId };
  });

  const result = write();
  return { ...result, new: true };
}
