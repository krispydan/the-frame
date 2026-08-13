export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { requireOpsToken } from "@/lib/ops-auth";
import { instantlyClient } from "@/modules/sales/lib/instantly-client";

/** Instantly ids are UUIDs. A truncated one links a campaign that can never push. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  // ?instantly=1 lists the campaigns that exist on Instantly's side, which is
  // how you confirm an id before wiring a campaign to it.
  if (req.nextUrl.searchParams.get("instantly") === "1") {
    try {
      const remote = await instantlyClient.listCampaigns();
      return NextResponse.json({
        ok: true, source: "instantly", count: remote.length,
        campaigns: remote.map((c) => ({ id: c.id, name: c.name, status: c.status })),
      });
    } catch (e) {
      return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 502 });
    }
  }

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
    skipRemoteCheck?: boolean;
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

  // Validate the Instantly id BEFORE linking. A campaign wired to an id that
  // does not exist looks healthy here and fails only at push time, by which
  // point the failure is mixed in with a batch of real sends.
  const instId = body.instantlyCampaignId?.trim();
  if (instId) {
    if (!UUID_RE.test(instId)) {
      return NextResponse.json(
        { error: `'${instId}' is not a valid UUID (${instId.length} chars) — check for a truncated id` },
        { status: 400 },
      );
    }
    if (body.skipRemoteCheck !== true) {
      try {
        const remote = await instantlyClient.listCampaigns();
        const found = remote.find((c) => c.id === instId);
        if (!found) {
          return NextResponse.json(
            {
              error: `no Instantly campaign with id ${instId}`,
              hint: "GET /api/admin/ops/campaigns?instantly=1 lists the real ids",
            },
            { status: 400 },
          );
        }
      } catch (e) {
        // Cannot reach Instantly: refuse rather than link something unverified.
        return NextResponse.json(
          { error: `could not verify the id with Instantly: ${e instanceof Error ? e.message : String(e)}` },
          { status: 502 },
        );
      }
    }
  }

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
