export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { resolveByEmail } from "@/modules/sales/lib/lead-resolution";
import { progressCompanyStatus } from "@/modules/sales/lib/status-progression";

/**
 * POST /api/admin/instantly/backfill-interested
 *
 * Walks instantly_webhook_events for the past N days (default 30) and
 * upgrades every lead with a positive-intent event to
 * companies.status = "interested" — so they land on the kanban board.
 *
 * Positive-intent events we count:
 *   - lead_interested        (Instantly's explicit "Interested" label)
 *   - lead_meeting_booked    (even stronger signal)
 *
 * Reply events (`reply_received`, `auto_reply_received`) are NOT
 * included because "I replied" doesn't imply positive intent — many
 * replies are "remove me" / OOO / wrong-person. Only Christina's
 * manual classification (Interested) or a calendly booking counts.
 *
 * progressCompanyStatus is forward-only: leads already at
 * catalog_sent / customer / etc. are not downgraded.
 *
 * Body (all optional):
 *   { sinceDays?: number, dryRun?: boolean }   default sinceDays=30
 * Auth: x-admin-key: jaxy2026
 */
interface PositiveEvent {
  lead_email: string;
  campaign_id: string | null;
  event_type: string;
  received_at: string;
}

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { sinceDays?: number; dryRun?: boolean } = {};
  try {
    body = await req.json();
  } catch { /* empty body OK */ }
  const sinceDays = body.sinceDays ?? 30;
  const dryRun = body.dryRun === true;

  const sinceIso = new Date(Date.now() - sinceDays * 24 * 3600_000).toISOString();

  // Get unique (lead_email, latest event_type) tuples — we only need
  // one progression per company, so collapse on email.
  const rows = sqlite
    .prepare(
      `SELECT lead_email,
              campaign_id,
              event_type,
              MAX(received_at) AS received_at
         FROM instantly_webhook_events
        WHERE received_at >= ?
          AND event_type IN ('lead_interested', 'lead_meeting_booked')
          AND token_valid = 1
          AND lead_email IS NOT NULL
        GROUP BY lower(lead_email)
        ORDER BY received_at DESC`,
    )
    .all(sinceIso) as PositiveEvent[];

  const summary = {
    ok: true,
    dry_run: dryRun,
    since: sinceIso,
    scanned: rows.length,
    progressed: 0,
    already_at_or_past: 0,
    unmatched: 0,
    progressed_by_event: { lead_interested: 0, lead_meeting_booked: 0 } as Record<string, number>,
    sample_progressed: [] as Array<{ email: string; event: string; from: string | null }>,
  };

  for (const r of rows) {
    const match = resolveByEmail({
      leadEmail: r.lead_email,
      instantlyCampaignId: r.campaign_id,
    });
    if (!match) {
      summary.unmatched++;
      continue;
    }
    if (dryRun) {
      // Just inspect the current status to predict the outcome.
      const cur = sqlite
        .prepare("SELECT status FROM companies WHERE id = ?")
        .get(match.companyId) as { status: string | null } | undefined;
      const wouldProgress = !cur?.status || ["prospect", "qualified_lead"].includes(cur.status);
      if (wouldProgress) {
        summary.progressed++;
        summary.progressed_by_event[r.event_type] =
          (summary.progressed_by_event[r.event_type] ?? 0) + 1;
        if (summary.sample_progressed.length < 10) {
          summary.sample_progressed.push({
            email: r.lead_email,
            event: r.event_type,
            from: cur?.status ?? null,
          });
        }
      } else {
        summary.already_at_or_past++;
      }
      continue;
    }
    try {
      const result = progressCompanyStatus(match.companyId, "interested", {
        source: "instantly",
      });
      if (result.updated) {
        summary.progressed++;
        summary.progressed_by_event[r.event_type] =
          (summary.progressed_by_event[r.event_type] ?? 0) + 1;
        if (summary.sample_progressed.length < 10) {
          summary.sample_progressed.push({
            email: r.lead_email,
            event: r.event_type,
            from: result.from,
          });
        }
      } else {
        summary.already_at_or_past++;
      }
    } catch (e) {
      console.error("[backfill-interested] progressCompanyStatus failed:", e);
    }
  }

  return NextResponse.json(summary);
}
