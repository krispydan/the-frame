export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { getSessionUser } from "@/lib/get-session";
import { MAX_TOTAL_ATTACHMENT_BYTES, storeAttachment, type OutboxAttachment } from "@/modules/email/lib/outbox";

/**
 * POST multipart/form-data: outboxId + file → stores on the volume, returns
 * the attachment descriptor the composer keeps in its attachment list.
 *
 * The outbox row must exist first (the composer creates a draft on first
 * attach), belong to the caller, and still be editable.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "multipart form required" }, { status: 400 });

  const outboxId = String(form.get("outboxId") ?? "");
  const file = form.get("file");
  if (!outboxId || !(file instanceof File)) {
    return NextResponse.json({ error: "outboxId and file required" }, { status: 400 });
  }

  const row = sqlite
    .prepare("SELECT attachments_json FROM email_outbox WHERE id=? AND created_by=? AND status IN ('draft','scheduled')")
    .get(outboxId, user.id) as { attachments_json: string | null } | undefined;
  if (!row) return NextResponse.json({ error: "draft not found or not editable" }, { status: 404 });

  const existing: OutboxAttachment[] = row.attachments_json ? JSON.parse(row.attachments_json) : [];
  const existingBytes = existing.reduce((t, a) => t + a.size, 0);
  if (existingBytes + file.size > MAX_TOTAL_ATTACHMENT_BYTES) {
    return NextResponse.json(
      { error: `attachments exceed ${Math.floor(MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024)}MB total (Gmail's limit)` },
      { status: 413 },
    );
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const stored = await storeAttachment(outboxId, file.name, file.type || "application/octet-stream", buf);

  const updated = [...existing, stored];
  sqlite
    .prepare("UPDATE email_outbox SET attachments_json = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(updated), outboxId);

  return NextResponse.json({ ok: true, attachment: stored, attachments: updated });
}
