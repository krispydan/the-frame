export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * GET /api/v1/marketing/email/images — the email image library.
 *
 * Every image ever uploaded to a campaign (hero / secondary / secondary-2),
 * newest first, deduped by path, labeled with the campaign it came from.
 * No new table: the campaign rows ARE the library — this endpoint just
 * inverts them so the editor can offer "reuse an existing image" instead
 * of forcing a fresh upload/render per campaign (brand consistency +
 * saves a designer round-trip for repeat product shots).
 */
export async function GET() {
  const rows = sqlite
    .prepare(
      `SELECT hero_image_path      AS path, 'hero'       AS kind, name, subject, audience, scheduled_date AS scheduledDate, updated_at AS updatedAt
         FROM marketing_email_campaigns WHERE hero_image_path IS NOT NULL AND hero_image_path != ''
       UNION ALL
       SELECT secondary_image_path AS path, 'secondary'  AS kind, name, subject, audience, scheduled_date, updated_at
         FROM marketing_email_campaigns WHERE secondary_image_path IS NOT NULL AND secondary_image_path != ''
       UNION ALL
       SELECT secondary_image_path_2 AS path, 'secondary' AS kind, name, subject, audience, scheduled_date, updated_at
         FROM marketing_email_campaigns WHERE secondary_image_path_2 IS NOT NULL AND secondary_image_path_2 != ''
       ORDER BY updated_at DESC`,
    )
    .all() as Array<{
      path: string;
      kind: string;
      name: string | null;
      subject: string | null;
      audience: string;
      scheduledDate: string;
      updatedAt: string | null;
    }>;

  // Dedupe by path (an image reused across campaigns appears once, with
  // its most recent context).
  const seen = new Set<string>();
  const images = rows.filter((r) => {
    if (seen.has(r.path)) return false;
    seen.add(r.path);
    return true;
  }).map((r) => ({
    path: r.path,
    kind: r.kind,
    from: r.name || r.subject || "(untitled)",
    audience: r.audience,
    scheduledDate: r.scheduledDate,
  }));

  return NextResponse.json({ images, total: images.length });
}
