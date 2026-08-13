export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { requireOpsToken } from "@/lib/ops-auth";

/**
 * Campaign registry, from tooling.
 *
 * GET                                        → campaigns + lead counts + Instantly link
 * POST ?confirm=1 {action:'create', name, instantlyCampaignId}
 *
 * Creating a campaign sends nothing and is reversible; it only gives leads
 * somewhere to be routed. The push itself lives elsewhere and stays gated on
 * verification.
 */

export async function GET(req: NextRequest) {
  const denied = requireOpsToken(req);
  if (denied) return denied;

  const rows = sqlite
    .prepare(
      `SELECT c.id, c.name, c.type, c.status, c.instantly_campaign_id AS instantlyCampaignId,
              c.created_at AS createdAt,
              (SELECT COUNT(*) FROM campaign_leads cl WHERE cl.campaign_id = c.id) AS leads,
              (SELECT COUNT(*) FROM campaign_leads cl WHERE cl.campaign_id = c.id
                 AND cl.instantly_lead_id IS NOT NULL) AS leadsWithInstantlyId
         FROM campaigns c
        ORDER BY leads DESC, c.created_at DESC`,
    )
    .all();
  return NextResponse.json({ ok: true, count: rows.length, campaigns: rows });
}

export async function POST(req: NextRequest) {
  const denied = requireOpsToken(req);
  if (denied) return denied;
  if (req.nextUrl.searchParams.get("confirm") !== "1") {
    return NextResponse.json({ error: "add ?confirm=1" }, { status: 400 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    action?: string; name?: string; instantlyCampaignId?: string; description?: string;
  };

  // Fail closed on anything unrecognised — see AGENTS.md.
  if (body.action !== "create") {
    return NextResponse.json(
      { error: `unknown action '${body.action ?? "(none)"}' — this endpoint supports: create` },
      { status: 400 },
    );
  }
  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });

  const existing = sqlite.prepare("SELECT id, instantly_campaign_id FROM campaigns WHERE name = ? LIMIT 1")
    .get(name) as { id: string; instantly_campaign_id: string | null } | undefined;

  if (existing) {
    // Idempotent: re-running with the same name links the Instantly id rather
    // than creating a duplicate campaign for the same audience.
    if (body.instantlyCampaignId && existing.instantly_campaign_id !== body.instantlyCampaignId) {
      sqlite.prepare("UPDATE campaigns SET instantly_campaign_id = ?, updated_at = datetime('now') WHERE id = ?")
        .run(body.instantlyCampaignId, existing.id);
      return NextResponse.json({ ok: true, id: existing.id, name, created: false, linked: true });
    }
    return NextResponse.json({ ok: true, id: existing.id, name, created: false, linked: false });
  }

  const id = randomUUID();
  sqlite
    .prepare(
      `INSERT INTO campaigns (id, name, type, status, description, instantly_campaign_id, created_at, updated_at)
       VALUES (?, ?, 'email_sequence', 'active', ?, ?, datetime('now'), datetime('now'))`,
    )
    .run(id, name, body.description ?? null, body.instantlyCampaignId ?? null);

  return NextResponse.json({ ok: true, id, name, created: true, instantlyCampaignId: body.instantlyCampaignId ?? null });
}
