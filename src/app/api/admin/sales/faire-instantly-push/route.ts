export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { buildFaireInstantlyLeads } from "@/modules/sales/lib/faire-marketplace-import";
import { instantlyClient } from "@/modules/sales/lib/instantly-client";
import { dedupeTagsArray } from "@/modules/sales/lib/dedupe-tags";

/**
 * POST /api/admin/sales/faire-instantly-push
 *
 * Uploads the Faire reactivation email cohort into an Instantly campaign by
 * name (default "AJM - Faire Customers - Faire Market"), with rich custom
 * variables (city, state, store_type, lifetime_spend, order_count,
 * last_ordered, first_ordered, tier, owner). Body = customers CSV (raw) or
 * multipart (customers + emails overlay).
 *
 *   commit=false (default): resolve the campaign + count, no upload.
 *   commit=true: kick a background push; poll GET on this route for progress.
 *   limit=N: push only the first N leads (test a small batch first).
 *   campaign=NAME to override the campaign name.
 *
 * Idempotent for frame-matched stores: a company tagged faire_instantly_pushed
 * is skipped on re-run. Auth: x-admin-key: jaxy2026.
 */

const RUN_KEY = "faire_instantly_push_run";
const PUSHED_TAG = "faire_instantly_pushed";

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
function tagCompany(companyId: string, tag: string): void {
  const row = sqlite.prepare("SELECT tags FROM companies WHERE id = ?").get(companyId) as { tags: string | null } | undefined;
  let existing: string[] = [];
  try {
    existing = row?.tags ? (JSON.parse(row.tags) as string[]) : [];
  } catch {
    existing = row?.tags ? row.tags.split(",").map((s) => s.trim()).filter(Boolean) : [];
  }
  sqlite.prepare("UPDATE companies SET tags = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(dedupeTagsArray([...existing, tag])), companyId);
}
function companyHasTag(companyId: string, tag: string): boolean {
  const row = sqlite.prepare("SELECT tags FROM companies WHERE id = ?").get(companyId) as { tags: string | null } | undefined;
  return (row?.tags || "").toLowerCase().includes(tag.toLowerCase());
}

export async function GET() {
  const raw = getSetting(RUN_KEY);
  return NextResponse.json(raw ? JSON.parse(raw) : { state: "idle" });
}

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (instantlyClient.isMock) {
    return NextResponse.json({ error: "Instantly not configured — set INSTANTLY_API_KEY or settings.instantly_api_key" }, { status: 400 });
  }
  const url = new URL(req.url);
  const commit = url.searchParams.get("commit") === "true";
  const years = Math.max(1, parseInt(url.searchParams.get("years") || "4", 10));
  const highMin = Math.max(0, parseFloat(url.searchParams.get("highMin") || "1500"));
  const limit = url.searchParams.get("limit") ? Math.max(1, parseInt(url.searchParams.get("limit")!, 10)) : null;
  const campaignName = url.searchParams.get("campaign") || "AJM - Faire Customers - Faire Market";

  let text = "";
  let emailOverlay: string | undefined;
  if ((req.headers.get("content-type") || "").includes("multipart/form-data")) {
    const form = await req.formData();
    const customers = form.get("customers");
    const emails = form.get("emails");
    if (customers instanceof File) text = await customers.text();
    if (emails instanceof File) emailOverlay = await emails.text();
  } else {
    text = await req.text();
  }
  if (!text || text.trim().length < 20) {
    return NextResponse.json({ error: "empty body — POST the customers CSV (raw, or -F customers=@file)" }, { status: 400 });
  }

  // Resolve the campaign by name.
  const campaigns = await instantlyClient.listCampaigns();
  const campaign = campaigns.find((c) => (c.name || "").trim().toLowerCase() === campaignName.trim().toLowerCase());
  if (!campaign) {
    return NextResponse.json(
      { error: `campaign "${campaignName}" not found`, availableCampaigns: campaigns.map((c) => c.name).slice(0, 50) },
      { status: 404 },
    );
  }

  const { leads } = buildFaireInstantlyLeads(text, { recencyYears: years, highMinSpend: highMin, emailOverlay });
  // Skip frame-matched stores already pushed (idempotent re-runs).
  const afterSkip = leads.filter((l) => !(l.frameCompanyId && companyHasTag(l.frameCompanyId, PUSHED_TAG)));
  const toPush = limit ? afterSkip.slice(0, limit) : afterSkip;

  if (!commit) {
    return NextResponse.json({
      ok: true,
      commit: false,
      campaign: { id: campaign.id, name: campaign.name },
      totalEligible: leads.length,
      alreadyPushedSkipped: leads.length - afterSkip.length,
      willPush: toPush.length,
      sample: toPush.slice(0, 3).map((l) => l.lead),
      note: "Resolve only. Re-run with commit=true (start with &limit=5) to upload.",
    });
  }

  const total = toPush.length;
  setSetting(RUN_KEY, JSON.stringify({ state: "running", campaign: campaign.name, total, done: 0, added: 0, errors: 0, startedAt: new Date().toISOString() }));

  void (async () => {
    let done = 0,
      added = 0,
      errors = 0;
    const errSamples: string[] = [];
    const CHUNK = 25;
    for (let i = 0; i < toPush.length; i += CHUNK) {
      const chunk = toPush.slice(i, i + CHUNK);
      try {
        const res = await instantlyClient.addLeadsToCampaign(campaign.id, chunk.map((c) => c.lead));
        for (let j = 0; j < chunk.length; j++) {
          const r = res.results[j];
          if (r && !r.error) {
            added++;
            if (chunk[j].frameCompanyId) tagCompany(chunk[j].frameCompanyId!, PUSHED_TAG);
          } else {
            errors++;
            if (errSamples.length < 15) errSamples.push(`${chunk[j].lead.email}: ${r?.error || "unknown"}`);
          }
          done++;
        }
      } catch (e) {
        errors += chunk.length;
        done += chunk.length;
        if (errSamples.length < 15) errSamples.push(`chunk@${i}: ${e instanceof Error ? e.message : String(e)}`);
      }
      setSetting(RUN_KEY, JSON.stringify({ state: "running", campaign: campaign.name, total, done, added, errors, errSamples, updatedAt: new Date().toISOString() }));
    }
    setSetting(RUN_KEY, JSON.stringify({ state: "done", campaign: campaign.name, total, done, added, errors, errSamples, finishedAt: new Date().toISOString() }));
  })();

  return NextResponse.json({ ok: true, commit: true, started: true, campaign: { id: campaign.id, name: campaign.name }, total, note: "Uploading in background — poll GET on this route for progress." });
}
