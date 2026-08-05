export const dynamic = "force-dynamic";
export const maxDuration = 600;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { phoneBurnerAccounts } from "@/modules/sales/lib/phoneburner-client";
import {
  resolveByCampaignLeadId,
  resolveByCompanyId,
  resolveByEmail,
  resolveByPbContactId,
  resolveByPhone,
} from "@/modules/sales/lib/lead-resolution";
import { progressCompanyStatus } from "@/modules/sales/lib/status-progression";

/**
 * POST /api/admin/sales/backfill-pb-appointments
 *
 * Backfill Christina & Sandra's PhoneBurner "Set Appointment" calls
 * whose companies didn't get promoted to `interested` (and thus never
 * fanned out to Pipedrive). Diagnostic + repair for the AJM
 * reactivation cohort — its PB contacts predate our Company ID custom
 * field stamping so the old webhook resolveEvent returned null.
 *
 * The fix upstream is wiring resolveByEmail into the webhook path
 * (already shipped). This endpoint patches the *history*: it pages
 * both reps' recent calls, filters to Set Appointment dispositions,
 * runs the full resolve chain (now including email), and applies
 * progressCompanyStatus to any that resolve. status-progression fans
 * out to Pipedrive so the deal appears on the kanban.
 *
 * Body:
 *   { since_days?: 30, dryRun?: true, only_emails?: string[] }
 *
 * Auth: x-admin-key: jaxy2026
 */

interface PbCall extends Record<string, unknown> {
  id?: string;
  call_id?: string;
  contact_id?: string;
  user_id?: string;
  disposition?: string;
  disposition_label?: string;
  phone?: string;
  called_at?: string;
  timestamp?: string;
}

const APPT_DISPOSITIONS = [
  "set appointment",
  "set appt",
  "appointment set",
  "appt set",
];

function isSetAppointment(disp: string | null | undefined): boolean {
  if (!disp) return false;
  const norm = disp.trim().toLowerCase();
  return APPT_DISPOSITIONS.some((d) => norm.startsWith(d));
}

export async function POST(req: NextRequest) {
  try {
    return await handle(req);
  } catch (e) {
    console.error("[backfill-pb-appointments] crashed:", e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

async function handle(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = (await req.json()) as {
    since_days?: number;
    dryRun?: boolean;
    only_emails?: string[];
    only_rep?: "sandra" | "christina";
    until_days?: number; // upper bound: only process calls OLDER than N days ago
  };
  const sinceDays = Math.max(1, Math.min(365, body.since_days ?? 30));
  const untilDays = body.until_days != null ? Math.max(0, Math.min(365, body.until_days)) : 0;
  const sinceIso = new Date(Date.now() - sinceDays * 86400_000).toISOString();
  const untilMs = untilDays > 0 ? Date.now() - untilDays * 86400_000 : Number.MAX_SAFE_INTEGER;
  const only = new Set((body.only_emails || []).map((e) => e.toLowerCase().trim()));

  let accounts = phoneBurnerAccounts();
  if (body.only_rep) accounts = accounts.filter((a) => a.rep === body.only_rep);
  const appointments: Array<{
    rep: string;
    call_id: string;
    contact_id: string;
    disposition: string;
    called_at: string;
    email: string | null;
    phone: string | null;
    resolved: string | null; // resolver name that hit
    company_id: string | null;
    frame_before: string | null;
    frame_after: string | null;
    error?: string;
  }> = [];

  // Page every rep's calls since sinceDays. PB `listRecentCalls` returns
  // dispositions inline, so we filter locally.
  for (const acct of accounts) {
    let page = 1;
    let cap = 60; // 60 pages × 100 = 6000 calls (~2mo peak volume)
    while (cap-- > 0) {
      let batch: PbCall[];
      try {
        batch = (await acct.client.listRecentCalls({
          since: sinceIso,
          page,
          page_size: 100,
        })) as unknown as PbCall[];
      } catch (e) {
        appointments.push({
          rep: acct.rep,
          call_id: `(page ${page} error)`,
          contact_id: "",
          disposition: "",
          called_at: "",
          email: null,
          phone: null,
          resolved: null,
          company_id: null,
          frame_before: null,
          frame_after: null,
          error: e instanceof Error ? e.message : String(e),
        });
        break;
      }
      if (!batch || batch.length === 0) break;

      for (const call of batch) {
        const disp = String(call.disposition_label || call.disposition || "");
        if (!isSetAppointment(disp)) continue;

        // Upper-bound filter (until_days) — skip calls newer than the boundary.
        // Lets us slice a 30-day range into non-overlapping chunks so each fits
        // under Cloudflare's 100s edge cap.
        const calledAtStr = String(call.called_at || call.timestamp || "");
        if (calledAtStr && untilMs !== Number.MAX_SAFE_INTEGER) {
          const ms = Date.parse(calledAtStr.replace(" ", "T") + "Z");
          if (!isNaN(ms) && ms > untilMs) continue;
        }

        // Fetch the contact to get the email — PbCall doesn't include it.
        let email: string | null = null;
        let phone: string | null = call.phone ? String(call.phone) : null;
        if (call.contact_id) {
          try {
            const raw = await acct.client.getContact(String(call.contact_id));
            let rec = raw as Record<string, unknown>;
            if (rec?.contacts && typeof rec.contacts === "object") rec = rec.contacts as Record<string, unknown>;
            const inner = rec.contacts;
            if (Array.isArray(inner)) rec = (inner[0] as Record<string, unknown>) || {};
            else if (inner && typeof inner === "object") rec = inner as Record<string, unknown>;
            const pe = rec.primary_email as { email_address?: unknown } | string | undefined;
            email = typeof pe === "string"
              ? pe.toLowerCase().trim() || null
              : String((pe?.email_address as string) || "").toLowerCase().trim() || null;
            const pp = rec.primary_phone as { phone?: unknown; raw_phone?: unknown } | undefined;
            const ppStr = pp?.phone != null ? String(pp.phone) : pp?.raw_phone != null ? String(pp.raw_phone) : null;
            if (!phone && ppStr) phone = ppStr;
          } catch {
            /* ignore per-contact fetch errors */
          }
        }

        if (only.size > 0 && email && !only.has(email)) continue;

        // Full resolve chain — mirrors the webhook + adds email.
        let resolvedName: string | null = null;
        let match = resolveByCampaignLeadId(call.user_id ?? null);
        if (match) resolvedName = "campaign_lead_id";
        if (!match) {
          match = resolveByCompanyId(null); // no custom field on the call payload
        }
        if (!match) {
          match = resolveByPbContactId(call.contact_id ?? null);
          if (match) resolvedName = "pb_contact_id";
        }
        if (!match) {
          match = resolveByEmail({ leadEmail: email });
          if (match) resolvedName = "email";
        }
        if (!match) {
          match = resolveByPhone(phone);
          if (match) resolvedName = "phone";
        }

        const companyId = match?.companyId ?? null;

        // Snapshot frame state before + after
        const before = companyId
          ? (sqlite.prepare("SELECT status FROM companies WHERE id = ?").get(companyId) as { status: string } | undefined)?.status ?? null
          : null;
        let after: string | null = before;

        if (companyId && !body.dryRun) {
          try {
            // Force=true because we WANT to override any not_qualified we set
            // during the reconcile — a "Set Appt" outcome overrides the CSV
            // rule (rep verbally confirmed interest).
            const r = progressCompanyStatus(companyId, "interested", {
              source: "phoneburner",
              force: true,
            });
            after = r.to;
          } catch (e) {
            appointments.push({
              rep: acct.rep,
              call_id: String(call.id || call.call_id || ""),
              contact_id: String(call.contact_id || ""),
              disposition: disp,
              called_at: String(call.called_at || call.timestamp || ""),
              email,
              phone,
              resolved: resolvedName,
              company_id: companyId,
              frame_before: before,
              frame_after: after,
              error: e instanceof Error ? e.message : String(e),
            });
            continue;
          }
        }

        appointments.push({
          rep: acct.rep,
          call_id: String(call.id || call.call_id || ""),
          contact_id: String(call.contact_id || ""),
          disposition: disp,
          called_at: String(call.called_at || call.timestamp || ""),
          email,
          phone,
          resolved: resolvedName,
          company_id: companyId,
          frame_before: before,
          frame_after: after,
        });
      }

      if (batch.length < 100) break;
      page++;
    }
  }

  const resolvedCount = appointments.filter((a) => a.company_id != null && !a.error).length;
  const unresolved = appointments.filter((a) => a.company_id == null && !a.error);
  const promoted = appointments.filter((a) => a.frame_before !== "interested" && a.frame_after === "interested");

  return NextResponse.json({
    ok: true,
    dry_run: !!body.dryRun,
    since: sinceIso,
    total_set_appt_calls: appointments.length,
    resolved: resolvedCount,
    unresolved: unresolved.length,
    promoted_to_interested: promoted.length,
    appointments,
    unresolved_sample: unresolved.slice(0, 20),
  });
}
