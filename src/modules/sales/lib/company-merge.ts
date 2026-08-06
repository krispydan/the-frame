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
    city?: string; state?: string; zip?: string; domain?: string;
    contactCount?: number; crmRichness?: number; shopifyCustomerId?: string | null;
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
      LOWER(TRIM(COALESCE(c.city,''))) AS city,
      UPPER(TRIM(COALESCE(c.state,''))) AS state,
      TRIM(COALESCE(c.zip,'')) AS zip,
      LOWER(TRIM(COALESCE(c.domain,''))) AS domain,
      (SELECT COUNT(*) FROM orders o WHERE o.company_id=c.id AND o.status NOT IN ('cancelled','returned')) AS jaxyOrders,
      (SELECT COALESCE(ROUND(SUM(o.total),2),0) FROM orders o WHERE o.company_id=c.id AND o.status NOT IN ('cancelled','returned')) AS jaxyRevenue,
      (SELECT COUNT(*) FROM ajm_orders a WHERE a.company_id=c.id AND a.cancelled=0) AS ajmOrders,
      (SELECT COALESCE(ROUND(SUM(a.total),2),0) FROM ajm_orders a WHERE a.company_id=c.id AND a.cancelled=0) AS ajmRevenue,
      (SELECT ct.email FROM contacts ct WHERE ct.company_id=c.id AND ct.email IS NOT NULL AND TRIM(ct.email)!='' LIMIT 1) AS email,
      (SELECT COUNT(*) FROM contacts ct WHERE ct.company_id=c.id) AS contactCount,
      c.shopify_customer_id AS shopifyCustomerId,
      -- CRM richness: enrichment, classification and ownership all indicate
      -- this is the real working record rather than an order-created stub.
      (CASE WHEN TRIM(COALESCE(c.enrichment_text,''))!='' THEN 1 ELSE 0 END
       + CASE WHEN TRIM(COALESCE(c.notes,''))!='' THEN 1 ELSE 0 END
       + CASE WHEN c.icp_tier IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN c.owner_id IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN c.segment_id IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN TRIM(COALESCE(c.website,''))!='' THEN 1 ELSE 0 END) AS crmRichness
    FROM companies c
  `).all() as DuplicateGroup["companies"];
  return rows;
}

/**
 * Deterministic keeper: the RICHEST CRM record, not the one that happens to
 * carry orders.
 *
 * Ranking by order count kept the thin stub the order webhook auto-created
 * and deleted the enriched CRM record (contacts, notes, ICP tier, owner,
 * segment). Orders and AJM history are repointed either way, so they must not
 * drive the choice — the record a human has actually worked should survive.
 * Ties fall back to more contacts, then the older record.
 */
function pickKeeper(cs: DuplicateGroup["companies"]): string {
  return [...cs].sort((a, b) =>
    (b.crmRichness ?? 0) - (a.crmRichness ?? 0) ||
    (b.contactCount ?? 0) - (a.contactCount ?? 0) ||
    b.ajmRevenue - a.ajmRevenue ||
    String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")),
  )[0].id;
}

/**
 * Fields worth rescuing from a loser before it is deleted. shopify_customer_id
 * matters most: if the record holding it is dropped, the order webhook loses
 * its strongest match key and simply creates the duplicate again on the next
 * order. Only ever fills a blank on the keeper — never overwrites.
 */
const BACKFILL_COLUMNS = [
  "shopify_customer_id", "domain", "website", "address", "city", "state", "zip",
  "country", "latitude", "longitude", "geocoded_at", "notes", "enrichment_text",
  "icp_tier", "owner_id", "segment_id",
] as const;

function backfillKeeperFields(keepId: string, loserId: string): string[] {
  const filled: string[] = [];
  for (const col of BACKFILL_COLUMNS) {
    if (!hasColumn("companies", col)) continue;
    try {
      const r = sqlite.prepare(
        `UPDATE companies SET ${col} = (SELECT ${col} FROM companies WHERE id = ?)
         WHERE id = ? AND (${col} IS NULL OR TRIM(CAST(${col} AS TEXT)) = '')
           AND (SELECT ${col} FROM companies WHERE id = ?) IS NOT NULL`,
      ).run(loserId, keepId, loserId);
      if (r.changes > 0) filled.push(col);
    } catch { /* column type mismatch — skip */ }
  }
  return filled;
}

/** Free/consumer mail providers — a shared address here proves nothing. */
const FREE_DOMAIN = /@(gmail|hotmail|outlook|yahoo|icloud|aol|live|msn|me|proton(mail)?|gmx|mail)\./i;

/**
 * Above this many companies, a shared contact address is a shared or
 * placeholder inbox (a rep, an agency, an import default) rather than evidence
 * two records are the same business. Set low deliberately: a genuine duplicate
 * pair is 2–3 records, and a chain's store locations are separate businesses
 * for our purposes anyway. Over the cap the group goes to human review.
 */
const SHARED_EMAIL_MAX = 6;

export interface ReviewGroup {
  key: string; reason: string; companies: DuplicateGroup["companies"];
}
/** Name collisions we refused to merge; read via getNeedsReview(). */
let needsReview: ReviewGroup[] = [];
export function getNeedsReview(): ReviewGroup[] { return needsReview; }

export function findDuplicateCompanies(opts?: { minEvidence?: "name" | "email" | "both" }): DuplicateGroup[] {
  const all = companyStats();
  needsReview = [];
  const groups = new Map<string, { reason: "name" | "email"; items: DuplicateGroup["companies"] }>();

  // 1. Identical normalized name — but a matching name ALONE is not enough.
  //
  // Shop names repeat constantly across the country: production held 11
  // separate "Revival" records, 7 "Magpie", 7 "Frock". Those are different
  // businesses in different cities, and merging them would corrupt the data
  // far worse than the split it fixes. So a name group is only accepted when
  // the members also agree on a LOCATION or DOMAIN signal:
  //   same zip, or same city+state, or same (non-free) email domain.
  // Members that share a name but nothing else are left alone and surfaced
  // separately as `needsReview`, never merged automatically.
  const byName = new Map<string, DuplicateGroup["companies"]>();
  for (const c of all) {
    const k = normalizeCompanyName(c.name);
    if (k.length < 3) continue;
    (byName.get(k) ?? byName.set(k, []).get(k)!).push(c);
  }
  const domainOf = (c: DuplicateGroup["companies"][number]) => {
    const d = (c.domain ?? "").trim();
    if (d) return d;
    const e = (c.email ?? "").split("@")[1]?.toLowerCase() ?? "";
    return FREE_DOMAIN.test(`@${e}`) ? "" : e;
  };
  for (const [k, items] of byName) {
    if (items.length < 2) continue;
    // Sub-group by corroborating signal; only sub-groups of 2+ are duplicates.
    const buckets = new Map<string, DuplicateGroup["companies"]>();
    for (const c of items) {
      const zip = (c.zip ?? "").slice(0, 5);
      const dom = domainOf(c);
      const sig = dom ? `d:${dom}` : zip ? `z:${zip}` : (c.city && c.state) ? `c:${c.city}|${c.state}` : "";
      if (!sig) continue; // no corroboration available → cannot confirm
      (buckets.get(sig) ?? buckets.set(sig, []).get(sig)!).push(c);
    }
    for (const [sig, bucket] of buckets) {
      if (bucket.length > 1) groups.set(`name:${k}|${sig}`, { reason: "name", items: bucket });
    }
    // Name matches we deliberately did NOT merge, for human review.
    const mergedIds = new Set([...buckets.values()].filter((b) => b.length > 1).flat().map((c) => c.id));
    const leftovers = items.filter((c) => !mergedIds.has(c.id));
    if (leftovers.length > 1) {
      needsReview.push({
        key: `name:${k}`,
        reason: "same name, no matching location or domain — could be different businesses",
        companies: leftovers,
      });
    }
  }

  // 2. Shared contact email (catches renamed/abbreviated records).
  //
  // A shared address is much weaker evidence than it looks. Production has
  // addresses sitting on hundreds of unrelated companies — a sales rep's own
  // address, an agency inbox, or a placeholder written in during an import.
  // The first scan produced one "email" group keyed on a single address that
  // pulled 500+ unrelated retailers (Martin Patrick 3, Ventura Swimwear, bike
  // shops, med spas) under one keeper. Merging that would have been
  // catastrophic and effectively unpickable afterwards.
  //
  // So an email group must clear BOTH gates:
  //   a) the address is not shared by an implausible number of companies —
  //      past SHARED_EMAIL_MAX it is a shared/placeholder inbox, not identity;
  //   b) the members corroborate each other the same way name groups must,
  //      by normalized name or by location (zip, or city+state).
  // Anything that fails is surfaced as needsReview, never auto-merged.
  const byEmail = new Map<string, DuplicateGroup["companies"]>();
  for (const c of all) {
    const e = (c.email ?? "").trim().toLowerCase();
    if (!e || !e.includes("@")) continue;
    (byEmail.get(e) ?? byEmail.set(e, []).get(e)!).push(c);
  }
  for (const [e, items] of byEmail) {
    if (items.length < 2) continue;

    // (a) Shared/placeholder inbox — no identity signal at all.
    if (items.length > SHARED_EMAIL_MAX) {
      needsReview.push({
        key: `email:${e}`,
        reason: `${items.length} companies share this address — shared or placeholder inbox, not proof of identity`,
        companies: items.slice(0, 25),
      });
      continue;
    }

    // (b) Corroborate: same normalized name, or failing that, same location.
    //     Name is tried first because it is the stronger signal, but a record
    //     that was renamed ("Bygones" → "Bygones Vintage Emporium") only ever
    //     matches on location, so name-singletons fall through to a second
    //     pass rather than being dropped.
    const buckets = new Map<string, DuplicateGroup["companies"]>();
    const byNameSig = new Map<string, DuplicateGroup["companies"]>();
    for (const c of items) {
      const nameKey = normalizeCompanyName(c.name);
      if (nameKey.length < 3) continue;
      (byNameSig.get(nameKey) ?? byNameSig.set(nameKey, []).get(nameKey)!).push(c);
    }
    const unnamed: DuplicateGroup["companies"] = [];
    for (const [nameKey, bucket] of byNameSig) {
      if (bucket.length > 1) buckets.set(`n:${nameKey}`, bucket);
      else unnamed.push(...bucket);
    }
    for (const c of items.filter((c) => normalizeCompanyName(c.name).length < 3).concat(unnamed)) {
      const zip = (c.zip ?? "").slice(0, 5);
      const sig = zip ? `z:${zip}` : (c.city && c.state) ? `c:${c.city}|${c.state}` : "";
      if (!sig) continue;
      (buckets.get(sig) ?? buckets.set(sig, []).get(sig)!).push(c);
    }
    for (const [sig, bucket] of buckets) {
      if (bucket.length < 2) continue;
      const key = `email:${e}|${sig}`;
      if (!groups.has(key)) groups.set(key, { reason: "email", items: bucket });
    }
    const mergedIds = new Set([...buckets.values()].filter((b) => b.length > 1).flat().map((c) => c.id));
    const leftovers = items.filter((c) => !mergedIds.has(c.id));
    if (leftovers.length > 1) {
      needsReview.push({
        key: `email:${e}`,
        reason: "shared contact address but different names and locations — likely different businesses",
        companies: leftovers,
      });
    }
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
  /** Blank keeper fields filled from a loser before deletion. */
  fieldsBackfilled: string[];
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
  const fieldsBackfilled: string[] = [];
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

        // Rescue anything the keeper is missing BEFORE the loser is gone —
        // above all shopify_customer_id, or the webhook recreates this dupe.
        if (apply) {
          const filled = backfillKeeperFields(g.keepId, loser.id);
          if (filled.length) fieldsBackfilled.push(`${keep.name}: ${filled.join(",")}`);
          sqlite.prepare("DELETE FROM companies WHERE id = ?").run(loser.id);
        }
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
    fieldsBackfilled: fieldsBackfilled.slice(0, 100),
    details: details.slice(0, 100),
  };
}
