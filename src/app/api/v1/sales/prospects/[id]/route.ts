export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { getPipedriveConnectionStatus } from "@/modules/sales/lib/pipedrive-client";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const company = sqlite.prepare(`
    SELECT c.*, COALESCE(s.name, c.segment) as segment, COALESCE(c.owner_name, u.name) as owner_name, u.name as assigned_owner_name
    FROM companies c
    LEFT JOIN segments s ON s.id = c.segment_id
    LEFT JOIN users u ON u.id = c.owner_id
    WHERE c.id = ?
  `).get(id) as Record<string, unknown> | undefined;

  if (!company) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Get stores
  const storeRows = sqlite.prepare(`
    SELECT * FROM stores WHERE company_id = ? ORDER BY is_primary DESC, name ASC
  `).all(id) as Record<string, unknown>[];

  // Get contacts grouped by store
  const contactRows = sqlite.prepare(`
    SELECT * FROM contacts WHERE company_id = ? ORDER BY is_primary DESC, first_name ASC
  `).all(id) as Record<string, unknown>[];

  // Get activity feed
  const activities = sqlite.prepare(`
    SELECT * FROM activity_feed
    WHERE entity_id = ? OR entity_id IN (SELECT id FROM stores WHERE company_id = ?)
    ORDER BY created_at DESC LIMIT 50
  `).all(id, id) as Record<string, unknown>[];

  // The full call transcript lives in phoneburner_call_log (not the
  // feed) — inject it into the matching phoneburner_call_completed
  // events so the timeline can show it inline.
  try {
    const txRows = sqlite.prepare(
      `SELECT id, transcript FROM phoneburner_call_log
        WHERE company_id = ? AND transcript IS NOT NULL AND TRIM(transcript) <> ''`,
    ).all(id) as Array<{ id: string; transcript: string }>;
    if (txRows.length) {
      const byCallId = new Map(txRows.map((r) => [String(r.id), r.transcript]));
      for (const a of activities) {
        if (a.event_type !== "phoneburner_call_completed" || !a.data) continue;
        try {
          const d = JSON.parse(a.data as string) as Record<string, unknown>;
          const cid = d.call_id != null ? String(d.call_id) : null;
          if (cid && byCallId.has(cid)) {
            d.transcript = byCallId.get(cid);
            a.data = JSON.stringify(d);
          }
        } catch { /* leave event as-is */ }
      }
    }
  } catch { /* transcript column may be absent on old DBs */ }

  // Get change logs for notes/status changes
  const changes = sqlite.prepare(`
    SELECT * FROM change_logs
    WHERE entity_id = ? AND entity_type = 'company'
    ORDER BY timestamp DESC LIMIT 50
  `).all(id) as Record<string, unknown>[];

  // Campaigns this prospect appears in. One row per (company,
  // campaign) pair via campaign_leads. We surface per-channel push
  // status so the prospect-page sidebar can show "✓ in Instantly /
  // ✓ in PhoneBurner" badges without a second round-trip.
  //
  // `channels` on the campaign is JSON; the UI parses it. `pushed_to_*`
  // are booleans derived from the stamp columns on campaign_leads.
  const campaigns = sqlite.prepare(`
    SELECT
      cl.id                    AS lead_id,
      cl.campaign_id           AS campaign_id,
      cl.status                AS lead_status,
      cl.sent_at               AS sent_at,
      cl.replied_at            AS replied_at,
      cl.last_called_at        AS last_called_at,
      cl.call_count            AS call_count,
      cl.last_call_disposition AS last_call_disposition,
      cl.dismissed             AS dismissed,
      cl.created_at            AS added_at,
      (cl.instantly_lead_id IS NOT NULL)        AS pushed_to_instantly,
      (cl.phoneburner_contact_id IS NOT NULL)   AS pushed_to_phoneburner,
      c.name                   AS campaign_name,
      c.type                   AS campaign_type,
      c.status                 AS campaign_status,
      c.channels               AS campaign_channels
    FROM campaign_leads cl
    JOIN campaigns c ON c.id = cl.campaign_id
    WHERE cl.company_id = ?
    ORDER BY cl.created_at DESC
  `).all(id) as Array<Record<string, unknown>>;

  // Orders this prospect/company has placed. A prospect that ordered is in
  // practice a customer — surface the order history (and revenue) on the page.
  const orderRows = sqlite.prepare(`
    SELECT id, order_number, channel, status, total, currency,
           placed_at, created_at, shipped_at, tracking_number, tracking_carrier,
           pipedrive_deal_id
    FROM orders
    WHERE company_id = ?
    ORDER BY COALESCE(placed_at, created_at) DESC
  `).all(id) as Array<Record<string, unknown>>;

  const orderSummary = sqlite.prepare(`
    SELECT
      COUNT(*) AS order_count,
      COALESCE(SUM(CASE WHEN status != 'cancelled' THEN total ELSE 0 END), 0) AS total_revenue,
      MAX(COALESCE(placed_at, created_at)) AS last_order_at,
      MIN(COALESCE(placed_at, created_at)) AS first_order_at
    FROM orders
    WHERE company_id = ?
  `).get(id) as Record<string, unknown>;

  // Faire anonymized-customer detection: has a relay.faire.com contact email,
  // no real website, and no real (non-relay) email → needs manual mapping.
  const relayContact = sqlite.prepare(
    `SELECT email FROM contacts WHERE company_id = ?
       AND LOWER(COALESCE(email,'')) LIKE '%@relay.faire.com%'
     ORDER BY is_primary DESC, created_at ASC LIMIT 1`,
  ).get(id) as { email: string } | undefined;
  const realEmailContact = sqlite.prepare(
    `SELECT email FROM contacts WHERE company_id = ?
       AND TRIM(COALESCE(email,'')) <> '' AND LOWER(email) NOT LIKE '%@relay.faire.com%'
     LIMIT 1`,
  ).get(id) as { email: string } | undefined;
  const websiteEmpty = !company.website || !String(company.website).trim();
  const faireMapping = {
    needed: !!relayContact && websiteEmpty && !realEmailContact,
    relayEmail: relayContact?.email ?? null,
  };

  const pdStatus = getPipedriveConnectionStatus();

  return NextResponse.json({
    company: {
      ...company,
      tags: company.tags ? JSON.parse(company.tags as string) : [],
      pipedrive: {
        connected: pdStatus.connected,
        apiDomain: pdStatus.apiDomain ?? null,
        orgUrl: pdStatus.apiDomain && company.pipedrive_org_id ? `${pdStatus.apiDomain}/organization/${company.pipedrive_org_id}` : null,
        personUrl: pdStatus.apiDomain && company.pipedrive_person_id ? `${pdStatus.apiDomain}/person/${company.pipedrive_person_id}` : null,
      },
    },
    stores: storeRows,
    orders: orderRows,
    orderSummary,
    faireMapping,
    contacts: contactRows.map(c => ({
      ...c,
      is_primary: Boolean(c.is_primary),
    })),
    campaigns: campaigns.map((row) => ({
      lead_id: row.lead_id,
      campaign_id: row.campaign_id,
      campaign_name: row.campaign_name,
      campaign_type: row.campaign_type,
      campaign_status: row.campaign_status,
      channels: (() => {
        try {
          return JSON.parse(String(row.campaign_channels ?? "[]"));
        } catch {
          return [];
        }
      })(),
      lead_status: row.lead_status,
      added_at: row.added_at,
      sent_at: row.sent_at,
      replied_at: row.replied_at,
      last_called_at: row.last_called_at,
      call_count: row.call_count ?? 0,
      last_call_disposition: row.last_call_disposition,
      dismissed: Boolean(row.dismissed),
      pushed_to_instantly: Boolean(row.pushed_to_instantly),
      pushed_to_phoneburner: Boolean(row.pushed_to_phoneburner),
    })),
    activities: [...activities, ...changes.map(c => ({
      id: c.id,
      event_type: "change",
      module: "sales",
      entity_type: c.entity_type,
      entity_id: c.entity_id,
      data: JSON.stringify({ field: c.field, old: c.old_value, new: c.new_value, source: c.source }),
      user_id: c.user_id,
      created_at: c.timestamp,
    }))].sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || ""))).slice(0, 50),
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json();

  // Note: `phone` is intentionally NOT in allowedFields. company_phones
  // is the canonical store (see commit history around 2026-06-19);
  // phone edits route through the helper below so they land in the
  // right table. Once companies.phone is dropped, this also prevents
  // the UPDATE from erroring.
  const allowedFields: Record<string, string> = {
    name: "name", email: "email", website: "website",
    address: "address", city: "city", state: "state", zip: "zip",
    owner_id: "owner_id", notes: "notes",
    icp_score: "icp_score", icp_tier: "icp_tier", icp_reasoning: "icp_reasoning",
    tags: "tags",
    disqualify_reason: "disqualify_reason",
    segment: "segment",
    category: "category",
    lead_source_detail: "lead_source_detail",
    // NOTE: `status` is intentionally NOT in allowedFields here. Status
    // changes route through progressCompanyStatus (see below) so they
    // get forward-progression enforcement AND fan-out to Instantly +
    // PhoneBurner.
  };

  // ── phone: route through company_phones helper ──
  // Keeps the edit-form UX (user types in the Phone input, hits
  // Save) but writes to the canonical store. The reverse-mirror
  // trigger from commit 94abd38 used to handle this transparently;
  // once the column is dropped (Phase 3) this explicit path is the
  // only way phone edits land.
  let phoneHandled = false;
  if (typeof body.phone === "string") {
    phoneHandled = true;
    const { addCompanyPhone } = await import("@/modules/sales/lib/company-phones");
    addCompanyPhone(id, body.phone, "ui");
    // Log to change_logs to match the audit pattern used by other
    // fields. Old value is fetched from company_phones for fidelity.
    const old = sqlite
      .prepare(
        `SELECT phone FROM company_phones WHERE company_id = ?
          ORDER BY is_primary DESC, created_at ASC LIMIT 1`,
      )
      .get(id) as { phone: string | null } | undefined;
    sqlite
      .prepare(
        `INSERT INTO change_logs (id, entity_type, entity_id, field, old_value, new_value, source)
         VALUES (?, 'company', ?, 'phone', ?, ?, 'ui')`,
      )
      .run(
        crypto.randomUUID(),
        id,
        old?.phone ?? "",
        String(body.phone ?? ""),
      );
  }

  // ── status: special path through progressCompanyStatus ──
  let statusProgressionResult:
    | { updated: boolean; from: string | null; to: string }
    | null = null;
  if (typeof body.status === "string" && body.status.trim()) {
    const target = body.status.trim();
    // Log to change_logs the same way other fields do — preserves the
    // existing audit pattern.
    const oldStatus = (sqlite
      .prepare("SELECT status FROM companies WHERE id = ?")
      .get(id) as { status: string | null } | undefined)?.status ?? "";
    sqlite
      .prepare(
        `INSERT INTO change_logs (id, entity_type, entity_id, field, old_value, new_value, source)
         VALUES (?, 'company', ?, 'status', ?, ?, 'ui')`,
      )
      .run(crypto.randomUUID(), id, oldStatus, target);

    const { progressCompanyStatus } = await import(
      "@/modules/sales/lib/status-progression"
    );
    statusProgressionResult = progressCompanyStatus(
      id,
      target as Parameters<typeof progressCompanyStatus>[1],
      { source: "ui" },
    );
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  let pendingSegmentName: string | null | undefined;

  for (const [key, val] of Object.entries(body)) {
    const col = allowedFields[key];
    if (!col) continue;

    // Log change
    const old = sqlite.prepare(`SELECT ${col} FROM companies WHERE id = ?`).get(id) as Record<string, unknown>;
    const oldVal = old ? String(old[col] ?? "") : "";
    const newVal = key === "tags" ? JSON.stringify(val) : String(val ?? "");

    sqlite.prepare(`
      INSERT INTO change_logs (id, entity_type, entity_id, field, old_value, new_value, source)
      VALUES (?, 'company', ?, ?, ?, ?, 'ui')
    `).run(crypto.randomUUID(), id, col, oldVal, newVal);

    sets.push(`${col} = ?`);
    values.push(key === "tags" ? JSON.stringify(val) : val);
    if (key === "segment") {
      pendingSegmentName = typeof val === "string" ? val.trim() : val == null ? null : String(val).trim();
    }
  }

  // A status-only PATCH is valid — it goes through the special
  // progressCompanyStatus path above. Only return 400 when neither
  // status nor any other field was supplied.
  if (sets.length === 0 && !statusProgressionResult && !phoneHandled) {
    return NextResponse.json({ error: "No valid fields" }, { status: 400 });
  }
  // Status-only / phone-only patch — short-circuit before the
  // UPDATE/segment block. Both side-effect paths above already wrote
  // their data and logged change_logs entries.
  if (sets.length === 0) {
    sqlite
      .prepare(
        `INSERT INTO activity_feed (id, event_type, module, entity_type, entity_id, data)
         VALUES (?, 'company_updated', 'sales', 'company', ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        id,
        JSON.stringify({ fields: ["status"], status: statusProgressionResult }),
      );
    return NextResponse.json({ success: true, status: statusProgressionResult });
  }

  if (pendingSegmentName !== undefined) {
    let segmentId: string | null = null;
    if (pendingSegmentName) {
      sqlite.prepare(`
        INSERT OR IGNORE INTO segments (id, name, slug, status, created_at, updated_at)
        VALUES (lower(hex(randomblob(16))), ?, lower(replace(trim(?), ' ', '-')), 'active', datetime('now'), datetime('now'))
      `).run(pendingSegmentName, pendingSegmentName);
      segmentId = (sqlite.prepare(
        `SELECT id FROM segments WHERE lower(trim(name)) = lower(trim(?)) LIMIT 1`
      ).get(pendingSegmentName) as { id: string } | undefined)?.id ?? null;
    }
    sets.push("segment_id = ?");
    values.push(segmentId);
  }

  // If the reviewer touched icp_score / icp_tier / icp_reasoning, treat the
  // edit as a manual override so the auto-classifier doesn't undo it.
  // Stamp icp_updated_by + icp_updated_at for audit + UI.
  const editedIcp = ["icp_score", "icp_tier", "icp_reasoning"].some((k) => k in body);
  if (editedIcp) {
    sets.push("icp_manual_override = 1");
    sets.push("icp_updated_at = datetime('now')");
    // best-effort attribution; skip if no session helper available here
    try {
      const { getSessionUser } = await import("@/lib/get-session");
      const user = await getSessionUser();
      if (user?.id) {
        sets.push("icp_updated_by = ?");
        values.push(user.id);
      }
    } catch { /* no session, leave NULL */ }
  }

  sets.push("updated_at = datetime('now')");
  values.push(id);

  sqlite.prepare(`UPDATE companies SET ${sets.join(", ")} WHERE id = ?`).run(...values);

  // Log activity
  sqlite.prepare(`
    INSERT INTO activity_feed (id, event_type, module, entity_type, entity_id, data)
    VALUES (?, 'company_updated', 'sales', 'company', ?, ?)
  `).run(crypto.randomUUID(), id, JSON.stringify({ fields: Object.keys(body) }));

  return NextResponse.json({ success: true });
}
