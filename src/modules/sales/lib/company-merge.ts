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
 * segment), so CRM richness comes first and stays first.
 *
 * When richness ties, the record carrying the most trading history wins.
 * Contact count used to break that tie and it chose badly: a stub whose only
 * contact was the placeholder "name@email.com" outranked the Show Pony record
 * holding $85,976 of AJM history, purely for having a contact row at all.
 * Orders repoint either way, but keeping the record most of the history
 * already hangs off means the fewest rows move and the surviving id is the one
 * links point at. Contacts then age break any remaining tie.
 */
function pickKeeper(cs: DuplicateGroup["companies"]): string {
  const history = (c: DuplicateGroup["companies"][number]) => c.ajmRevenue + c.jaxyRevenue;
  return [...cs].sort((a, b) =>
    (b.crmRichness ?? 0) - (a.crmRichness ?? 0) ||
    history(b) - history(a) ||
    (b.contactCount ?? 0) - (a.contactCount ?? 0) ||
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

/**
 * Free/consumer mail providers AND consumer ISP domains — a shared address
 * here proves nothing, and treating one as a company domain actively hurt:
 * "Front & Company" was kept apart from "Front and Company" (same name, same
 * city) because one contact used a personal telus.net address, which counted
 * as a different company domain.
 */
const FREE_DOMAIN = /@(gmail|hotmail|outlook|yahoo|icloud|aol|live|msn|me|proton(mail)?|gmx|mail|comcast|verizon|telus|shaw|rogers|sbcglobal|bellsouth|cox|charter|earthlink|att|sympatico|btinternet|orange|free|web|t-online)\./i;

/**
 * Above this many companies, a shared contact address is a shared or
 * placeholder inbox (a rep, an agency, an import default) rather than evidence
 * two records are the same business. Set low deliberately: a genuine duplicate
 * pair is 2–3 records, and a chain's store locations are separate businesses
 * for our purposes anyway. Over the cap the group goes to human review.
 *
 * Production really does contain the literal placeholder "name@email.com" on
 * eight unrelated companies.
 */
const SHARED_EMAIL_MAX = 6;

/**
 * US/Canada state and province names → their two-letter code.
 *
 * The same retailer is stored as "seattle, WA" on one record and
 * "seattle, WASHINGTON" on the other, depending on which importer created it.
 * Comparing the raw strings made two records of the same shop look like two
 * shops in different places, which blocked genuine merges (Show Pony, Daytrip
 * Society, Alter Ego Fashions all failed on exactly this).
 */
const STATE_CODE: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", "district of columbia": "DC",
  florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL",
  indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI",
  minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT",
  nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC",
  "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "puerto rico": "PR", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX",
  utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
  "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
  alberta: "AB", "british columbia": "BC", manitoba: "MB",
  "new brunswick": "NB", "newfoundland and labrador": "NL", "nova scotia": "NS",
  ontario: "ON", "prince edward island": "PE", quebec: "QC",
  saskatchewan: "SK",
};

/**
 * Largest cluster we will merge without a human looking. Signals link
 * transitively, so an unlucky chain could otherwise sweep up a whole city's
 * worth of same-named shops.
 */
const MAX_AUTO_CLUSTER = 8;

export function normalizeState(raw: string | null | undefined): string {
  const s = (raw ?? "").trim().toLowerCase().replace(/\./g, "").replace(/\s+/g, " ");
  if (!s) return "";
  return STATE_CODE[s] ?? (s.length === 2 ? s.toUpperCase() : s.toUpperCase());
}

/** City comparison is punctuation- and spacing-insensitive ("st." vs "saint"). */
function normalizeCity(raw: string | null | undefined): string {
  return (raw ?? "").trim().toLowerCase()
    .replace(/^st\.?\s+/, "saint ")
    .replace(/^ft\.?\s+/, "fort ")
    .replace(/[^a-z0-9]+/g, "");
}

type Company = DuplicateGroup["companies"][number];

/** The company's own domain, else its contact's — blank for free/ISP mail. */
function domainOf(c: Company): string {
  const d = (c.domain ?? "").trim().toLowerCase();
  if (d) return d;
  const e = (c.email ?? "").split("@")[1]?.toLowerCase() ?? "";
  return !e || FREE_DOMAIN.test(`@${e}`) ? "" : e;
}

/**
 * Every corroborating signal a record offers. Two records are the same
 * business if they agree on ANY of these — not on one chosen by priority.
 *
 * That distinction is not academic. Picking a single signal per record split
 * "Front & Company" from "Front and Company": both sit in Vancouver BC, but
 * one contact used a personal telus.net address, so a domain signal was
 * chosen for one and a city signal for the other, and they never compared.
 */
function signalsOf(c: Company, includeName: boolean, includeDomain: boolean): string[] {
  const sigs: string[] = [];
  const dom = includeDomain ? domainOf(c) : "";
  if (dom) sigs.push(`d:${dom}`);
  const zip = (c.zip ?? "").trim().slice(0, 5);
  if (zip.length === 5) sigs.push(`z:${zip}`);
  const city = normalizeCity(c.city), state = normalizeState(c.state);
  if (city && state) sigs.push(`c:${city}|${state}`);
  if (includeName) {
    const n = normalizeCompanyName(c.name);
    if (n.length >= 3) sigs.push(`n:${n}`);
  }
  return sigs;
}

/**
 * Union-find over shared signals. Returns clusters of 2+ records that are
 * transitively linked, plus the records that linked to nothing (which are
 * reported for human review rather than merged).
 */
function clusterByAnySignal(
  items: Company[],
  /**
   * includeName  — add the normalized name as a signal. On for email groups
   *                (where the name is independent evidence), off for name
   *                groups (where every member already shares it).
   * includeDomain — off for email groups: members share the contact address by
   *                definition, so its domain would link everything and make
   *                the corroboration check vacuous.
   */
  opts?: { includeName?: boolean; includeDomain?: boolean },
): { linked: Company[][]; unlinked: Company[] } {
  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

  const bySignal = new Map<string, number[]>();
  items.forEach((c, i) => {
    for (const s of signalsOf(c, opts?.includeName ?? false, opts?.includeDomain ?? true)) {
      (bySignal.get(s) ?? bySignal.set(s, []).get(s)!).push(i);
    }
  });
  for (const idxs of bySignal.values()) {
    for (let i = 1; i < idxs.length; i++) union(idxs[0], idxs[i]);
  }

  const byRoot = new Map<number, Company[]>();
  items.forEach((c, i) => {
    const r = find(i);
    (byRoot.get(r) ?? byRoot.set(r, []).get(r)!).push(c);
  });
  const linked: Company[][] = [], unlinked: Company[] = [];
  for (const cluster of byRoot.values()) {
    if (cluster.length > 1) linked.push(cluster); else unlinked.push(...cluster);
  }
  return { linked, unlinked };
}

/**
 * Sibling stores of one chain look exactly like duplicates: same city, same
 * shop@ contact address, names differing only by neighbourhood. "Lockwood
 * Williamsburg" and "Lockwood Greenpoint" are two real Brooklyn shops, and
 * both have their own AJM and Jaxy order history.
 *
 * A true duplicate is nearly always one real record plus a stub — the stub is
 * empty precisely because its orders went to the other one. So when a cluster
 * holds two DIFFERENTLY-named records that have each independently
 * accumulated trading history, that is evidence of two operating businesses,
 * not one recorded twice. Those go to review.
 *
 * Same-named records are exempt: five "Rockin' Rudy's" rows in Missoula each
 * carrying orders are one shop the importers split, not five shops.
 */
function looksLikeSiblingLocations(cluster: Company[]): boolean {
  const trading = cluster.filter((c) => c.jaxyOrders > 0 || c.ajmOrders > 0);
  if (trading.length < 2) return false;
  return new Set(trading.map((c) => normalizeCompanyName(c.name))).size > 1;
}

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
  for (const [k, items] of byName) {
    if (items.length < 2) continue;
    const clusters = clusterByAnySignal(items);
    let n = 0;
    for (const cluster of clusters.linked) {
      // Signals link transitively (A shares a zip with B, B a domain with C),
      // so a chain can pull in more records than any single pair justifies.
      // Past MAX_AUTO_CLUSTER that is a chain, not a duplicate — hand it over.
      if (cluster.length > MAX_AUTO_CLUSTER) {
        needsReview.push({
          key: `name:${k}`,
          reason: `${cluster.length} same-named records linked in one chain — too large to merge unreviewed`,
          companies: cluster.slice(0, 25),
        });
        continue;
      }
      groups.set(`name:${k}|${++n}`, { reason: "name", items: cluster });
    }
    // Name matches we deliberately did NOT merge, for human review.
    if (clusters.unlinked.length > 1) {
      needsReview.push({
        key: `name:${k}`,
        reason: "same name, no matching location or domain — could be different businesses",
        companies: clusters.unlinked,
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

    // (b) Corroborate on name or location, same standard as name groups.
    const clusters = clusterByAnySignal(items, { includeName: true, includeDomain: false });
    let n = 0;
    for (const cluster of clusters.linked) {
      if (looksLikeSiblingLocations(cluster)) {
        needsReview.push({
          key: `email:${e}`,
          reason: "differently-named records that each have their own order history — likely sibling stores of one chain, not duplicates",
          companies: cluster,
        });
        continue;
      }
      const key = `email:${e}|${++n}`;
      if (!groups.has(key)) groups.set(key, { reason: "email", items: cluster });
    }
    if (clusters.unlinked.length > 1) {
      needsReview.push({
        key: `email:${e}`,
        reason: "shared contact address but different names and locations — likely different businesses",
        companies: clusters.unlinked,
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
