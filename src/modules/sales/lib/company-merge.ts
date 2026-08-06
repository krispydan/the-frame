/**
 * Duplicate-company detection and merging.
 *
 * The same retailer routinely ends up as several company records: the
 * wholesale order webhook auto-creates a company when it can't match an
 * existing one, and a single space, a capitalisation, or a different contact
 * email is enough to miss. Real examples found Aug 2026:
 *   "Grey56 Leather" (AJM history) vs "Grey 56 Leather Inc" (Jaxy orders)
 *   "Alter" vs "ALTER"
 *   two records both literally named "Show Pony"
 *
 * The damage is quiet but broad: revenue splits across records, so LTV,
 * health scores, the AJM capture rate and the reader targeting all
 * under-report, and an account that HAS bought shows as never converted.
 *
 * Safety model:
 *   - findDuplicateCompanies() only groups on strong evidence — an identical
 *     normalized name, or a shared contact email. It never merges on
 *     similarity alone.
 *   - mergeCompanies() defaults to a DRY RUN and reports what it would move.
 *   - The keeper is chosen deterministically: most orders, then most AJM
 *     history, then oldest record — so re-running is stable.
 */
import { sqlite } from "@/lib/db";

/** Lowercase, strip punctuation/legal suffixes, collapse spaces. */
export function normalizeCompanyName(raw: string | null | undefined): string {
  return (raw ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(inc|llc|ltd|co|corp|company|the|shop|store)\b/g, " ")
    .replace(/\s+/g, "")
    .trim();
}

/** Tables holding a company_id that must follow a merge. */
const COMPANY_REF_TABLES = [
  "orders", "ajm_orders", "contacts", "company_phones", "stores",
  "deals", "deal_activities", "campaign_leads", "company_brand_links",
  "prospect_llm_classifications", "phoneburner_call_log", "gmaps_listings",
  "apify_match_log", "phoneburner_folder_pushes", "pb_call_queue",
  "outreach_messages", "lead_conversion_alerts", "pipedrive_deals",
  "pipedrive_webhook_events", "meta_leads", "meta_capi_events",
  "company_faire_accounts",
] as const;

/** Tables with a UNIQUE constraint on company_id — merge, don't just repoint. */
const UNIQUE_PER_COMPANY = new Set(["customer_accounts", "gmaps_listings"]);

function tableExists(name: string): boolean {
  return !!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function hasColumn(table: string, col: string): boolean {
  try {
    return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === col);
  } catch { return false; }
}

export interface DuplicateGroup {
  key: string;
  reason: "name" | "email";
  companies: Array<{
    id: string; name: string; createdAt: string | null;
    jaxyOrders: number; jaxyRevenue: number;
    ajmOrders: number; ajmRevenue: number;
    email: string | null;
  }>;
  keepId: string;
  /** Revenue currently hidden because it sits on a non-keeper record. */
  splitJaxyRevenue: number;
  splitAjmRevenue: number;
}

/** Per-company stats used for ranking and reporting. */
function companyStats() {
  const rows = sqlite.prepare(`
    SELECT c.id, c.name, c.created_at AS createdAt,
      (SELECT COUNT(*) FROM orders o WHERE o.company_id=c.id AND o.status NOT IN ('cancelled','returned')) AS jaxyOrders,
      (SELECT COALESCE(ROUND(SUM(o.total),2),0) FROM orders o WHERE o.company_id=c.id AND o.status NOT IN ('cancelled','returned')) AS jaxyRevenue,
      (SELECT COUNT(*) FROM ajm_orders a WHERE a.company_id=c.id AND a.cancelled=0) AS ajmOrders,
      (SELECT COALESCE(ROUND(SUM(a.total),2),0) FROM ajm_orders a WHERE a.company_id=c.id AND a.cancelled=0) AS ajmRevenue,
      (SELECT ct.email FROM contacts ct WHERE ct.company_id=c.id AND ct.email IS NOT NULL AND TRIM(ct.email)!='' LIMIT 1) AS email
    FROM companies c
  `).all() as DuplicateGroup["companies"];
  return rows;
}

/** Deterministic keeper: most Jaxy orders → most AJM history → oldest. */
function pickKeeper(cs: DuplicateGroup["companies"]): string {
  return [...cs].sort((a, b) =>
    b.jaxyOrders - a.jaxyOrders ||
    b.ajmRevenue - a.ajmRevenue ||
    String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")),
  )[0].id;
}

export function findDuplicateCompanies(opts?: { minEvidence?: "name" | "email" | "both" }): DuplicateGroup[] {
  const all = companyStats();
  const groups = new Map<string, { reason: "name" | "email"; items: DuplicateGroup["companies"] }>();

  // 1. Identical normalized name
  const byName = new Map<string, DuplicateGroup["companies"]>();
  for (const c of all) {
    const k = normalizeCompanyName(c.name);
    if (k.length < 3) continue;
    (byName.get(k) ?? byName.set(k, []).get(k)!).push(c);
  }
  for (const [k, items] of byName) {
    if (items.length > 1) groups.set(`name:${k}`, { reason: "name", items });
  }

  // 2. Shared contact email (catches renamed/abbreviated records). Free-mail
  //    addresses are excluded — a shared gmail says nothing about identity.
  const FREE = /@(gmail|hotmail|outlook|yahoo|icloud|aol|live|msn|me|proton(mail)?|gmx|mail)\./i;
  const byEmail = new Map<string, DuplicateGroup["companies"]>();
  for (const c of all) {
    const e = (c.email ?? "").trim().toLowerCase();
    if (!e || !e.includes("@")) continue;
    (byEmail.get(e) ?? byEmail.set(e, []).get(e)!).push(c);
  }
  for (const [e, items] of byEmail) {
    if (items.length < 2) continue;
    // A shared free-mail address only counts when the names also agree.
    if (FREE.test(e)) {
      const names = new Set(items.map((i) => normalizeCompanyName(i.name)));
      if (names.size > 1) continue;
    }
    const key = `email:${e}`;
    if (!groups.has(key)) groups.set(key, { reason: "email", items });
  }

  const out: DuplicateGroup[] = [];
  const seen = new Set<string>();
  for (const [key, { reason, items }] of groups) {
    // Don't emit a group whose members are already covered by another group.
    const ids = items.map((i) => i.id).sort().join("|");
    if (seen.has(ids)) continue;
    seen.add(ids);
    if (opts?.minEvidence === "email" && reason !== "email") continue;
    if (opts?.minEvidence === "name" && reason !== "name") continue;
    const keepId = pickKeeper(items);
    out.push({
      key, reason, companies: items, keepId,
      splitJaxyRevenue: Math.round(items.filter((i) => i.id !== keepId).reduce((s, i) => s + i.jaxyRevenue, 0) * 100) / 100,
      splitAjmRevenue: Math.round(items.filter((i) => i.id !== keepId).reduce((s, i) => s + i.ajmRevenue, 0) * 100) / 100,
    });
  }
  // Biggest hidden revenue first — that's what's worth fixing.
  return out.sort((a, b) => (b.splitJaxyRevenue + b.splitAjmRevenue) - (a.splitJaxyRevenue + a.splitAjmRevenue));
}

export interface MergeResult {
  dryRun: boolean;
  groupsProcessed: number;
  companiesRemoved: number;
  rowsRepointed: Record<string, number>;
  recoveredJaxyRevenue: number;
  recoveredAjmRevenue: number;
  details: Array<{ keep: string; keepName: string; merged: Array<{ id: string; name: string }> }>;
}

/**
 * Merge duplicate companies onto their keeper.
 * Dry run by default — pass { apply: true } to write.
 */
export function mergeCompanies(opts?: {
  apply?: boolean;
  /** Restrict to specific group keys from findDuplicateCompanies(). */
  keys?: string[];
  /** Only merge groups hiding at least this much revenue. */
  minRevenue?: number;
  limit?: number;
}): MergeResult {
  const apply = opts?.apply === true;
  let groups = findDuplicateCompanies();
  if (opts?.keys?.length) groups = groups.filter((g) => opts.keys!.includes(g.key));
  if (opts?.minRevenue) {
    groups = groups.filter((g) => g.splitJaxyRevenue + g.splitAjmRevenue >= opts.minRevenue!);
  }
  groups = groups.slice(0, opts?.limit ?? 500);

  const rowsRepointed: Record<string, number> = {};
  const details: MergeResult["details"] = [];
  let companiesRemoved = 0, recoveredJaxy = 0, recoveredAjm = 0;

  const run = () => {
    for (const g of groups) {
      const losers = g.companies.filter((c) => c.id !== g.keepId);
      if (!losers.length) continue;
      const keep = g.companies.find((c) => c.id === g.keepId)!;

      for (const loser of losers) {
        for (const t of COMPANY_REF_TABLES) {
          if (!tableExists(t) || !hasColumn(t, "company_id")) continue;
          if (apply) {
            const r = sqlite.prepare(`UPDATE ${t} SET company_id = ? WHERE company_id = ?`).run(g.keepId, loser.id);
            rowsRepointed[t] = (rowsRepointed[t] ?? 0) + r.changes;
          } else {
            const c = sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE company_id = ?`).get(loser.id) as { n: number };
            rowsRepointed[t] = (rowsRepointed[t] ?? 0) + c.n;
          }
        }

        // Unique-per-company tables: drop the loser's row rather than
        // repointing it (a repoint would violate the unique index).
        for (const t of UNIQUE_PER_COMPANY) {
          if (!tableExists(t)) continue;
          if (apply) {
            const r = sqlite.prepare(`DELETE FROM ${t} WHERE company_id = ?`).run(loser.id);
            rowsRepointed[`${t} (removed)`] = (rowsRepointed[`${t} (removed)`] ?? 0) + r.changes;
          }
        }

        if (apply) sqlite.prepare("DELETE FROM companies WHERE id = ?").run(loser.id);
        companiesRemoved++;
        recoveredJaxy += loser.jaxyRevenue;
        recoveredAjm += loser.ajmRevenue;
      }

      details.push({
        keep: g.keepId, keepName: keep.name,
        merged: losers.map((l) => ({ id: l.id, name: l.name })),
      });
    }
  };

  if (apply) sqlite.transaction(run)(); else run();

  // Rebuild customer accounts for the keepers so LTV/health reflect the union.
  if (apply) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { ensureCustomerAccount } = require("@/modules/customers/lib/account-sync");
      for (const d of details) {
        const hasOrders = sqlite.prepare(
          "SELECT 1 FROM orders WHERE company_id = ? LIMIT 1",
        ).get(d.keep);
        if (hasOrders) ensureCustomerAccount(d.keep);
      }
    } catch (e) {
      console.error("[company-merge] account recompute failed:", e);
    }
  }

  return {
    dryRun: !apply,
    groupsProcessed: groups.length,
    companiesRemoved,
    rowsRepointed,
    recoveredJaxyRevenue: Math.round(recoveredJaxy * 100) / 100,
    recoveredAjmRevenue: Math.round(recoveredAjm * 100) / 100,
    details: details.slice(0, 100),
  };
}
