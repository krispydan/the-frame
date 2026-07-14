/**
 * AJ Morgan Faire export → segmented reactivation call lists.
 *
 * Ingests the full Faire "Customers" export (~17k rows, mostly never-ordered
 * email leads), keeps only stores that actually ordered on AJM's Faire, and —
 * using the frame to exclude anyone who has ALREADY ordered with Jaxy —
 * produces two value-segmented cohorts for the pre-Faire-Marketplace push:
 *   - high spend  → Christina
 *   - low spend   → Sandra
 *
 * This module only PARSES + ANALYSES (no writes) so we can dry-run the counts,
 * exclusions and the Christina/Sandra split before committing anything.
 */
import { sqlite } from "@/lib/db";
import { buildDedupeIndex, findExistingCompany, type AjmRow } from "./ajm-import";
import { getPipelineOwner } from "./pipedrive-setup";
import type { InstantlyLead as InstantlyApiLead } from "./instantly-client";
import {
  parseFaireExport,
  parseEmailOverlay,
  normStoreKey,
  formatInstantlyCsv,
  splitName,
  firstNameForMerge,
  type FaireRow,
  type InstantlyLead,
} from "./faire-marketplace-parse";

export { parseFaireExport, type FaireRow };

// Domains that don't identify a single business — never use them to link a
// store to a Jaxy customer (would over-exclude on a shared inbox host).
const GENERIC_EMAIL_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "aol.com", "comcast.net", "msn.com", "outlook.com",
  "icloud.com", "sbcglobal.net", "verizon.net", "cox.net", "me.com", "bellsouth.net", "att.net",
  "live.com", "ymail.com", "mac.com", "earthlink.net", "relay.faire.com", "myshopify.com",
  "shopify.com", "squarespace.com", "wixpress.com", "wix.com", "bigcommerce.com", "gmail.co",
]);

function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const d = email.split("@")[1]?.toLowerCase().trim();
  return d && !GENERIC_EMAIL_DOMAINS.has(d) ? d : null;
}

function stateKey(s: string | null | undefined): string {
  return (s || "").trim().slice(0, 2).toUpperCase();
}

export interface FaireAnalysisRow extends FaireRow {
  frameCompanyId: string | null;
  matchedBy: string | null;
  emailFromLookup: boolean;
  alreadyJaxy: boolean;
  withinWindow: boolean;
  inAjmPipeline: boolean; // already has an open deal in AJM Reactivation
  hasPhone: boolean; // matched frame company has a phone (callable)
  segment: "high" | "low";
}

export interface FaireAnalysis {
  params: { recencyYears: number; highMinSpend: number; cutoffIso: string };
  parsed: { rows: number; skipped: number; neverOrdered: number; ordered: number };
  funnel: {
    orderedTotal: number; // rows that have ever ordered on AJM Faire
    matchedToFrame: number;
    alreadyJaxyCustomers: number; // excluded
    notJaxy: number;
    notJaxy_withinWindow: number;
    notJaxy_unknownDate: number;
    notJaxy_tooOld: number;
  };
  target: {
    size: number; // ordered AND not-Jaxy AND within window
    withEmail: number;
    emailFromLookup: number; // emails supplied by the overlay
    matchedInFrame: number;
    callable_hasPhone: number; // reachable by phone via frame match
    alreadyInAjmPipeline: number; // already have an open AJM Reactivation deal
    notInPipeline_toAdd: number; // need adding to AJM Reactivation
    toAdd_needNewCompany: number; // of those, not even in the frame yet
    high_Christina: number;
    low_Sandra: number;
    highSpendTotal: number;
    lowSpendTotal: number;
  };
  spendPercentiles: { p10: number; p25: number; median: number; p75: number; p90: number; max: number } | null;
  sampleHigh: Array<{ store: string | null; spend: number; last: string | null; state: string | null; hasPhone: boolean }>;
  sampleLow: Array<{ store: string | null; spend: number; last: string | null; state: string | null; hasPhone: boolean }>;
  rows?: FaireAnalysisRow[]; // included only when opts.includeRows
}

export interface FaireInstantlyLead {
  frameCompanyId: string | null;
  lead: InstantlyApiLead;
}

export interface FairePhoneBurnerLead {
  frameCompanyId: string | null;
  tier: "high" | "low";
  firstName: string;
  lastName: string;
  store: string;
  phone: string;
  email: string;
  city: string;
  state: string;
  zip: string;
  spend: number;
  orderCount: string;
  lastOrdered: string;
}

/**
 * Callable target cohort for PhoneBurner: target stores with a phone (from the
 * matched frame company), deduped by phone number, split by tier (high →
 * Christina, low → Sandra). Names are proper-cased; business/role contacts get
 * a blank first name (the store name still carries in `store`).
 */
export function buildFairePhoneBurnerLeads(
  text: string,
  opts: { recencyYears?: number; highMinSpend?: number; emailOverlay?: string } = {},
): { high: FairePhoneBurnerLead[]; low: FairePhoneBurnerLead[] } {
  const analysis = analyzeFaireExport(text, { ...opts, includeRows: true });
  const target = (analysis.rows || []).filter((r) => !r.alreadyJaxy && r.withinWindow && r.frameCompanyId);

  const phoneStmt = sqlite.prepare("SELECT phone FROM company_phones WHERE company_id = ? ORDER BY is_primary DESC, created_at ASC LIMIT 1");
  const zipStmt = sqlite.prepare("SELECT zip FROM companies WHERE id = ?");

  const byPhone = new Map<string, FairePhoneBurnerLead>();
  for (const r of target) {
    const phoneRaw = (phoneStmt.get(r.frameCompanyId) as { phone: string } | undefined)?.phone ?? "";
    const digits = phoneRaw.replace(/\D/g, "");
    if (digits.length < 10) continue; // no callable number
    const key = digits.slice(-10);
    const first = firstNameForMerge(r.contact, r.storeName);
    const last = first ? splitName(r.contact).lastName : "";
    const zip = (zipStmt.get(r.frameCompanyId) as { zip: string | null } | undefined)?.zip ?? "";
    const lead: FairePhoneBurnerLead = {
      frameCompanyId: r.frameCompanyId,
      tier: r.segment,
      firstName: first,
      lastName: last,
      store: r.storeName ?? "",
      phone: phoneRaw,
      email: r.email ?? "",
      city: r.city ?? "",
      state: r.state ?? "",
      zip: r.zip ?? zip ?? "",
      spend: r.spend,
      orderCount: r.orderCount != null ? String(r.orderCount) : "",
      lastOrdered: r.lastOrdered ?? "",
    };
    const cur = byPhone.get(key);
    if (!cur || r.spend > cur.spend) byPhone.set(key, lead);
  }

  const all = [...byPhone.values()].sort((a, b) => b.spend - a.spend);
  return { high: all.filter((l) => l.tier === "high"), low: all.filter((l) => l.tier === "low") };
}

/**
 * DB-sourced callable cohort — the same shape as buildFairePhoneBurnerLeads, but
 * read straight from the frame instead of re-parsing a CSV. Uses the companies
 * the campaign push already tagged (faire_market_2026 + faire_high|faire_low),
 * their persisted AJM spend/last-order, primary phone, and primary contact.
 * Deduped by phone, split by tier. This is the normal path for the PhoneBurner
 * push — no local file required.
 */
export function buildFairePhoneBurnerLeadsFromDb(
  opts: { campaignTag?: string } = {},
): { high: FairePhoneBurnerLead[]; low: FairePhoneBurnerLead[] } {
  const campaignTag = opts.campaignTag || "faire_market_2026";
  const companies = sqlite
    .prepare(
      `SELECT id, name, city, state, zip, ajm_total_spend AS spend, ajm_last_order AS lastOrdered, tags
       FROM companies
       WHERE tags LIKE '%' || ? || '%'`,
    )
    .all(campaignTag) as Array<{
    id: string;
    name: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    spend: number | null;
    lastOrdered: string | null;
    tags: string | null;
  }>;

  const phoneStmt = sqlite.prepare("SELECT phone FROM company_phones WHERE company_id = ? ORDER BY is_primary DESC, created_at ASC LIMIT 1");
  const contactStmt = sqlite.prepare(
    "SELECT first_name, last_name, email FROM contacts WHERE company_id = ? ORDER BY is_primary DESC, created_at ASC LIMIT 1",
  );

  const byPhone = new Map<string, FairePhoneBurnerLead>();
  for (const c of companies) {
    const tagText = (c.tags || "").toLowerCase();
    if (!tagText.includes("faire_high") && !tagText.includes("faire_low")) continue;
    const tier: "high" | "low" = tagText.includes("faire_high") ? "high" : "low";

    const phoneRaw = (phoneStmt.get(c.id) as { phone: string } | undefined)?.phone ?? "";
    const digits = phoneRaw.replace(/\D/g, "");
    if (digits.length < 10) continue; // no callable number
    const key = digits.slice(-10);

    const contact = contactStmt.get(c.id) as { first_name: string | null; last_name: string | null; email: string | null } | undefined;
    const fullName = [contact?.first_name, contact?.last_name].filter(Boolean).join(" ").trim();
    const first = firstNameForMerge(fullName, c.name || "");
    const last = first ? splitName(fullName).lastName : "";

    const lead: FairePhoneBurnerLead = {
      frameCompanyId: c.id,
      tier,
      firstName: first,
      lastName: last,
      store: c.name ?? "",
      phone: phoneRaw,
      email: contact?.email ?? "",
      city: c.city ?? "",
      state: c.state ?? "",
      zip: c.zip ?? "",
      spend: c.spend ?? 0,
      orderCount: "",
      lastOrdered: c.lastOrdered ?? "",
    };
    const cur = byPhone.get(key);
    if (!cur || lead.spend > cur.spend) byPhone.set(key, lead);
  }

  const all = [...byPhone.values()].sort((a, b) => b.spend - a.spend);
  return { high: all.filter((l) => l.tier === "high"), low: all.filter((l) => l.tier === "low") };
}

/**
 * Build the rich Instantly leads for the target cohort (deduped by email),
 * including phone + website from the matched frame company and a full set of
 * custom variables for the sequence merge fields.
 */
export function buildFaireInstantlyLeads(
  text: string,
  opts: { recencyYears?: number; highMinSpend?: number; emailOverlay?: string } = {},
): { leads: FaireInstantlyLead[]; count: number } {
  const analysis = analyzeFaireExport(text, { ...opts, includeRows: true });
  const target = (analysis.rows || []).filter((r) => !r.alreadyJaxy && r.withinWindow && r.email);

  const byEmail = new Map<string, FaireAnalysisRow>();
  for (const r of target) {
    const k = r.email!.toLowerCase();
    const cur = byEmail.get(k);
    if (!cur || r.spend > cur.spend) byEmail.set(k, r);
  }

  const christina = getPipelineOwner("ajm")?.name || "Christina";
  const sandra = getPipelineOwner("catalog")?.name || "Sandra";
  const phoneStmt = sqlite.prepare("SELECT phone FROM company_phones WHERE company_id = ? ORDER BY is_primary DESC, created_at ASC LIMIT 1");
  const webStmt = sqlite.prepare("SELECT website FROM companies WHERE id = ?");

  const leads: FaireInstantlyLead[] = [...byEmail.values()]
    .sort((a, b) => b.spend - a.spend)
    .map((r) => {
      const firstName = firstNameForMerge(r.contact, r.storeName);
      const lastName = firstName ? splitName(r.contact).lastName : "";
      const phone = r.frameCompanyId ? ((phoneStmt.get(r.frameCompanyId) as { phone: string } | undefined)?.phone ?? "") : "";
      const website = r.frameCompanyId ? ((webStmt.get(r.frameCompanyId) as { website: string | null } | undefined)?.website ?? "") : "";
      const custom_variables: Record<string, string> = {
        city: r.city ?? "",
        state: r.state ?? "",
        store_type: r.storeType ?? "",
        lifetime_spend: r.spend ? `$${Math.round(r.spend)}` : "",
        order_count: r.orderCount != null ? String(r.orderCount) : "",
        last_ordered: r.lastOrdered ?? "",
        first_ordered: r.firstOrdered ?? "",
        tier: r.segment,
        owner: r.segment === "high" ? christina : sandra,
        source: "AJM Faire",
      };
      return {
        frameCompanyId: r.frameCompanyId,
        lead: {
          email: r.email!.toLowerCase(),
          first_name: firstName || undefined,
          last_name: lastName || undefined,
          company_name: r.storeName || undefined,
          phone: phone || undefined,
          website: website || undefined,
          custom_variables,
        },
      };
    });

  return { leads, count: leads.length };
}

/**
 * One reviewable campaign-plan CSV: every target store, its channel (Instantly
 * email / PhoneBurner call / needs enrichment), owner (Christina high / Sandra
 * low), value, contact info and context — so the whole plan can be eyeballed in
 * a single spreadsheet before anything runs.
 */
export function buildFaireCampaignPlan(
  text: string,
  opts: { recencyYears?: number; highMinSpend?: number; emailOverlay?: string } = {},
): { csv: string; count: number; summary: Record<string, number> } {
  const analysis = analyzeFaireExport(text, { ...opts, includeRows: true });
  const target = (analysis.rows || []).filter((r) => !r.alreadyJaxy && r.withinWindow);

  const christina = getPipelineOwner("ajm")?.name || "Christina";
  const sandra = getPipelineOwner("catalog")?.name || "Sandra";
  const phoneStmt = sqlite.prepare("SELECT phone FROM company_phones WHERE company_id = ? ORDER BY is_primary DESC, created_at ASC LIMIT 1");
  const nameStmt = sqlite.prepare("SELECT name FROM companies WHERE id = ?");

  interface PlanRow {
    channel: string;
    channelRank: number;
    instantly: boolean;
    phoneburner: boolean;
    owner: string;
    tier: string;
    store: string;
    contact: string;
    city: string;
    state: string;
    storeType: string;
    spend: number;
    orders: string;
    lastOrdered: string;
    email: string;
    emailSource: string;
    phone: string;
    inPipedrive: string;
    frameCompany: string;
  }

  const rows: PlanRow[] = target.map((r) => {
    const phone = r.frameCompanyId ? ((phoneStmt.get(r.frameCompanyId) as { phone: string } | undefined)?.phone ?? "") : "";
    const frameCompany = r.frameCompanyId ? ((nameStmt.get(r.frameCompanyId) as { name: string | null } | undefined)?.name ?? "") : "";
    // Channels are additive — an email puts them in Instantly, a phone puts them
    // in PhoneBurner; if they have both, they go in both ("all platforms").
    const instantly = !!r.email;
    const phoneburner = !!phone;
    const channel =
      instantly && phoneburner ? "Instantly + PhoneBurner" : instantly ? "Instantly" : phoneburner ? "PhoneBurner" : "Needs enrichment";
    // Sort order: both-platforms first, then call-only, then email-only, then gaps.
    const channelRank = instantly && phoneburner ? 0 : phoneburner ? 1 : instantly ? 2 : 3;
    return {
      channel,
      channelRank,
      instantly,
      phoneburner,
      owner: r.segment === "high" ? christina : sandra,
      tier: r.segment,
      store: r.storeName ?? "",
      contact: r.contact ?? "",
      city: r.city ?? "",
      state: r.state ?? "",
      storeType: r.storeType ?? "",
      spend: r.spend,
      orders: r.orderCount != null ? String(r.orderCount) : "",
      lastOrdered: r.lastOrdered ?? "",
      email: r.email ?? "",
      emailSource: r.emailFromLookup ? "manual_lookup" : r.email ? "faire_export" : "none",
      phone,
      inPipedrive: r.inAjmPipeline ? "yes" : "no",
      frameCompany,
    };
  });

  // Group by channel block, then by spend so the biggest accounts are on top.
  rows.sort((a, b) => a.channelRank - b.channelRank || b.spend - a.spend);

  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const HEADERS = [
    "channel", "instantly", "phoneburner", "owner", "tier", "store_name", "contact_name", "city", "state", "store_type",
    "lifetime_ajm_spend", "order_count", "last_ordered", "email", "email_source", "phone",
    "already_in_pipedrive", "frame_company",
  ];
  const lines = [HEADERS.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.channel, r.instantly ? "yes" : "no", r.phoneburner ? "yes" : "no", r.owner, r.tier, r.store, r.contact, r.city, r.state, r.storeType,
        r.spend ? `$${Math.round(r.spend)}` : "", r.orders, r.lastOrdered, r.email, r.emailSource, r.phone,
        r.inPipedrive, r.frameCompany,
      ]
        .map((v) => esc(String(v ?? "")))
        .join(","),
    );
  }

  const summary = {
    total: rows.length,
    on_instantly: rows.filter((r) => r.instantly).length,
    on_phoneburner: rows.filter((r) => r.phoneburner).length,
    on_both: rows.filter((r) => r.instantly && r.phoneburner).length,
    email_only: rows.filter((r) => r.instantly && !r.phoneburner).length,
    call_only: rows.filter((r) => !r.instantly && r.phoneburner).length,
    needs_enrichment: rows.filter((r) => !r.instantly && !r.phoneburner).length,
    christina_high: rows.filter((r) => r.tier === "high").length,
    sandra_low: rows.filter((r) => r.tier === "low").length,
  };

  return { csv: lines.join("\r\n"), count: rows.length, summary };
}

/** Frame-side detail for a company: status, tags, Jaxy order count, emails. */
function companyDetail(companyId: string): Record<string, unknown> | null {
  const c = sqlite.prepare("SELECT id, name, status, tags, state FROM companies WHERE id = ?").get(companyId) as
    | { id: string; name: string | null; status: string | null; tags: string | null; state: string | null }
    | undefined;
  if (!c) return null;
  const orders = (sqlite.prepare("SELECT COUNT(*) n FROM orders WHERE company_id = ? AND status != 'cancelled'").get(companyId) as { n: number }).n;
  const emails = (sqlite.prepare("SELECT email FROM contacts WHERE company_id = ? AND TRIM(COALESCE(email,'')) <> ''").all(companyId) as Array<{ email: string }>).map((r) => r.email);
  return { id: c.id, name: c.name, status: c.status, state: c.state, tags: c.tags, jaxyOrders: orders, emails };
}

/**
 * Explain why a store landed (or didn't land) on the list: its export row, how
 * it was classified, the frame company it matched (if any), and candidate frame
 * records it MIGHT be — searched by name and by the export email — so we can see
 * a missed Jaxy customer hiding under a different name (e.g. Joyville → Favor
 * the Kind).
 */
export function debugFaireStore(
  text: string,
  needle: string,
  opts: { recencyYears?: number; highMinSpend?: number; emailOverlay?: string } = {},
): Record<string, unknown> {
  const analysis = analyzeFaireExport(text, { ...opts, includeRows: true });
  const n = needle.toLowerCase();
  const rows = (analysis.rows || []).filter((r) => (r.storeName || "").toLowerCase().includes(n));

  const matches = rows.map((r) => ({
    export: { store: r.storeName, email: r.email, state: r.state, spend: r.spend, lastOrdered: r.lastOrdered, ordered: r.ordered, contact: r.contact },
    classification: {
      frameCompanyId: r.frameCompanyId,
      matchedBy: r.matchedBy,
      alreadyJaxy: r.alreadyJaxy,
      withinWindow: r.withinWindow,
      inAjmPipeline: r.inAjmPipeline,
      onInstantlyList: !r.alreadyJaxy && r.withinWindow && !!r.email,
    },
    matchedCompany: r.frameCompanyId ? companyDetail(r.frameCompanyId) : null,
  }));

  // Candidate frame records this store could actually be: by name, and by the
  // export email / its domain (the strongest tell of a missed Jaxy customer).
  const candidateIds = new Set<string>();
  for (const r of rows) {
    for (const c of sqlite.prepare("SELECT id FROM companies WHERE lower(name) LIKE ? LIMIT 25").all(`%${n}%`) as Array<{ id: string }>) candidateIds.add(c.id);
    if (r.email) {
      const domain = r.email.split("@")[1];
      for (const c of sqlite
        .prepare("SELECT DISTINCT company_id id FROM contacts WHERE lower(email) = ? OR lower(email) LIKE ? LIMIT 25")
        .all(r.email.toLowerCase(), domain ? `%@${domain.toLowerCase()}` : " ") as Array<{ id: string }>)
        candidateIds.add(c.id);
      // also try the email local-part as a name hint (favorthekind → Favor The Kind)
      const local = r.email.split("@")[0];
      if (local && local.length >= 4)
        for (const c of sqlite.prepare("SELECT id FROM companies WHERE replace(replace(lower(name),' ',''),'.','') LIKE ? LIMIT 25").all(`%${local.toLowerCase()}%`) as Array<{ id: string }>) candidateIds.add(c.id);
    }
  }
  const candidates = [...candidateIds].map((id) => companyDetail(id)).filter(Boolean);

  return { needle, matchesInExport: rows.length, matches, candidateFrameRecords: candidates };
}

/**
 * Build an Instantly-ready CSV of the target cohort (ordered, not-Jaxy, within
 * window) that has an email. Deduped by email (keeps the highest-spend store
 * per address), so Instantly gets one clean row per inbox.
 */
export function buildFaireInstantlyCsv(
  text: string,
  opts: { recencyYears?: number; highMinSpend?: number; emailOverlay?: string } = {},
): { csv: string; count: number; targetTotal: number; withoutEmail: number; deduped: number } {
  const analysis = analyzeFaireExport(text, { ...opts, includeRows: true });
  const target = (analysis.rows || []).filter((r) => !r.alreadyJaxy && r.withinWindow);
  const withEmail = target.filter((r) => r.email);

  // Dedupe by email — keep the highest-spend row for a shared inbox.
  const byEmail = new Map<string, FaireAnalysisRow>();
  for (const r of withEmail) {
    const key = r.email!.toLowerCase();
    const cur = byEmail.get(key);
    if (!cur || r.spend > cur.spend) byEmail.set(key, r);
  }

  const leads: InstantlyLead[] = [...byEmail.values()]
    .sort((a, b) => b.spend - a.spend)
    .map((r) => {
      // Proper-cased first name for {{firstName}} — blank when the contact
      // isn't a real person (Instantly's fallback handles the greeting).
      const firstName = firstNameForMerge(r.contact, r.storeName);
      const lastName = firstName ? splitName(r.contact).lastName : "";
      return {
        email: r.email!.toLowerCase(),
        firstName,
        lastName,
        companyName: r.storeName ?? "",
        city: r.city ?? "",
        state: r.state ?? "",
        lastOrdered: r.lastOrdered ?? "",
        lifetimeSpend: r.spend ? `$${Math.round(r.spend)}` : "",
        tier: r.segment,
      };
    });

  return {
    csv: formatInstantlyCsv(leads),
    count: leads.length,
    targetTotal: target.length,
    withoutEmail: target.length - withEmail.length,
    deduped: withEmail.length - leads.length,
  };
}

/**
 * Keep only stores that ORDERED, match each against the frame, exclude existing
 * Jaxy customers, apply the recency window, and split the survivors by spend.
 * Contact reachability (phone) comes from the matched frame company, since the
 * Faire export carries no phone column.
 */
export function analyzeFaireExport(
  text: string,
  opts: { recencyYears?: number; highMinSpend?: number; includeRows?: boolean; emailOverlay?: string } = {},
): FaireAnalysis {
  const recencyYears = opts.recencyYears ?? 4;
  const highMinSpend = opts.highMinSpend ?? 1500;
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - recencyYears);
  const cutoffTs = cutoff.getTime();

  const { rows: allRows, skipped } = parseFaireExport(text);
  // We only care about stores that have actually ordered on AJM's Faire — the
  // export is mostly never-ordered email leads.
  const rows = allRows.filter((r) => r.ordered);
  // Optional manually-looked-up email overlay (normStoreKey → email), used to
  // fill missing emails (improves both reachability and frame matching).
  const overlay = opts.emailOverlay ? parseEmailOverlay(opts.emailOverlay) : null;
  const idx = buildDedupeIndex();

  // Company_ids that have ordered with Jaxy (non-cancelled) — the exclusion set.
  const jaxyOrderCompanyIds = new Set(
    (sqlite.prepare("SELECT DISTINCT company_id FROM orders WHERE status != 'cancelled' AND company_id IS NOT NULL").all() as Array<{
      company_id: string;
    }>).map((r) => r.company_id),
  );

  // Build a "Jaxy customer fingerprint" so a store still excludes even when its
  // export row matched a DIFFERENT frame record than the one carrying the Jaxy
  // orders (same business under multiple records — e.g. Joyville / Favor the
  // Kind / Favor the Kind Belmont). A company counts as a Jaxy customer if it's
  // status=customer, has a Jaxy order, or is tagged ajm_already_customer. We
  // then index those companies' business email-domains and name+state.
  const allCompanies = sqlite.prepare("SELECT id, name, state, status, tags FROM companies").all() as Array<{
    id: string; name: string | null; state: string | null; status: string | null; tags: string | null;
  }>;
  const isJaxyCustomer = (c: { id: string; status: string | null; tags: string | null }) =>
    c.status === "customer" || jaxyOrderCompanyIds.has(c.id) || (c.tags || "").toLowerCase().includes("ajm_already_customer");
  const jaxyCustomerIds = new Set(allCompanies.filter(isJaxyCustomer).map((c) => c.id));
  const jaxyDomains = new Set<string>();
  const jaxyNameState = new Set<string>();
  for (const c of allCompanies) {
    if (!jaxyCustomerIds.has(c.id)) continue;
    const nk = normStoreKey(c.name);
    const st = stateKey(c.state);
    if (nk && st) jaxyNameState.add(`${nk}|${st}`);
  }
  for (const ct of sqlite.prepare("SELECT company_id, email FROM contacts WHERE TRIM(COALESCE(email,'')) <> ''").all() as Array<{
    company_id: string; email: string;
  }>) {
    if (!jaxyCustomerIds.has(ct.company_id)) continue;
    const d = emailDomain(ct.email);
    if (d) jaxyDomains.add(d);
  }
  // Frame companies that have at least one phone on file (for callability).
  const companiesWithPhone = new Set(
    (sqlite.prepare("SELECT DISTINCT company_id FROM company_phones WHERE TRIM(COALESCE(phone,'')) <> ''").all() as Array<{
      company_id: string;
    }>).map((r) => r.company_id),
  );
  // Company_ids that already have an OPEN deal in AJM Reactivation.
  const inAjmPipeline = new Set(
    (sqlite.prepare("SELECT DISTINCT company_id FROM pipedrive_deals WHERE pipeline = 'ajm' AND is_open = 1 AND company_id IS NOT NULL").all() as Array<{
      company_id: string;
    }>).map((r) => r.company_id),
  );

  const analyzed: FaireAnalysisRow[] = rows.map((row) => {
    // Fill a missing email from the overlay (matched on normalized store name).
    let email = row.email;
    let emailFromLookup = false;
    if (!email && overlay) {
      const found = overlay.get(normStoreKey(row.storeName));
      if (found) {
        email = found;
        emailFromLookup = true;
      }
    }
    // Name + state + email all help the frame matcher (this export has no phone).
    const probe = { name: row.storeName, email, phone: null, state: row.state } as AjmRow;
    const match = findExistingCompany(probe, idx);
    let alreadyJaxy = false;
    if (match) {
      const tags = (match.tags || "").toLowerCase();
      alreadyJaxy =
        match.status === "customer" ||
        jaxyOrderCompanyIds.has(match.id) ||
        tags.includes("ajm_already_customer");
    }
    // Cross-record check: the store's business domain or name+state resolves to
    // a Jaxy customer even if the matched record itself wasn't the customer one.
    if (!alreadyJaxy) {
      const d = emailDomain(email);
      const nsk = `${normStoreKey(row.storeName)}|${stateKey(row.state)}`;
      if ((d && jaxyDomains.has(d)) || (normStoreKey(row.storeName) && stateKey(row.state) && jaxyNameState.has(nsk))) {
        alreadyJaxy = true;
      }
    }
    const withinWindow = row.lastOrderedTs != null && row.lastOrderedTs >= cutoffTs;
    return {
      ...row,
      email,
      frameCompanyId: match?.id ?? null,
      matchedBy: match?.matched_by ?? null,
      emailFromLookup,
      alreadyJaxy,
      withinWindow,
      inAjmPipeline: !!match && inAjmPipeline.has(match.id),
      hasPhone: !!match && companiesWithPhone.has(match.id),
      segment: row.spend >= highMinSpend ? "high" : "low",
    };
  });

  const hasPhone = (r: FaireAnalysisRow) => r.hasPhone;
  const matchedToFrame = analyzed.filter((r) => r.frameCompanyId).length;
  const alreadyJaxy = analyzed.filter((r) => r.alreadyJaxy);
  const notJaxy = analyzed.filter((r) => !r.alreadyJaxy);
  const notJaxyUnknown = notJaxy.filter((r) => r.lastOrderedTs == null);
  const notJaxyTooOld = notJaxy.filter((r) => r.lastOrderedTs != null && !r.withinWindow);
  const target = notJaxy.filter((r) => r.withinWindow);

  const spends = target.map((r) => r.spend).sort((a, b) => a - b);
  const pct = (p: number) => (spends.length ? spends[Math.min(spends.length - 1, Math.floor((p / 100) * spends.length))] : 0);
  const high = target.filter((r) => r.segment === "high");
  const low = target.filter((r) => r.segment === "low");
  const sum = (a: FaireAnalysisRow[]) => Math.round(a.reduce((s, r) => s + r.spend, 0));
  const sample = (a: FaireAnalysisRow[]) =>
    a
      .slice()
      .sort((x, y) => y.spend - x.spend)
      .slice(0, 10)
      .map((r) => ({ store: r.storeName, spend: r.spend, last: r.lastOrdered, state: r.state, hasPhone: hasPhone(r) }));

  return {
    params: { recencyYears, highMinSpend, cutoffIso: cutoff.toISOString().slice(0, 10) },
    parsed: { rows: allRows.length, skipped, neverOrdered: allRows.length - rows.length, ordered: rows.length },
    funnel: {
      orderedTotal: rows.length,
      matchedToFrame,
      alreadyJaxyCustomers: alreadyJaxy.length,
      notJaxy: notJaxy.length,
      notJaxy_withinWindow: target.length,
      notJaxy_unknownDate: notJaxyUnknown.length,
      notJaxy_tooOld: notJaxyTooOld.length,
    },
    target: {
      size: target.length,
      withEmail: target.filter((r) => r.email).length,
      emailFromLookup: target.filter((r) => r.emailFromLookup).length,
      matchedInFrame: target.filter((r) => r.frameCompanyId).length,
      callable_hasPhone: target.filter(hasPhone).length,
      alreadyInAjmPipeline: target.filter((r) => r.inAjmPipeline).length,
      notInPipeline_toAdd: target.filter((r) => !r.inAjmPipeline).length,
      toAdd_needNewCompany: target.filter((r) => !r.inAjmPipeline && !r.frameCompanyId).length,
      high_Christina: high.length,
      low_Sandra: low.length,
      highSpendTotal: sum(high),
      lowSpendTotal: sum(low),
    },
    spendPercentiles: spends.length
      ? { p10: pct(10), p25: pct(25), median: pct(50), p75: pct(75), p90: pct(90), max: spends[spends.length - 1] }
      : null,
    sampleHigh: sample(high),
    sampleLow: sample(low),
    rows: opts.includeRows ? analyzed : undefined,
  };
}
