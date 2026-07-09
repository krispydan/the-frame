/**
 * Sync PhoneBurner deep links onto the Pipedrive person so the sales
 * team can jump from a Pipedrive record straight into PhoneBurner:
 *   - "PhoneBurner Contact"  → /cm/index#contact/{pb_contact_id}   (view/session)
 *   - "Call in PhoneBurner"   → /app/?source=c2c&phoneId={phoneId}  (one-click dial)
 *
 * pb_contact_id we already store (phoneburner_folder_pushes.pb_contact_id).
 * phoneId is the per-phone id (primary_phone.user_phone_id) — fetched via
 * getContact once and cached in phoneburner_folder_pushes.pb_phone_id.
 */
import { sqlite } from "@/lib/db";
import { pdRequest, updatePerson } from "./pipedrive-client";
import { phoneBurnerClient } from "./phoneburner-client";

const PB_BASE = "https://www.phoneburner.com";

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

interface FieldDef { key: string; name: string }
interface DeeplinkKeys { contact: string | null; call: string | null }

/** Ensure the two Pipedrive PERSON fields exist; cache their keys. */
export async function ensureDeeplinkFieldKeys(): Promise<DeeplinkKeys> {
  const cached = getSetting("pipedrive_pb_deeplink_field_keys");
  if (cached) {
    try {
      const k = JSON.parse(cached) as DeeplinkKeys;
      if ("contact" in k && "call" in k) return k;
    } catch { /* re-provision */ }
  }
  const keys: DeeplinkKeys = { contact: null, call: null };
  try {
    const existing = (await pdRequest<FieldDef[]>("GET", "/personFields")) || [];
    const ensure = async (name: string): Promise<string | null> => {
      const found = existing.find((f) => f.name.trim().toLowerCase() === name.toLowerCase());
      if (found) return found.key;
      const created = await pdRequest<FieldDef>("POST", "/personFields", { name, field_type: "varchar" });
      return created.key ?? null;
    };
    keys.contact = await ensure("PhoneBurner Contact");
    keys.call = await ensure("Call in PhoneBurner");
    setSetting("pipedrive_pb_deeplink_field_keys", JSON.stringify(keys));
  } catch (e) {
    console.warn("[pb-deeplinks] person fields unavailable:", e instanceof Error ? e.message : e);
  }
  return keys;
}

/** PB stores ids as strings; our stamps sometimes carry a trailing ".0". */
function cleanId(v: string | null): string | null {
  if (!v) return null;
  const s = String(v).replace(/\.0$/, "").trim();
  return s || null;
}

/** Latest pushed PB contact id for a company (folder pushes, then campaign_leads). */
function pbContactId(companyId: string): string | null {
  const p = sqlite
    .prepare(
      `SELECT pb_contact_id FROM phoneburner_folder_pushes
        WHERE company_id = ? AND pb_contact_id IS NOT NULL AND TRIM(pb_contact_id) <> ''
        ORDER BY pushed_at DESC LIMIT 1`,
    )
    .get(companyId) as { pb_contact_id: string } | undefined;
  if (p?.pb_contact_id) return cleanId(p.pb_contact_id);
  const cl = sqlite
    .prepare(
      `SELECT phoneburner_contact_id FROM campaign_leads
        WHERE company_id = ? AND phoneburner_contact_id IS NOT NULL AND TRIM(phoneburner_contact_id) <> ''
        LIMIT 1`,
    )
    .get(companyId) as { phoneburner_contact_id: string } | undefined;
  return cl?.phoneburner_contact_id ? cleanId(cl.phoneburner_contact_id) : null;
}

function cachedPhoneId(companyId: string): string | null {
  const r = sqlite
    .prepare(
      `SELECT pb_phone_id FROM phoneburner_folder_pushes
        WHERE company_id = ? AND pb_phone_id IS NOT NULL AND TRIM(pb_phone_id) <> ''
        ORDER BY pushed_at DESC LIMIT 1`,
    )
    .get(companyId) as { pb_phone_id: string } | undefined;
  return r?.pb_phone_id ? cleanId(r.pb_phone_id) : null;
}

function storePhoneId(companyId: string, phoneId: string): void {
  try {
    sqlite
      .prepare(
        `UPDATE phoneburner_folder_pushes SET pb_phone_id = ?
          WHERE company_id = ? AND pb_contact_id IS NOT NULL AND TRIM(pb_contact_id) <> ''`,
      )
      .run(phoneId, companyId);
  } catch (e) {
    console.error("[pb-deeplinks] cache phoneId failed:", e instanceof Error ? e.message : e);
  }
}

/** Pull primary_phone.user_phone_id out of a getContact() response. */
export function extractPhoneId(raw: unknown): string | null {
  const r = raw as { contacts?: { contacts?: Array<Record<string, unknown>> } };
  const c = r?.contacts?.contacts?.[0];
  if (!c) return null;
  const pp = c.primary_phone as { user_phone_id?: unknown } | undefined;
  let pid = pp?.user_phone_id;
  if (pid == null && Array.isArray(c.phones)) {
    pid = (c.phones[0] as { user_phone_id?: unknown } | undefined)?.user_phone_id;
  }
  return pid != null ? String(pid) : null;
}

export interface DeeplinkResult {
  companyId: string;
  ok?: boolean;
  skipped?: string;
  personId?: number | null;
  contactId?: string | null;
  phoneId?: string | null;
  contactUrl?: string | null;
  callUrl?: string | null;
}

/**
 * Write the two PhoneBurner deep links onto a company's Pipedrive person.
 * Idempotent (overwrites the same fields). Fetches + caches phoneId once.
 */
export async function syncPbDeeplinks(companyId: string): Promise<DeeplinkResult> {
  const company = sqlite
    .prepare("SELECT pipedrive_person_id FROM companies WHERE id = ?")
    .get(companyId) as { pipedrive_person_id: number | null } | undefined;
  const personId = company?.pipedrive_person_id ?? null;
  if (!personId) return { companyId, skipped: "no pipedrive person" };

  const contactId = pbContactId(companyId);
  if (!contactId) return { companyId, personId, skipped: "no pb contact id" };

  let phoneId = cachedPhoneId(companyId);
  if (!phoneId) {
    try {
      const raw = await phoneBurnerClient.getContact(contactId);
      phoneId = extractPhoneId(raw);
      if (phoneId) storePhoneId(companyId, phoneId);
    } catch (e) {
      console.warn("[pb-deeplinks] getContact failed:", e instanceof Error ? e.message : e);
    }
  }

  const keys = await ensureDeeplinkFieldKeys();
  const contactUrl = `${PB_BASE}/cm/index#contact/${contactId}`;
  const callUrl = phoneId ? `${PB_BASE}/app/?source=c2c&phoneId=${phoneId}` : null;

  const payload: Record<string, unknown> = {};
  if (keys.contact) payload[keys.contact] = contactUrl;
  if (keys.call && callUrl) payload[keys.call] = callUrl;
  if (Object.keys(payload).length) {
    try {
      await updatePerson(personId, payload);
    } catch (e) {
      return { companyId, personId, contactId, phoneId, skipped: `updatePerson failed: ${e instanceof Error ? e.message : e}` };
    }
  }
  return { companyId, ok: true, personId, contactId, phoneId, contactUrl, callUrl };
}
