/**
 * Sync our customer list to StoreLeads.
 *
 * Two-step pipeline that powers the "lookalike audience" workflow:
 *
 *   1. exportCustomerDomains() — pull every domain belonging to a
 *      company that has placed at least one non-cancelled order
 *      against us. "Customer" is defined by behaviour (real orders)
 *      not by the status field, so it stays accurate even when the
 *      status enum drifts.
 *
 *   2. uploadCustomerListToStoreLeads(listName) — PUTs those domains
 *      to StoreLeads' Add Domains to List endpoint (≤10,000/req, we
 *      currently have well under that). Then bulk-enriches each
 *      customer's company row in our DB by pulling their StoreLeads
 *      profile via /domain/bulk (100/req, 5 req/s). Same merge rule
 *      as the CSV importer: fill nulls, never clobber.
 *
 * The list on StoreLeads is named "Jaxy Customers" by default — that
 * name is stable so re-runs target the same list (add-domains is
 * additive; we don't have to delete-and-recreate).
 */

import { sqlite } from "@/lib/db";
import {
  addDomainsToList,
  bulkGetStoresByDomain,
  type StoreLeadsDomain,
} from "./client";

/** Default name for the StoreLeads list we push our customers to. */
export const DEFAULT_CUSTOMER_LIST_NAME = "Jaxy Customers";

/** Order statuses that count as a "real customer" relationship. We exclude
 *  cancelled / returned so a one-time refund doesn't promote a tire-kicker
 *  to lookalike-seed status. */
const REAL_ORDER_STATUSES = [
  "confirmed",
  "picking",
  "packed",
  "shipped",
  "delivered",
] as const;

export interface CustomerExport {
  /** Local companies.id for joining back to enrichment writes. */
  companyId: string;
  /** Normalised domain ready to send to StoreLeads. */
  domain: string;
  /** Company display name — used for logging only. */
  name: string | null;
  /** How many shipped/confirmed orders we have against them. */
  orderCount: number;
}

/**
 * Returns every unique customer domain we have orders against. Excludes
 * companies with a missing/blank domain (StoreLeads can't look those up).
 */
export function exportCustomerDomains(): CustomerExport[] {
  const placeholders = REAL_ORDER_STATUSES.map(() => "?").join(",");
  const rows = sqlite
    .prepare(
      `SELECT c.id              AS company_id,
              LOWER(TRIM(c.domain)) AS domain,
              c.name            AS name,
              COUNT(o.id)       AS order_count
       FROM companies c
       INNER JOIN orders o ON o.company_id = c.id
       WHERE c.domain IS NOT NULL
         AND TRIM(c.domain) != ''
         AND o.status IN (${placeholders})
       GROUP BY c.id, LOWER(TRIM(c.domain))
       ORDER BY order_count DESC, c.id`,
    )
    .all(...REAL_ORDER_STATUSES) as Array<{
      company_id: string;
      domain: string;
      name: string | null;
      order_count: number;
    }>;
  return rows.map((r) => ({
    companyId: r.company_id,
    domain: r.domain,
    name: r.name,
    orderCount: r.order_count,
  }));
}

export interface CustomerSyncStats {
  totalCustomers: number;
  /** Domains StoreLeads accepted into the list. */
  storeleadsAccepted: number;
  /** Domains StoreLeads didn't recognise (returned in unrecognized_domains). */
  storeleadsUnrecognized: string[];
  /** Companies whose row got enriched with StoreLeads data on this run. */
  enriched: number;
  /** Domains where the bulk lookup returned no record. */
  notFoundInStoreLeads: string[];
  /** Per-domain errors from any step. */
  errors: Array<{ domain: string; message: string }>;
  durationMs: number;
}

/**
 * Push the customer list to StoreLeads, then bulk-enrich each customer's
 * company row.
 *
 * @param opts.listName  Defaults to "Jaxy Customers" — stable across runs.
 * @param opts.onProgress  Streamed (processed, total, phase) callback.
 */
export async function uploadCustomerListToStoreLeads(opts: {
  listName?: string;
  /** Cap the run (for testing) — skip if undefined. */
  limit?: number;
  onProgress?: (processed: number, total: number, phase: "list" | "enrich") => void;
  signal?: AbortSignal;
} = {}): Promise<CustomerSyncStats> {
  const start = Date.now();
  const listName = opts.listName ?? DEFAULT_CUSTOMER_LIST_NAME;

  const customers = exportCustomerDomains();
  const slice = opts.limit ? customers.slice(0, opts.limit) : customers;
  const stats: CustomerSyncStats = {
    totalCustomers: slice.length,
    storeleadsAccepted: 0,
    storeleadsUnrecognized: [],
    enriched: 0,
    notFoundInStoreLeads: [],
    errors: [],
    durationMs: 0,
  };
  if (slice.length === 0) {
    stats.durationMs = Date.now() - start;
    return stats;
  }

  // Step 1 — push to the StoreLeads List. 10,000 per request; we're nowhere
  // near that yet. Single call.
  try {
    const allDomains = slice.map((c) => c.domain);
    const res = await addDomainsToList({
      listName,
      domains: allDomains,
      signal: opts.signal,
    });
    stats.storeleadsAccepted = res.countAdded;
    stats.storeleadsUnrecognized = res.unrecognized;
    opts.onProgress?.(allDomains.length, allDomains.length, "list");
  } catch (e) {
    stats.errors.push({
      domain: "(list-upload)",
      message: e instanceof Error ? e.message : String(e),
    });
    // The enrichment step doesn't depend on the list upload succeeding —
    // we can still fetch each customer's profile. Continue.
  }

  // Step 2 — bulk lookup. 100 domains per request; 5 req/sec on Pro/Elite.
  // Use 250ms pacing → 4 req/s, well under the limit and headroom for the
  // single Retry-After we'd hit if we drifted over.
  const BATCH = 100;
  const PACING_MS = 250;
  let processed = 0;
  const unrecognizedSet = new Set(
    stats.storeleadsUnrecognized.map((d) => d.toLowerCase()),
  );

  const updateStmt = sqlite.prepare(
    `UPDATE companies
        SET storeleads_id                  = COALESCE(storeleads_id, ?),
            storeleads_last_synced_at      = ?,
            category                       = COALESCE(category, ?),
            industry                       = COALESCE(industry, ?),
            estimated_yearly_sales_cents   = COALESCE(estimated_yearly_sales_cents, ?),
            estimated_monthly_visits       = COALESCE(estimated_monthly_visits, ?),
            average_product_price_cents    = COALESCE(average_product_price_cents, ?),
            employee_count                 = COALESCE(employee_count, ?),
            ecom_platform                  = COALESCE(ecom_platform, ?),
            facebook_url                   = COALESCE(facebook_url, ?),
            instagram_url                  = COALESCE(instagram_url, ?),
            tiktok_url                     = COALESCE(tiktok_url, ?),
            tiktok_followers               = COALESCE(tiktok_followers, ?),
            youtube_url                    = COALESCE(youtube_url, ?),
            youtube_followers              = COALESCE(youtube_followers, ?),
            phone                          = COALESCE(phone, ?),
            email                          = COALESCE(email, ?),
            updated_at                     = ?
      WHERE id = ?`,
  );

  for (let i = 0; i < slice.length; i += BATCH) {
    if (opts.signal?.aborted) {
      stats.errors.push({ domain: "(aborted)", message: "User cancelled" });
      break;
    }
    const chunk = slice.slice(i, i + BATCH);
    const domains = chunk.map((c) => c.domain);
    try {
      const map = await bulkGetStoresByDomain(domains, {
        followRedirects: true,
        signal: opts.signal,
      });
      const now = new Date().toISOString();
      const txn = sqlite.transaction(() => {
        for (const c of chunk) {
          const sl = map[c.domain.toLowerCase()];
          if (!sl) {
            // Either StoreLeads doesn't know this domain, or it was
            // already in the unrecognised list from the list-upload step.
            if (!unrecognizedSet.has(c.domain.toLowerCase())) {
              stats.notFoundInStoreLeads.push(c.domain);
            }
            continue;
          }
          try {
            const fields = mapStoreLeadsToCompanyFields(sl);
            updateStmt.run(
              fields.storeleadsId,
              now, // storeleads_last_synced_at
              fields.category,
              fields.industry,
              fields.estimatedYearlySalesCents,
              fields.estimatedMonthlyVisits,
              fields.averageProductPriceCents,
              fields.employeeCount,
              fields.ecomPlatform,
              fields.facebookUrl,
              fields.instagramUrl,
              fields.tiktokUrl,
              fields.tiktokFollowers,
              fields.youtubeUrl,
              fields.youtubeFollowers,
              fields.phone,
              fields.email,
              now, // updated_at
              c.companyId,
            );
            stats.enriched++;
          } catch (e) {
            stats.errors.push({
              domain: c.domain,
              message: e instanceof Error ? e.message : String(e),
            });
          }
        }
      });
      txn();
    } catch (e) {
      // Whole-batch failure (auth, network, 5xx). Surface as a single error.
      stats.errors.push({
        domain: `batch ${i}-${i + chunk.length}`,
        message: e instanceof Error ? e.message : String(e),
      });
    }

    processed += chunk.length;
    opts.onProgress?.(processed, slice.length, "enrich");
    if (i + BATCH < slice.length) {
      await new Promise((r) => setTimeout(r, PACING_MS));
    }
  }

  stats.durationMs = Date.now() - start;
  return stats;
}

// ─── StoreLeads domain → companies fields mapping ────────────────────────

interface MappedFields {
  storeleadsId: string | null;
  category: string | null;
  industry: string | null;
  estimatedYearlySalesCents: number | null;
  estimatedMonthlyVisits: number | null;
  averageProductPriceCents: number | null;
  employeeCount: number | null;
  ecomPlatform: string | null;
  facebookUrl: string | null;
  instagramUrl: string | null;
  tiktokUrl: string | null;
  tiktokFollowers: number | null;
  youtubeUrl: string | null;
  youtubeFollowers: number | null;
  phone: string | null;
  email: string | null;
}

function mapStoreLeadsToCompanyFields(sl: StoreLeadsDomain): MappedFields {
  // StoreLeads ships several IDs at once; the canonical one we can use to
  // re-lookup the store later is the platform_domain. Otherwise the
  // public domain is itself stable.
  const slId = sl.platform_domain ?? sl.domain;
  const categoryRaw = sl.categories?.[0] ?? null;
  const industry = (() => {
    if (!categoryRaw) return null;
    const seg = categoryRaw.split("/").map((s) => s.trim()).filter(Boolean).pop();
    return seg ?? null;
  })();

  // contact_info is the unified channel for emails / phones / socials.
  const ci = sl.contact_info ?? [];
  const firstByType = (type: string) =>
    ci.find((e) => e.type?.toLowerCase() === type)?.value ?? null;
  const followersByType = (type: string) =>
    ci.find((e) => e.type?.toLowerCase() === type)?.followers ?? null;

  return {
    storeleadsId: slId,
    category: categoryRaw,
    industry,
    estimatedYearlySalesCents: typeof sl.estimated_sales_yearly === "number" ? sl.estimated_sales_yearly : null,
    estimatedMonthlyVisits: typeof sl.estimated_visits === "number" ? sl.estimated_visits : null,
    averageProductPriceCents: typeof sl.avg_price_usd === "number" ? sl.avg_price_usd : null,
    employeeCount: typeof sl.employee_count === "number" ? sl.employee_count : null,
    ecomPlatform: sl.platform?.toLowerCase() ?? null,
    facebookUrl: firstByType("facebook"),
    instagramUrl: firstByType("instagram"),
    tiktokUrl: firstByType("tiktok"),
    tiktokFollowers: followersByType("tiktok"),
    youtubeUrl: firstByType("youtube"),
    youtubeFollowers: followersByType("youtube"),
    phone: firstByType("phone"),
    email: firstByType("email"),
  };
}
