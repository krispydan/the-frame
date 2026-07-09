/**
 * Pipedrive call-activities → PhoneBurner per-rep call folders (Model A).
 *
 * Each run: for each rep, pull their open Pipedrive "call" activities due
 * through today, ensure a PhoneBurner contact exists (create if missing),
 * MOVE it into the rep's daily folder, and stamp the Pipedrive activity id
 * onto the contact so the reverse loop can close it. Contacts whose
 * activity is no longer in the target set are moved back to their original
 * folder and dropped from the queue (so a completed activity leaves the
 * call list).
 *
 * Rep folders (shared PB account, separated by folder):
 *   Christina (pd user 25572381) → 66251717
 *   Sandra    (pd user 25572392) → 66251718
 */
import { sqlite } from "@/lib/db";
import {
  listActivities,
  type PdActivity,
} from "./pipedrive-client";
import { phoneBurnerClient } from "./phoneburner-client";
import { formatToPbPhone } from "./phone-utils";
import { postSlack, type SlackBlock } from "@/modules/integrations/lib/slack/client";

const REP_FOLDERS: Record<string, { folder: string; name: string }> = {
  "25572381": { folder: "66251717", name: "Christina" },
  "25572392": { folder: "66251718", name: "Sandra" },
};
const ACTIVITY_FIELD = "Pipedrive Activity ID";

function getSetting(key: string): string | null {
  const r = sqlite.prepare("SELECT value FROM settings WHERE key = ? LIMIT 1").get(key) as
    | { value: string | null } | undefined;
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

async function resolveOwnerId(): Promise<string> {
  const cached = getSetting("phoneburner_owner_id");
  if (cached) return cached;
  const d = await phoneBurnerClient.discoverOwnerId();
  if (!d) throw new Error("phoneburner owner_id unavailable");
  setSetting("phoneburner_owner_id", d);
  return d;
}

/** Ensure the neutral "pool" folder that parked/new contacts live in when
 *  not actively on a rep's call list. */
async function ensurePoolFolder(ownerId: string): Promise<string> {
  const cached = getSetting("pipedrive_pb_pool_folder");
  if (cached) return cached;
  const f = await phoneBurnerClient.createFolder({
    folder_name: "Pipedrive Sequence Pool",
    owner_id: ownerId,
  });
  const id = String((f as { id?: unknown }).id ?? "");
  if (!id) throw new Error("pool folder create returned no id");
  setSetting("pipedrive_pb_pool_folder", id);
  return id;
}

function ownerField(a: PdActivity): string | null {
  const v = (a.owner_id ?? a.user_id ?? a.assigned_to_user_id) as unknown;
  if (typeof v === "number") return String(v);
  if (v && typeof v === "object" && "id" in (v as object)) return String((v as { id: number }).id);
  return v != null ? String(v) : null;
}
function personId(a: PdActivity): number | null {
  const v = a.person_id as unknown;
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && "value" in (v as object)) return (v as { value: number }).value;
  return null;
}

function resolveCompanyByPerson(pid: number): { id: string; name: string | null } | undefined {
  return sqlite
    .prepare("SELECT id, name FROM companies WHERE pipedrive_person_id = ? LIMIT 1")
    .get(pid) as { id: string; name: string | null } | undefined;
}

const REP_FOLDER_IDS = new Set(Object.values(REP_FOLDERS).map((r) => r.folder));

/** The contact's home folder = latest non-rep, non-pool push folder
 *  (falls back to the pool folder). */
function homeFolder(companyId: string, poolId: string): string {
  const rows = sqlite
    .prepare(
      `SELECT folder_id FROM phoneburner_folder_pushes
        WHERE company_id = ? ORDER BY pushed_at DESC`,
    )
    .all(companyId) as Array<{ folder_id: string }>;
  for (const r of rows) {
    if (!REP_FOLDER_IDS.has(r.folder_id) && r.folder_id !== poolId) return r.folder_id;
  }
  return poolId;
}

function latestPbContactId(companyId: string): string | null {
  const r = sqlite
    .prepare(
      `SELECT pb_contact_id FROM phoneburner_folder_pushes
        WHERE company_id = ? AND pb_contact_id IS NOT NULL AND TRIM(pb_contact_id) <> ''
        ORDER BY pushed_at DESC LIMIT 1`,
    )
    .get(companyId) as { pb_contact_id: string } | undefined;
  return r?.pb_contact_id ? String(r.pb_contact_id).replace(/\.0$/, "") : null;
}

function companyPhone(companyId: string): string | null {
  const r = sqlite
    .prepare(
      `SELECT phone FROM company_phones WHERE company_id = ?
        ORDER BY is_primary DESC, created_at ASC LIMIT 1`,
    )
    .get(companyId) as { phone: string | null } | undefined;
  return r?.phone ?? null;
}
function companyRow(companyId: string) {
  return sqlite
    .prepare("SELECT id, name, website, domain FROM companies WHERE id = ?")
    .get(companyId) as { id: string; name: string | null; website: string | null; domain: string | null } | undefined;
}
function primaryEmail(companyId: string): string | null {
  const r = sqlite
    .prepare(
      `SELECT email FROM contacts WHERE company_id = ? AND TRIM(COALESCE(email,'')) <> ''
        ORDER BY is_primary DESC, created_at ASC LIMIT 1`,
    )
    .get(companyId) as { email: string | null } | undefined;
  return r?.email ?? null;
}

interface EnsureResult { contactId: string; originalFolder: string; created: boolean }

/** Return the company's PB contact id, creating one (in the pool folder)
 *  if none exists. Returns null when we can't (no phone). */
async function ensurePbContact(companyId: string, ownerId: string, poolId: string): Promise<EnsureResult | null> {
  const existing = latestPbContactId(companyId);
  if (existing) return { contactId: existing, originalFolder: homeFolder(companyId, poolId), created: false };

  const co = companyRow(companyId);
  const phone = formatToPbPhone(companyPhone(companyId));
  if (!co || !phone) return null;
  const created = await phoneBurnerClient.createContact({
    owner_id: ownerId,
    first_name: (co.name || "Contact").slice(0, 64),
    last_name: "",
    email: primaryEmail(companyId) || undefined,
    phone,
    category_id: poolId,
    user_id: companyId,
    custom_fields: [
      { name: "Company ID", type: "text", value: companyId },
      { name: "Company Name", type: "text", value: co.name || "" },
      { name: "Website", type: "url", value: co.website || "" },
      { name: "Domain", type: "text", value: co.domain || "" },
    ].filter((f) => f.value),
    on_duplicate: "update",
  });
  const contactId = String(created.id || "").replace(/\.0$/, "");
  if (!contactId) return null;
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO phoneburner_folder_pushes
         (id, company_id, folder_id, pb_contact_id, phone_pushed, pushed_at, error)
       VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, datetime('now'), NULL)`,
    )
    .run(companyId, poolId, contactId, phone);
  return { contactId, originalFolder: poolId, created: true };
}

async function moveContact(contactId: string, folderId: string, activityId?: string): Promise<void> {
  const patch: Record<string, unknown> = { category_id: folderId };
  if (activityId) patch.custom_fields = [{ name: ACTIVITY_FIELD, type: "text", value: activityId }];
  await phoneBurnerClient.updateContact(contactId, patch);
}

export interface RepSyncResult {
  rep: string;
  folder: string;
  activities: number;
  queued: number;
  created: number;
  removed: number;
  unresolved_company: number;
  no_phone: number;
  errors: string[];
}

/** Build/refresh each rep's daily call folder from their open Pipedrive
 *  call activities. dryRun = compute only, no PB writes. */
export async function buildDailyCallFolders(opts: { dryRun?: boolean; through?: string } = {}): Promise<{
  ok: boolean;
  dry_run: boolean;
  through: string;
  reps: RepSyncResult[];
}> {
  const dryRun = opts.dryRun === true;
  const through = opts.through || new Date().toISOString().slice(0, 10);
  const ownerId = await resolveOwnerId();
  const poolId = dryRun ? (getSetting("pipedrive_pb_pool_folder") || "POOL") : await ensurePoolFolder(ownerId);

  const reps: RepSyncResult[] = [];
  for (const [userId, meta] of Object.entries(REP_FOLDERS)) {
    const res: RepSyncResult = {
      rep: meta.name, folder: meta.folder, activities: 0, queued: 0, created: 0,
      removed: 0, unresolved_company: 0, no_phone: 0, errors: [],
    };
    let acts: PdActivity[] = [];
    try {
      acts = await listActivities({ user_id: Number(userId), done: 0, type: "call", end_date: through, limit: 500 });
    } catch (e) {
      res.errors.push(`listActivities: ${e instanceof Error ? e.message : e}`);
      reps.push(res);
      continue;
    }
    res.activities = acts.length;

    const target = new Map<string, { activityId: string; companyId: string; due?: string; originalFolder: string }>();
    for (const a of acts) {
      const pid = personId(a);
      const co = pid ? resolveCompanyByPerson(pid) : undefined;
      if (!co) { res.unresolved_company++; continue; }
      try {
        const ec = dryRun
          ? (latestPbContactId(co.id) ? { contactId: latestPbContactId(co.id)!, originalFolder: homeFolder(co.id, poolId), created: !latestPbContactId(co.id) } : (companyPhone(co.id) ? { contactId: "(new)", originalFolder: poolId, created: true } : null))
          : await ensurePbContact(co.id, ownerId, poolId);
        if (!ec) { res.no_phone++; continue; }
        if (ec.created) res.created++;
        target.set(ec.contactId, { activityId: String(a.id), companyId: co.id, due: a.due_date, originalFolder: ec.originalFolder });
      } catch (e) {
        res.errors.push(`${co.name}: ${e instanceof Error ? e.message : e}`);
      }
    }
    res.queued = target.size;

    if (!dryRun) {
      // Add / refresh
      const upsert = sqlite.prepare(
        `INSERT INTO pb_call_queue (id, company_id, pb_contact_id, rep_user_id, folder_id, activity_id, activity_due, original_folder_id, added_at, updated_at)
         VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(pb_contact_id, folder_id) DO UPDATE SET activity_id=excluded.activity_id, activity_due=excluded.activity_due, updated_at=datetime('now')`,
      );
      for (const [contactId, t] of target) {
        try {
          await moveContact(contactId, meta.folder, t.activityId);
          upsert.run(t.companyId, contactId, userId, meta.folder, t.activityId, t.due ?? null, t.originalFolder);
        } catch (e) {
          res.errors.push(`move ${contactId}: ${e instanceof Error ? e.message : e}`);
        }
      }
      // Remove stale (in folder queue but no longer targeted) → restore home folder.
      const current = sqlite
        .prepare("SELECT id, pb_contact_id, original_folder_id FROM pb_call_queue WHERE folder_id = ?")
        .all(meta.folder) as Array<{ id: string; pb_contact_id: string; original_folder_id: string | null }>;
      const del = sqlite.prepare("DELETE FROM pb_call_queue WHERE id = ?");
      for (const c of current) {
        if (target.has(c.pb_contact_id)) continue;
        try {
          await moveContact(c.pb_contact_id, c.original_folder_id || poolId);
          del.run(c.id);
          res.removed++;
        } catch (e) {
          res.errors.push(`remove ${c.pb_contact_id}: ${e instanceof Error ? e.message : e}`);
        }
      }
    }
    reps.push(res);
  }

  // Daily Slack digest to #sales-leads — one line per rep.
  if (!dryRun) {
    try { await postCallListDigest(through, reps); } catch (e) {
      console.error("[pipedrive-call-sync] slack digest failed:", e instanceof Error ? e.message : e);
    }
  }

  return { ok: true, dry_run: dryRun, through, reps };
}

async function postCallListDigest(through: string, reps: RepSyncResult[]): Promise<void> {
  const lines = reps.map((r) => {
    const extras: string[] = [];
    if (r.created) extras.push(`${r.created} new`);
    if (r.removed) extras.push(`${r.removed} cleared`);
    if (r.no_phone) extras.push(`${r.no_phone} no phone`);
    const suffix = extras.length ? ` _(${extras.join(", ")})_` : "";
    return `• *${r.rep}* — *${r.queued}* call${r.queued === 1 ? "" : "s"} queued${suffix}`;
  });
  const total = reps.reduce((s, r) => s + r.queued, 0);
  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `📞 *Daily follow-up call lists* — ${through}\n${lines.join("\n")}` },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `${total} total queued · <https://www.phoneburner.com|Open PhoneBurner> and dial your folder` }],
    },
  ];
  await postSlack({
    topic: "sales.phoneburner_interested",
    text: `📞 Daily call lists — ${reps.map((r) => `${r.rep} ${r.queued}`).join(", ")}`,
    blocks,
  });
}
