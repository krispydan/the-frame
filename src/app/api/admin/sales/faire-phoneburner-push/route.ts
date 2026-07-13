export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { buildFairePhoneBurnerLeads, type FairePhoneBurnerLead } from "@/modules/sales/lib/faire-marketplace-import";
import { phoneBurnerClient, type PbContactPayload } from "@/modules/sales/lib/phoneburner-client";
import { dedupeTagsArray } from "@/modules/sales/lib/dedupe-tags";

/**
 * POST /api/admin/sales/faire-phoneburner-push
 *
 * Uploads the callable Faire cohort into PhoneBurner, split by value: high →
 * Christina, low → Sandra. One API key (the account both reps belong to);
 * contacts are routed to each rep via owner_id and land in a per-rep folder
 * named after the campaign. Body = customers CSV (raw) or multipart
 * (customers + emails overlay).
 *
 *   commit=false (default): resolve reps + counts, no upload.
 *   commit=true: kick a background push; poll GET for progress.
 *   limit=N: cap the number of contacts per rep (test a small batch first).
 *   christina=<match>, sandra=<match>: substring to match the member name/username
 *     (defaults "christ" / "sandra"); or christinaId / sandraId for exact user ids.
 *   folder=NAME to override the folder name.
 *
 * Idempotent via a faire_phoneburner_pushed company tag. Auth: x-admin-key.
 */

const RUN_KEY = "faire_phoneburner_push_run";
const PUSHED_TAG = "faire_phoneburner_pushed";
const DEFAULT_FOLDER = "AJM - Faire Customers - Faire Market";

function getSetting(key: string): string | null {
  const r = sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string | null } | undefined;
  return r?.value ?? null;
}
function setSetting(key: string, value: string): void {
  sqlite
    .prepare(
      `INSERT INTO settings (key, value, type, module, updated_at)
       VALUES (?, ?, 'string', 'phoneburner', datetime('now'))
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

interface Member { userId: string; username: string | null; name: string | null; email: string | null }
function matchMember(members: Member[], needleOrId: string): Member | null {
  const n = needleOrId.toLowerCase();
  return (
    members.find((m) => m.userId === needleOrId) ||
    members.find((m) => `${m.name ?? ""} ${m.username ?? ""} ${m.email ?? ""}`.toLowerCase().includes(n)) ||
    null
  );
}

/** Resolve (creating once, cached in settings) the rep's campaign folder. */
async function ensureRepFolder(repKey: string, folderName: string, ownerId: string): Promise<string> {
  const cacheKey = `faire_pb_folder_${repKey}`;
  const cached = getSetting(cacheKey);
  if (cached) return cached;
  const existing = (await phoneBurnerClient.listFolders()).find((f) => (f.name || "").trim().toLowerCase() === folderName.trim().toLowerCase());
  const id = existing ? existing.id : (await phoneBurnerClient.createFolder({ folder_name: folderName, owner_id: ownerId })).id;
  setSetting(cacheKey, id);
  return id;
}

function toPayload(l: FairePhoneBurnerLead, ownerId: string, folderId: string): PbContactPayload {
  const notes = [
    l.store ? `Store: ${l.store}` : "",
    l.spend ? `AJM lifetime: $${Math.round(l.spend)}` : "",
    l.orderCount ? `${l.orderCount} orders` : "",
    l.lastOrdered ? `Last ordered: ${l.lastOrdered}` : "",
    `Tier: ${l.tier}`,
    "Campaign: AJM Faire Market",
  ]
    .filter(Boolean)
    .join(" | ");
  return {
    owner_id: ownerId,
    category_id: folderId,
    first_name: l.firstName || l.store || undefined,
    last_name: l.lastName || undefined,
    email: l.email || undefined,
    phone: l.phone,
    city: l.city || undefined,
    state: l.state || undefined,
    zip: l.zip || undefined,
    notes,
    on_duplicate: "skip",
    custom_fields: [
      { name: "Company", value: l.store || "" },
      { name: "AJM Lifetime Spend", value: l.spend ? `$${Math.round(l.spend)}` : "" },
      { name: "Last Ordered", value: l.lastOrdered || "" },
      { name: "Tier", value: l.tier },
    ],
  };
}

export async function GET() {
  const raw = getSetting(RUN_KEY);
  return NextResponse.json(raw ? JSON.parse(raw) : { state: "idle" });
}

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (phoneBurnerClient.isMock) {
    return NextResponse.json({ error: "PhoneBurner not configured — set PHONEBURNER_API_KEY or settings.phoneburner_api_key" }, { status: 400 });
  }
  const url = new URL(req.url);
  const commit = url.searchParams.get("commit") === "true";
  const years = Math.max(1, parseInt(url.searchParams.get("years") || "4", 10));
  const highMin = Math.max(0, parseFloat(url.searchParams.get("highMin") || "1500"));
  const limit = url.searchParams.get("limit") ? Math.max(1, parseInt(url.searchParams.get("limit")!, 10)) : null;
  const folderName = url.searchParams.get("folder") || DEFAULT_FOLDER;
  const christinaMatch = url.searchParams.get("christinaId") || url.searchParams.get("christina") || "christ";
  const sandraMatch = url.searchParams.get("sandraId") || url.searchParams.get("sandra") || "sandra";

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

  const members = await phoneBurnerClient.listMembers();
  const christina = matchMember(members, christinaMatch);
  const sandra = matchMember(members, sandraMatch);

  const { high, low } = buildFairePhoneBurnerLeads(text, { recencyYears: years, highMinSpend: highMin, emailOverlay });
  const notPushed = (l: FairePhoneBurnerLead) => !(l.frameCompanyId && companyHasTag(l.frameCompanyId, PUSHED_TAG));
  let highTo = high.filter(notPushed);
  let lowTo = low.filter(notPushed);
  if (limit) {
    highTo = highTo.slice(0, limit);
    lowTo = lowTo.slice(0, limit);
  }

  if (!commit) {
    return NextResponse.json({
      ok: true,
      commit: false,
      teamMembers: members,
      resolved: { christina: christina ?? "NOT FOUND", sandra: sandra ?? "NOT FOUND" },
      counts: { high_christina: highTo.length, low_sandra: lowTo.length, high_total: high.length, low_total: low.length },
      folderName,
      sample: { christina: highTo.slice(0, 2), sandra: lowTo.slice(0, 2) },
      note:
        !christina || !sandra
          ? "Could not match one/both reps — pass ?christina= / ?sandra= (name substring) or christinaId= / sandraId=."
          : "Resolve only. Re-run with commit=true (start with &limit=5) to upload.",
    });
  }

  if (!christina || !sandra) {
    return NextResponse.json(
      { error: "could not resolve both reps", teamMembers: members, hint: "pass ?christina= / ?sandra= or christinaId= / sandraId=" },
      { status: 400 },
    );
  }

  const jobs: Array<{ rep: Member; repKey: string; leads: FairePhoneBurnerLead[] }> = [
    { rep: christina, repKey: "christina", leads: highTo },
    { rep: sandra, repKey: "sandra", leads: lowTo },
  ];
  const total = highTo.length + lowTo.length;
  setSetting(RUN_KEY, JSON.stringify({ state: "running", total, done: 0, added: 0, errors: 0, startedAt: new Date().toISOString() }));

  void (async () => {
    let done = 0,
      added = 0,
      errors = 0;
    const errSamples: string[] = [];
    for (const job of jobs) {
      let folderId: string;
      try {
        folderId = await ensureRepFolder(job.repKey, folderName, job.rep.userId);
      } catch (e) {
        errors += job.leads.length;
        done += job.leads.length;
        if (errSamples.length < 15) errSamples.push(`${job.repKey} folder: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      for (const l of job.leads) {
        try {
          await phoneBurnerClient.createContact(toPayload(l, job.rep.userId, folderId));
          added++;
          if (l.frameCompanyId) tagCompany(l.frameCompanyId, PUSHED_TAG);
        } catch (e) {
          errors++;
          if (errSamples.length < 15) errSamples.push(`${l.store} (${l.phone}): ${e instanceof Error ? e.message : String(e)}`);
        }
        done++;
        if (done % 10 === 0) setSetting(RUN_KEY, JSON.stringify({ state: "running", total, done, added, errors, errSamples, updatedAt: new Date().toISOString() }));
      }
    }
    setSetting(RUN_KEY, JSON.stringify({ state: "done", total, done, added, errors, errSamples, finishedAt: new Date().toISOString() }));
  })();

  return NextResponse.json({
    ok: true,
    commit: true,
    started: true,
    reps: { christina: christina.name || christina.username, sandra: sandra.name || sandra.username },
    total,
    note: "Uploading in background — poll GET on this route for progress.",
  });
}
