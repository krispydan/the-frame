export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { sqlite } from "@/lib/db";
import { analyzeFaireExport, type FaireAnalysisRow } from "@/modules/sales/lib/faire-marketplace-import";
import { ensureOutreachDeal } from "@/modules/sales/lib/pipedrive-sync";
import { createActivity, updateDeal, updateOrganization, updatePerson } from "@/modules/sales/lib/pipedrive-client";
import { getPipelineOwner } from "@/modules/sales/lib/pipedrive-setup";
import { addCompanyEmail } from "@/modules/sales/lib/company-emails";
import { dedupeTagsArray } from "@/modules/sales/lib/dedupe-tags";

/**
 * POST /api/admin/sales/faire-marketplace-push
 *
 * Pushes the AJM Faire reactivation cohort into the existing AJM Reactivation
 * pipeline for the Faire Market calling campaign. Body = the customers CSV
 * (raw) or multipart (customers + emails overlay), same as the analysis route.
 *
 * For each target store (ordered on AJM Faire, not a Jaxy customer, within the
 * recency window):
 *   - matches/creates the frame company (net-new stores get a record),
 *   - tags it faire_market_2026 + faire_high|faire_low (+ needs_phone),
 *   - ensures a deal in AJM Reactivation ("To Contact"), owned by Christina
 *     (spend ≥ highMin) or Sandra (below) — idempotent, existing deals just get
 *     re-owned,
 *   - drops a dated "Call for Faire Market" task on each callable store's deal
 *     with the campaign message.
 *
 *   commit=false (default): plan only — returns the funnel + split, no writes.
 *   commit=true: kicks a background run; poll GET on this route for progress.
 *   limit=N: process only the first N target stores (test a small batch first).
 *   message=...: the call-task note (the campaign pitch). dueDays=N (default 3).
 *   highMin=1500, years=4, christinaId / sandraId to override owners.
 *
 * Auth: x-admin-key: jaxy2026
 */

const RUN_KEY = "faire_market_push_run";
const CAMPAIGN_TAG = "faire_market_2026";
const TASKED_TAG = "faire_market_2026_tasked"; // idempotency marker for the call task

function getSetting(key: string): string | null {
  const r = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string | null } | undefined;
  return r?.value ?? null;
}
function setSetting(key: string, value: string): void {
  sqlite
    .prepare(
      `INSERT INTO settings (key, value, type, module, updated_at)
       VALUES (?, ?, 'string', 'sales', datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    )
    .run(key, value);
}

function mergeCompanyTags(companyId: string, add: (string | null)[]): string[] {
  const row = sqlite.prepare("SELECT tags FROM companies WHERE id = ?").get(companyId) as { tags: string | null } | undefined;
  let existing: string[] = [];
  try {
    existing = row?.tags ? (JSON.parse(row.tags) as string[]) : [];
  } catch {
    existing = row?.tags ? row.tags.split(",").map((s) => s.trim()).filter(Boolean) : [];
  }
  const merged = dedupeTagsArray([...existing, ...add.filter((t): t is string => !!t)]);
  sqlite.prepare("UPDATE companies SET tags = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(merged), companyId);
  return merged;
}

/** Create a net-new frame company (+ primary contact) for a store not yet in the frame. */
function createCompany(row: FaireAnalysisRow): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO companies (id, name, address, city, state, zip, country, status, source, source_type, tags, ajm_total_spend, ajm_last_order, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      row.storeName || "AJM Faire store",
      row.address1 ?? null,
      row.city ?? null,
      row.state ?? null,
      row.zip ?? null,
      "United States",
      "qualified_lead",
      "ajm_faire",
      "ajm_faire",
      JSON.stringify(["ajm_faire"]),
      row.spend || null,
      row.lastOrdered ?? null,
      now,
      now,
    );
  if (row.contact) {
    const [first, ...rest] = row.contact.split(/\s+/);
    sqlite
      .prepare("INSERT INTO contacts (id, company_id, first_name, last_name, email, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(randomUUID(), id, first || row.contact, rest.join(" ") || "", row.email ?? null, now, now);
  }
  return id;
}

function orgPersonIds(companyId: string): { orgId: number | null; personId: number | null } {
  const c = sqlite.prepare("SELECT pipedrive_org_id, pipedrive_person_id FROM companies WHERE id = ?").get(companyId) as
    | { pipedrive_org_id: number | null; pipedrive_person_id: number | null }
    | undefined;
  return { orgId: c?.pipedrive_org_id ?? null, personId: c?.pipedrive_person_id ?? null };
}

export async function GET() {
  const raw = getSetting(RUN_KEY);
  return NextResponse.json(raw ? JSON.parse(raw) : { state: "idle" });
}

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const commit = url.searchParams.get("commit") === "true";
  const years = Math.max(1, parseInt(url.searchParams.get("years") || "4", 10));
  const highMin = Math.max(0, parseFloat(url.searchParams.get("highMin") || "1500"));
  const limit = url.searchParams.get("limit") ? Math.max(1, parseInt(url.searchParams.get("limit")!, 10)) : null;
  const dueDays = Math.max(0, parseInt(url.searchParams.get("dueDays") || "3", 10));
  let message = url.searchParams.get("message") || "";
  const christinaId = url.searchParams.get("christinaId")
    ? parseInt(url.searchParams.get("christinaId")!, 10)
    : getPipelineOwner("ajm")?.id;
  const sandraId = url.searchParams.get("sandraId")
    ? parseInt(url.searchParams.get("sandraId")!, 10)
    : getPipelineOwner("catalog")?.id;

  // Read customers CSV (+ optional emails overlay).
  let text = "";
  let emailOverlay: string | undefined;
  if ((req.headers.get("content-type") || "").includes("multipart/form-data")) {
    const form = await req.formData();
    const customers = form.get("customers");
    const emails = form.get("emails");
    if (customers instanceof File) text = await customers.text();
    if (emails instanceof File) emailOverlay = await emails.text();
    // Allow the call-task message as a form field so spaces/punctuation don't
    // need URL-encoding (query param still works and wins if set).
    const formMsg = form.get("message");
    if (!message && typeof formMsg === "string") message = formMsg;
  } else {
    text = await req.text();
  }
  if (!text || text.trim().length < 20) {
    return NextResponse.json({ error: "empty body — POST the customers CSV (raw, or -F customers=@file)" }, { status: 400 });
  }

  const analysis = analyzeFaireExport(text, { recencyYears: years, highMinSpend: highMin, emailOverlay, includeRows: true });
  let target = (analysis.rows || []).filter((r) => !r.alreadyJaxy && r.withinWindow);
  if (limit) target = target.slice(0, limit);

  const ownersResolved = { christinaId: christinaId ?? null, sandraId: sandraId ?? null };
  if (!commit) {
    // Plan only.
    return NextResponse.json({
      ok: true,
      commit: false,
      owners: ownersResolved,
      willProcess: target.length,
      dueDays,
      messageProvided: !!message,
      funnel: analysis.funnel,
      target: analysis.target,
      note: "Plan only. Re-run with commit=true (start with &limit=5 to test) once the message is set.",
    });
  }

  if (christinaId == null || sandraId == null) {
    return NextResponse.json(
      { error: "owner ids unresolved — set per-pipeline owners, or pass christinaId & sandraId" },
      { status: 400 },
    );
  }

  const total = target.length;
  setSetting(
    RUN_KEY,
    JSON.stringify({ state: "running", total, done: 0, created: 0, addedDeals: 0, reowned: 0, tasks: 0, errors: 0, startedAt: new Date().toISOString() }),
  );

  const due = new Date();
  due.setDate(due.getDate() + dueDays);
  const dueDate = due.toISOString().slice(0, 10);

  // Fire-and-forget background processing with progress (Railway keeps the
  // process alive past the HTTP response).
  void (async () => {
    let done = 0,
      created = 0,
      addedDeals = 0,
      reowned = 0,
      tasks = 0,
      errors = 0;
    const errSamples: string[] = [];
    for (const row of target) {
      try {
        const owner = row.segment === "high" ? christinaId : sandraId;
        let companyId = row.frameCompanyId;
        if (!companyId) {
          companyId = createCompany(row);
          created++;
        }
        mergeCompanyTags(companyId, [CAMPAIGN_TAG, row.segment === "high" ? "faire_high" : "faire_low", row.hasPhone ? null : "needs_phone"]);
        // Fill AJM value fields if empty; stash the looked-up email on contacts.
        sqlite
          .prepare("UPDATE companies SET ajm_total_spend = COALESCE(ajm_total_spend, ?), ajm_last_order = COALESCE(ajm_last_order, ?) WHERE id = ?")
          .run(row.spend || null, row.lastOrdered ?? null, companyId);
        if (row.email) addCompanyEmail(companyId, row.email, "faire_lookup");

        const r = await ensureOutreachDeal(companyId, "ajm", "To Contact", { ownerOverride: owner });
        if (r.action === "created") addedDeals++;

        const { orgId, personId } = orgPersonIds(companyId);
        // Re-own an already-existing deal/org/person to the value-based owner.
        if (r.action !== "created") {
          if (r.dealId) await updateDeal(r.dealId, { user_id: owner });
          if (orgId) await updateOrganization(orgId, { owner_id: owner });
          if (personId) await updatePerson(personId, { owner_id: owner });
          reowned++;
        }

        // Call task for callable stores (idempotent via TASKED_TAG marker).
        const tagsRow = sqlite.prepare("SELECT tags FROM companies WHERE id = ?").get(companyId) as { tags: string | null } | undefined;
        const alreadyTasked = (tagsRow?.tags || "").includes(TASKED_TAG);
        if (row.hasPhone && message && r.dealId && !alreadyTasked) {
          await createActivity({
            subject: `Call for Faire Market — ${row.storeName || "store"}`,
            type: "call",
            deal_id: r.dealId,
            org_id: orgId ?? undefined,
            user_id: owner, // Pipedrive activities assign via user_id (not owner_id)
            due_date: dueDate,
            note: message,
            done: false,
          });
          mergeCompanyTags(companyId, [TASKED_TAG]);
          tasks++;
        }
      } catch (e) {
        errors++;
        if (errSamples.length < 15) errSamples.push(`${row.storeName}: ${e instanceof Error ? e.message : String(e)}`);
      }
      done++;
      if (done % 20 === 0) {
        setSetting(RUN_KEY, JSON.stringify({ state: "running", total, done, created, addedDeals, reowned, tasks, errors, errSamples, updatedAt: new Date().toISOString() }));
      }
    }
    setSetting(RUN_KEY, JSON.stringify({ state: "done", total, done, created, addedDeals, reowned, tasks, errors, errSamples, finishedAt: new Date().toISOString() }));
  })();

  return NextResponse.json({
    ok: true,
    commit: true,
    started: true,
    total,
    owners: ownersResolved,
    note: "Running in background — poll GET on this route for progress.",
  });
}
