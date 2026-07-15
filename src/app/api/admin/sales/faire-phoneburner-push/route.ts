export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { buildFairePhoneBurnerLeads, buildFairePhoneBurnerLeadsFromDb, type FairePhoneBurnerLead } from "@/modules/sales/lib/faire-marketplace-import";
import { phoneBurnerClientFor, PB_ACCOUNTS, type PbContactPayload, type PbRep } from "@/modules/sales/lib/phoneburner-client";
import { ensureFreshPhoneBurnerToken } from "@/modules/sales/lib/phoneburner-oauth";
import { dedupeTagsArray } from "@/modules/sales/lib/dedupe-tags";

/**
 * POST /api/admin/sales/faire-phoneburner-push
 *
 * Uploads the callable Faire cohort into PhoneBurner, split by value into each
 * caller's OWN account: high → Christina's account, low → Sandra's (existing)
 * account.
 *
 * Cohort source: by default, read from the frame — the companies the campaign
 * push already tagged (faire_market_2026 + faire_high|faire_low) with their AJM
 * spend/phone/contact. No local file needed. Optionally POST a customers CSV
 * (raw, or multipart customers + emails overlay) to drive it from a fresh export
 * instead.
 *
 *   commit=false (default): resolve both accounts + counts, no upload.
 *   commit=true: kick a background push; poll GET for progress.
 *   limit=N: cap contacts per rep (test a small batch first).
 *   folder=NAME to override the folder name.
 *
 * Christina's account must be set up first (POST /phoneburner-setup). Idempotent
 * via a faire_phoneburner_pushed company tag. Auth: x-admin-key: jaxy2026.
 */

const RUN_KEY = "faire_phoneburner_push_run";
const PUSHED_TAG = "faire_phoneburner_pushed";
const DEFAULT_FOLDER = "AJM - Faire Customers - Faire Market";

function getSetting(key: string): string | null {
  return (sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
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

/** Resolve the caller's account: client, owner_id (from settings or discovery),
 *  username fallback, and whether it's usable. */
async function resolveAccount(rep: PbRep) {
  const cfg = PB_ACCOUNTS[rep];
  const client = phoneBurnerClientFor(rep);
  const configured = !client.isMock;
  let ownerId = getSetting(cfg.ownerSetting);
  // Only auto-discover for the default account owner (Sandra). For a second
  // user on the SAME account (Christina), discovery would return the account's
  // default owner — wrong — so her owner_id must be set explicitly via setup.
  if (rep === "sandra" && configured && !ownerId) {
    ownerId = await client.discoverOwnerId().catch(() => null);
    if (ownerId) setSetting(cfg.ownerSetting, ownerId);
  }
  const username = getSetting(`phoneburner_username_${rep}`);
  return { rep, cfg, client, configured, ownerId, username, usable: configured && (!!ownerId || !!username) };
}

function toPayload(l: FairePhoneBurnerLead, ownerId: string | null, username: string | null, folderId: string | null): PbContactPayload {
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
  const p: PbContactPayload = {
    first_name: l.firstName || l.store || undefined,
    last_name: l.lastName || undefined,
    company: l.store || undefined,
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
  if (ownerId) p.owner_id = ownerId;
  else if (username) p.owner_username = username;
  if (folderId) p.category_id = folderId;
  return p;
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
  const folderName = url.searchParams.get("folder") || DEFAULT_FOLDER;

  // Cohort source: by default we read the cohort straight from the frame (the
  // companies the campaign push already tagged faire_market_2026 + faire_high|
  // faire_low, with their AJM spend/phone/contact) — no local file needed.
  // Posting a customers CSV is still supported as an override for a fresh export
  // that hasn't been imported yet.
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
  const fromCsv = !!text && text.trim().length >= 20;

  // Renew Christina's OAuth token if near expiry before we resolve her client.
  await ensureFreshPhoneBurnerToken("christina").catch(() => null);
  const christina = await resolveAccount("christina");
  const sandra = await resolveAccount("sandra");

  // Optional rep filter — push only one caller's leads (e.g. just Christina's
  // to her own account) without touching the other's.
  const onlyRep = url.searchParams.get("rep");
  // refile=true re-processes contacts already tagged faire_phoneburner_pushed —
  // used to backfill fields (e.g. company) onto contacts pushed by an earlier
  // run. Normal runs skip already-pushed companies (idempotent).
  const refile = url.searchParams.get("refile") === "true";
  const { high, low } = fromCsv
    ? buildFairePhoneBurnerLeads(text, { recencyYears: years, highMinSpend: highMin, emailOverlay })
    : buildFairePhoneBurnerLeadsFromDb();
  const notPushed = (l: FairePhoneBurnerLead) => refile || !(l.frameCompanyId && companyHasTag(l.frameCompanyId, PUSHED_TAG));
  const highAfter = (onlyRep === "sandra" ? [] : high).filter(notPushed);
  const lowAfter = (onlyRep === "christina" ? [] : low).filter(notPushed);
  const highTo = limit ? highAfter.slice(0, limit) : highAfter;
  const lowTo = limit ? lowAfter.slice(0, limit) : lowAfter;

  const accountView = (a: Awaited<ReturnType<typeof resolveAccount>>) => ({
    rep: a.rep,
    accountConfigured: a.configured,
    ownerId: a.ownerId,
    username: a.username,
    usable: a.usable,
  });

  if (!commit) {
    return NextResponse.json({
      ok: true,
      commit: false,
      source: fromCsv ? "csv" : "frame_db",
      accounts: { christina: accountView(christina), sandra: accountView(sandra) },
      counts: { high_christina: highTo.length, low_sandra: lowTo.length, high_total: high.length, low_total: low.length },
      folderName,
      sample: { christina: highTo.slice(0, 2), sandra: lowTo.slice(0, 2) },
      note:
        !christina.usable
          ? "Christina's account isn't set up — POST /phoneburner-setup with her apiKey (+ username) first."
          : "Resolve only. Re-run with commit=true (start with &limit=5) to upload.",
    });
  }

  const blockers: string[] = [];
  if (highTo.length && !christina.usable) blockers.push("Christina's account not usable (set up her apiKey/username via /phoneburner-setup)");
  if (lowTo.length && !sandra.usable) blockers.push("Sandra's account not usable");
  // Fail fast on a bad/expired token rather than 401ing through every lead.
  // One cheap auth probe per rep we're about to write to.
  if (highTo.length && christina.usable) {
    const probe = await christina.client.authProbe().catch((e) => ({ ok: false, raw: e instanceof Error ? e.message : String(e) }));
    if (!probe.ok) {
      blockers.push(
        `Christina's PhoneBurner token is invalid/expired (${String((probe as { raw?: unknown }).raw).slice(0, 120)}). ` +
          `Re-authorize at ${req.nextUrl.origin}/api/auth/phoneburner?rep=christina (logged in as Christina), then re-run.`,
      );
    }
  }
  if (lowTo.length && sandra.usable) {
    const probe = await sandra.client.authProbe().catch((e) => ({ ok: false, raw: e instanceof Error ? e.message : String(e) }));
    if (!probe.ok) blockers.push(`Sandra's PhoneBurner token is invalid/expired (${String((probe as { raw?: unknown }).raw).slice(0, 120)}).`);
  }
  if (blockers.length) return NextResponse.json({ error: "cannot commit", blockers }, { status: 400 });

  const jobs = [
    { acct: christina, repKey: "christina" as const, leads: highTo },
    { acct: sandra, repKey: "sandra" as const, leads: lowTo },
  ];
  const total = highTo.length + lowTo.length;
  setSetting(RUN_KEY, JSON.stringify({ state: "running", total, done: 0, added: 0, errors: 0, startedAt: new Date().toISOString() }));

  void (async () => {
    let done = 0,
      added = 0,
      filed = 0,
      errors = 0;
    const errSamples: string[] = [];
    for (const job of jobs) {
      if (!job.leads.length) continue;
      const { client, cfg } = job.acct;
      let ownerId = job.acct.ownerId;
      const username = job.acct.username;
      // Create the campaign folder once, owned by this rep (needs owner_id).
      let folderId: string | null = null;
      const folderCacheKey = `faire_pb_folder_${job.repKey}`;
      const cachedFolder = getSetting(folderCacheKey);
      if (cachedFolder) folderId = cachedFolder;
      else if (ownerId) {
        try {
          const existing = (await client.listFolders()).find((f) => (f.name || "").trim().toLowerCase() === folderName.trim().toLowerCase());
          folderId = existing ? existing.id : (await client.createFolder({ folder_name: folderName, owner_id: ownerId })).id;
          setSetting(folderCacheKey, folderId);
        } catch (e) {
          if (errSamples.length < 15) errSamples.push(`${job.repKey} folder: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      for (const l of job.leads) {
        try {
          const resp = await client.createOrGetContact(toPayload(l, ownerId, username, folderId));
          if (resp.duplicate) {
            // Contact already exists in the workspace (e.g. from the AJM
            // Reactivation import). File the EXISTING contact into this rep's
            // campaign folder so it shows up for this week's calling. category_id
            // sets the folder; owner_id re-assigns to the dialing rep (ignored by
            // PB on update if the token can't own it, which is fine).
            // Enrich the existing contact with the company name too — many were
            // imported without it (that's why "Company" shows blank in PB).
            const patch: Partial<PbContactPayload> = {};
            if (folderId) patch.category_id = folderId;
            if (ownerId) patch.owner_id = ownerId;
            if (l.store) patch.company = l.store;
            if (Object.keys(patch).length) await client.updateContact(resp.id, patch);
            filed++;
          } else {
            added++;
            // Backfill owner_id from the first created contact if we didn't have
            // it (fresh account) so folders work on later runs.
            if (!ownerId) {
              const oid = (resp as Record<string, unknown>).owner_id;
              if (typeof oid === "string" && oid) {
                ownerId = oid;
                setSetting(cfg.ownerSetting, oid);
              }
            }
          }
          if (l.frameCompanyId) tagCompany(l.frameCompanyId, PUSHED_TAG);
        } catch (e) {
          errors++;
          if (errSamples.length < 15) errSamples.push(`${l.store} (${l.phone}) [${job.repKey}]: ${e instanceof Error ? e.message : String(e)}`);
        }
        done++;
        if (done % 10 === 0) setSetting(RUN_KEY, JSON.stringify({ state: "running", total, done, added, filed, errors, errSamples, updatedAt: new Date().toISOString() }));
      }
    }
    setSetting(RUN_KEY, JSON.stringify({ state: "done", total, done, added, filed, errors, errSamples, finishedAt: new Date().toISOString() }));
  })();

  return NextResponse.json({
    ok: true,
    commit: true,
    started: true,
    source: fromCsv ? "csv" : "frame_db",
    counts: { high_christina: highTo.length, low_sandra: lowTo.length },
    total,
    note: "Uploading in background (each rep to their own account) — poll GET for progress.",
  });
}
