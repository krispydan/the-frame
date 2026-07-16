export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { updateOrganization, createActivity, pdRequest } from "@/modules/sales/lib/pipedrive-client";
import { getPipelineOwner } from "@/modules/sales/lib/pipedrive-setup";
import {
  loadCatalogCohort,
  enrichCatalogChunk,
  resetNoResultTags,
  tagCompany,
  MAILED_TAG,
  type CohortRow,
} from "@/modules/sales/lib/catalog-mail";

/**
 * Catalog direct-mail campaign — leads in the Pipedrive "Catalog Interested"
 * pipeline who have NEVER purchased, mailed a physical catalog.
 *
 *   GET                                  → cohort + address audit (JSON)
 *   GET  ?format=csv                     → mailing spreadsheet (CSV download)
 *   POST ?action=enrich-chunk&limit=12   → enrich one bounded chunk of missing
 *                                          addresses via Apify (the cron calls
 *                                          the same core; manual for on-demand)
 *   POST ?action=sync-pipedrive&commit=true → write full mailing address to each
 *                                          lead's Pipedrive organization
 *   POST ?action=log-mail&commit=true    → log a done "Direct Mail" activity on
 *                                          each lead's deal (idempotent via tag)
 *
 * Auth: x-admin-key: jaxy2026.
 */

const LOG_RUN_KEY = "catalog_mail_log_run";

function getSetting(key: string): string | null {
  return (sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value?.trim() || null;
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

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function buildCsv(rows: CohortRow[]): string {
  const base = getSetting("pipedrive_api_domain")?.replace(/\/$/, "") ?? "";
  const header = [
    "store", "contact_name", "address", "city", "state", "zip",
    "email", "phone", "address_complete", "deal_stage", "already_mailed", "pipedrive_deal_url",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.store, r.contactName, r.address, r.city, r.state, r.zip,
        r.email, r.phone, r.addressComplete ? "yes" : "NO - needs address",
        r.dealStage ?? "", r.alreadyMailed ? "yes" : "",
        base && r.pipedriveDealId ? `${base}/deal/${r.pipedriveDealId}` : "",
      ]
        .map((v) => csvEscape(String(v ?? "")))
        .join(","),
    );
  }
  return lines.join("\n");
}

/** Resolve the "Direct Mail" activity type key_string from Pipedrive (cached). */
async function directMailTypeKey(): Promise<string> {
  const cached = getSetting("pipedrive_direct_mail_type_key");
  if (cached) return cached;
  const types = (await pdRequest<Array<{ key_string: string; name: string }>>("GET", "/activityTypes")) || [];
  const match = types.find((t) => t.name.trim().toLowerCase() === "direct mail");
  if (!match) throw new Error(`Pipedrive has no "Direct Mail" activity type. Found: ${types.map((t) => t.name).join(", ")}`);
  setSetting("pipedrive_direct_mail_type_key", match.key_string);
  return match.key_string;
}

export async function GET(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  if (url.searchParams.get("run") === "log") {
    const raw = getSetting(LOG_RUN_KEY);
    return NextResponse.json(raw ? JSON.parse(raw) : { state: "idle" });
  }

  const cohort = loadCatalogCohort();
  if (url.searchParams.get("format") === "csv") {
    // Default the CSV to mailable rows (complete address); ?all=true for everything.
    const rows = url.searchParams.get("all") === "true" ? cohort : cohort.filter((r) => r.addressComplete);
    return new NextResponse(buildCsv(rows), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="catalog-mail-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  }
  const missing = cohort.filter((r) => !r.addressComplete);
  return NextResponse.json({
    ok: true,
    cohort: cohort.length,
    addressComplete: cohort.length - missing.length,
    addressMissing: missing.length,
    stillEnrichable: missing.filter((r) => !r.noAddressResult).length,
    noResultGaveUp: missing.filter((r) => r.noAddressResult).length,
    alreadyMailed: cohort.filter((r) => r.alreadyMailed).length,
    missingSample: missing.slice(0, 10).map((r) => ({ store: r.store, city: r.city, state: r.state, zip: r.zip, gaveUp: r.noAddressResult })),
  });
}

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "";

  if (action === "enrich-chunk") {
    const limit = Math.max(1, parseInt(url.searchParams.get("limit") || "12", 10));
    const result = await enrichCatalogChunk(limit);
    return NextResponse.json({ ok: true, ...result });
  }

  if (action === "reset-noresult") {
    return NextResponse.json({ ok: true, cleared: resetNoResultTags() });
  }

  const cohort = loadCatalogCohort();
  const commit = url.searchParams.get("commit") === "true";

  if (action === "sync-pipedrive") {
    const targets = cohort.filter((r) => r.pipedriveOrgId && r.addressComplete);
    if (!commit) {
      return NextResponse.json({ ok: true, commit: false, wouldSync: targets.length, skippedNoOrg: cohort.filter((r) => !r.pipedriveOrgId).length, skippedIncomplete: cohort.filter((r) => !r.addressComplete).length });
    }
    let synced = 0,
      errors = 0;
    const errSamples: string[] = [];
    for (const t of targets) {
      try {
        await updateOrganization(t.pipedriveOrgId!, { address: `${t.address}, ${t.city}, ${t.state} ${t.zip}` });
        synced++;
      } catch (e) {
        errors++;
        if (errSamples.length < 10) errSamples.push(`${t.store}: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
      }
    }
    return NextResponse.json({ ok: true, synced, errors, errSamples });
  }

  if (action === "log-mail") {
    const targets = cohort.filter((r) => !r.alreadyMailed && r.addressComplete);
    if (!commit) {
      return NextResponse.json({
        ok: true,
        commit: false,
        wouldLog: targets.length,
        skippedAlreadyMailed: cohort.filter((r) => r.alreadyMailed).length,
        skippedNoAddress: cohort.filter((r) => !r.addressComplete && !r.alreadyMailed).length,
      });
    }
    let typeKey: string;
    try {
      typeKey = await directMailTypeKey();
    } catch (e) {
      return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }
    const owner = getPipelineOwner("catalog")?.id;
    const today = new Date().toISOString().slice(0, 10);
    setSetting(LOG_RUN_KEY, JSON.stringify({ state: "running", total: targets.length, done: 0, startedAt: new Date().toISOString() }));

    void (async () => {
      let done = 0,
        logged = 0,
        errors = 0;
      const errSamples: string[] = [];
      for (const t of targets) {
        try {
          await createActivity({
            subject: `Catalog mailed — ${t.store}`,
            type: typeKey,
            deal_id: t.pipedriveDealId ?? undefined,
            org_id: t.pipedriveOrgId ?? undefined,
            person_id: t.pipedrivePersonId ?? undefined,
            user_id: owner,
            due_date: today,
            done: 1,
            note: `Physical catalog sent via direct mail to: ${t.address}, ${t.city}, ${t.state} ${t.zip}`,
          });
          tagCompany(t.companyId, MAILED_TAG);
          logged++;
        } catch (e) {
          errors++;
          if (errSamples.length < 10) errSamples.push(`${t.store}: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
        }
        done++;
        if (done % 10 === 0) setSetting(LOG_RUN_KEY, JSON.stringify({ state: "running", total: targets.length, done, logged, errors, errSamples, updatedAt: new Date().toISOString() }));
      }
      setSetting(LOG_RUN_KEY, JSON.stringify({ state: "done", total: targets.length, done, logged, errors, errSamples, finishedAt: new Date().toISOString() }));
    })();

    return NextResponse.json({ ok: true, started: true, logging: targets.length, note: "Poll GET ?run=log for progress." });
  }

  return NextResponse.json({ error: `unknown action "${action}" — use enrich-chunk | sync-pipedrive | log-mail` }, { status: 400 });
}
