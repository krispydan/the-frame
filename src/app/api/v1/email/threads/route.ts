export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { getSessionUser } from "@/lib/get-session";

/**
 * GET ?companyId=…          → threads (with messages) linked to a company
 * GET ?threadId=…           → one thread's full messages
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const p = req.nextUrl.searchParams;
  const threadId = p.get("threadId");
  const companyId = p.get("companyId");

  if (threadId) {
    const messages = sqlite
      .prepare(
        `SELECT id, direction, from_email, from_name, to_json, cc_json, subject, snippet,
                body_text, body_html, has_attachments, attachments_json, sent_at
           FROM email_messages WHERE thread_id = ? ORDER BY sent_at ASC`,
      )
      .all(threadId);
    return NextResponse.json({ ok: true, messages });
  }

  if (!companyId) return NextResponse.json({ error: "companyId or threadId required" }, { status: 400 });

  const threads = sqlite
    .prepare(
      `SELECT t.id, t.subject, t.first_message_at, t.last_message_at, t.message_count,
              (SELECT snippet FROM email_messages m WHERE m.thread_id = t.id ORDER BY m.sent_at DESC LIMIT 1) AS last_snippet,
              (SELECT direction FROM email_messages m WHERE m.thread_id = t.id ORDER BY m.sent_at DESC LIMIT 1) AS last_direction,
              (SELECT from_email FROM email_messages m WHERE m.thread_id = t.id ORDER BY m.sent_at DESC LIMIT 1) AS last_from
         FROM email_threads t
        WHERE t.company_id = ?
        ORDER BY t.last_message_at DESC
        LIMIT 50`,
    )
    .all(companyId);

  return NextResponse.json({ ok: true, threads });
}
