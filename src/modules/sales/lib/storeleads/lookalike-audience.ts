/**
 * Lookalike-audience generator.
 *
 * Given the set of customers we've already enriched via
 * customer-sync.ts, derive "what a Jaxy customer looks like" by
 * aggregating their StoreLeads-inferred attributes (top categories,
 * platform mix, sales bands, country distribution). Then use those
 * aggregates as filters into StoreLeads' Advanced Search to find
 * new prospects that match.
 *
 * The aggregated profile is computed entirely from local rows we
 * already enriched — no extra API calls. The search loop hits
 * `GET /domain` (List Domains, 2 req/s on Pro/Elite, cursor-paginated).
 *
 * New results are merged into `companies` using the same dedup +
 * fill-nulls rule as the CSV importer, tagged `source_type='storeleads'`
 * and `source='storeleads_lookalike:<category>'` so we can track which
 * lookalike pass each prospect came from.
 */

import { sqlite } from "@/lib/db";
import { searchDomains, type StoreLeadsDomain } from "./client";

export interface CustomerProfile {
  totalCustomers: number;
  /** Top categories observed, ordered most→least common. */
  categories: Array<{ category: string; count: number }>;
  /** Top ecommerce platforms (shopify dominates expectedly). */
  platforms: Array<{ platform: string; count: number }>;
  /** Country distribution (ISO codes). */
  countries: Array<{ country: string; count: number }>;
  /** Sales-band buckets (USD cents). */
  salesBands: {
    /** < $100k/yr */
    small: number;
    /** $100k – $1M/yr */
    mid: number;
    /** $1M – $10M/yr */
    large: number;
    /** > $10M/yr */
    enterprise: number;
    /** No sales estimate from StoreLeads. */
    unknown: number;
  };
  /** Median average product price across customers (USD cents). */
  medianAvgProductPriceCents: number | null;
}

/** Build the aggregated profile from the local DB. Only counts companies
 *  we've actually enriched (storeleads_id IS NOT NULL) so the lookalike
 *  search is grounded in StoreLeads data, not our own free-form tags. */
export function aggregateCustomerProfile(): CustomerProfile {
  const rows = sqlite
    .prepare(
      `SELECT category, ecom_platform, country,
              estimated_yearly_sales_cents,
              average_product_price_cents
       FROM companies
       WHERE storeleads_id IS NOT NULL
         AND id IN (
           SELECT DISTINCT company_id FROM orders
           WHERE company_id IS NOT NULL
             AND status IN ('confirmed','picking','packed','shipped','delivered')
         )`,
    )
    .all() as Array<{
      category: string | null;
      ecom_platform: string | null;
      country: string | null;
      estimated_yearly_sales_cents: number | null;
      average_product_price_cents: number | null;
    }>;

  const categoryCounts = new Map<string, number>();
  const platformCounts = new Map<string, number>();
  const countryCounts = new Map<string, number>();
  const bands = { small: 0, mid: 0, large: 0, enterprise: 0, unknown: 0 };
  const avgPrices: number[] = [];

  for (const r of rows) {
    if (r.category) categoryCounts.set(r.category, (categoryCounts.get(r.category) ?? 0) + 1);
    if (r.ecom_platform) platformCounts.set(r.ecom_platform, (platformCounts.get(r.ecom_platform) ?? 0) + 1);
    if (r.country) countryCounts.set(r.country, (countryCounts.get(r.country) ?? 0) + 1);

    const s = r.estimated_yearly_sales_cents;
    if (s == null) bands.unknown++;
    else if (s < 100_00 * 1000) bands.small++; // < $100k
    else if (s < 1_000_00 * 1000) bands.mid++; // < $1M
    else if (s < 10_000_00 * 1000) bands.large++; // < $10M
    else bands.enterprise++;

    if (r.average_product_price_cents != null) {
      avgPrices.push(r.average_product_price_cents);
    }
  }

  const sortDesc = (m: Map<string, number>) =>
    Array.from(m.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([k, count]) => ({ count, key: k }));

  return {
    totalCustomers: rows.length,
    categories: sortDesc(categoryCounts).map(({ key, count }) => ({ category: key, count })),
    platforms: sortDesc(platformCounts).map(({ key, count }) => ({ platform: key, count })),
    countries: sortDesc(countryCounts).map(({ key, count }) => ({ country: key, count })),
    salesBands: bands,
    medianAvgProductPriceCents: median(avgPrices),
  };
}

function median(arr: number[]): number | null {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

// ─── Lookalike search ────────────────────────────────────────────────────

export interface LookalikeGenOptions {
  /** Max categories to seed searches from (1 = just the top match,
   *  5 = top 5 categories combined). Defaults to 3. */
  topCategoriesToTarget?: number;
  /** Cap on total new prospects fetched. Prevents runaway searches.
   *  Defaults to 500 — sane for an initial pass. */
  maxResults?: number;
  /** Restrict to a country code (e.g. "US"). Falls back to the operator's
   *  customer-base most-common country when omitted. */
  countryFilter?: string;
  /** Restrict to a single ecommerce platform. Falls back to most-common. */
  platformFilter?: string;
  /** Minimum estimated yearly sales (USD cents) — filters out tiny
   *  shops. When omitted, uses the median customer's avg product
   *  price × 12 as a floor (rough heuristic). */
  minYearlySalesCents?: number;
  signal?: AbortSignal;
}

export interface LookalikeRun {
  profile: CustomerProfile;
  /** The filter set the search actually used (so the operator can see
   *  what we asked StoreLeads for). */
  effectiveFilters: Record<string, string | number>;
  /** Distinct domains fetched across all category searches. */
  results: StoreLeadsDomain[];
  /** Per-category result counts (so the operator can tell which categories
   *  dominated the lookalikes). */
  perCategory: Array<{ category: string; count: number }>;
  errors: string[];
  durationMs: number;
}

/**
 * Generate a lookalike-audience prospect list. Returns the raw search
 * results — caller decides whether to upsert them (mergeLookalikesIntoCompanies
 * below) or just preview them.
 */
export async function generateLookalikes(
  opts: LookalikeGenOptions = {},
): Promise<LookalikeRun> {
  const start = Date.now();
  const profile = aggregateCustomerProfile();

  const topN = Math.max(1, Math.min(10, opts.topCategoriesToTarget ?? 3));
  const targetCategories = profile.categories.slice(0, topN).map((c) => c.category);
  const country = opts.countryFilter ?? profile.countries[0]?.country ?? "US";
  const platform = opts.platformFilter ?? profile.platforms[0]?.platform ?? "shopify";
  const minSales =
    opts.minYearlySalesCents ??
    (profile.medianAvgProductPriceCents != null ? profile.medianAvgProductPriceCents * 12 : 100_00 * 1000);
  const maxResults = Math.max(10, Math.min(5000, opts.maxResults ?? 500));

  const effectiveFilters: Record<string, string | number> = {
    "f:cc": country,
    "f:platform": platform,
    "f:salesusdmin": minSales,
  };

  const results: StoreLeadsDomain[] = [];
  const seen = new Set<string>();
  const perCategory: Array<{ category: string; count: number }> = [];
  const errors: string[] = [];

  // Excluded set — we already have these (so we don't surface our own
  // customers or already-imported prospects as "new lookalikes").
  const excludedDomains = new Set<string>(
    (
      sqlite
        .prepare(`SELECT LOWER(TRIM(domain)) AS d FROM companies WHERE domain IS NOT NULL AND TRIM(domain) != ''`)
        .all() as Array<{ d: string }>
    ).map((r) => r.d),
  );

  // List Domains is 2 req/s; we pace 600ms between calls to stay under.
  const PACING_MS = 600;
  let totalFetched = 0;

  for (const category of targetCategories) {
    if (opts.signal?.aborted) {
      errors.push("Aborted by caller");
      break;
    }
    if (totalFetched >= maxResults) break;

    let cursor: string | null = null;
    let categoryCount = 0;
    let pages = 0;
    do {
      try {
        const page: Awaited<ReturnType<typeof searchDomains>> = await searchDomains({
          filters: { ...effectiveFilters, "f:cat": category },
          pageSize: 50,
          cursor: cursor ?? undefined,
          signal: opts.signal,
        });
        for (const d of page.domains) {
          const key = d.domain?.toLowerCase();
          if (!key) continue;
          if (excludedDomains.has(key)) continue;
          if (seen.has(key)) continue;
          seen.add(key);
          results.push(d);
          categoryCount++;
          totalFetched++;
          if (totalFetched >= maxResults) break;
        }
        cursor = page.nextCursor;
        pages++;
        // Hard cap on pagination per category — prevent runaway loops on
        // very broad categories. 10 pages × 50 = 500 candidates max.
        if (pages >= 10) break;
      } catch (e) {
        errors.push(`category "${category}": ${e instanceof Error ? e.message : String(e)}`);
        break;
      }
      if (cursor && totalFetched < maxResults) {
        await new Promise((r) => setTimeout(r, PACING_MS));
      }
    } while (cursor && totalFetched < maxResults);

    perCategory.push({ category, count: categoryCount });
    if (totalFetched < maxResults) {
      await new Promise((r) => setTimeout(r, PACING_MS));
    }
  }

  return {
    profile,
    effectiveFilters,
    results,
    perCategory,
    errors,
    durationMs: Date.now() - start,
  };
}

// ─── Merge lookalike results into companies ──────────────────────────────

export interface MergeStats {
  inspected: number;
  created: number;
  alreadyKnown: number;
  errors: number;
}

/**
 * Persist lookalike results into `companies` using the same merge rule
 * as the CSV importer (fill nulls, never clobber). Tags rows
 * `source_type='storeleads'` and `source='storeleads_lookalike:<seed>'`.
 */
export function mergeLookalikesIntoCompanies(opts: {
  results: StoreLeadsDomain[];
  /** Free-text label used on the new rows' `source` column. */
  sourceLabel: string;
}): MergeStats {
  const stats: MergeStats = { inspected: 0, created: 0, alreadyKnown: 0, errors: 0 };
  const now = new Date().toISOString();

  const selectByDomain = sqlite.prepare<[string]>(
    `SELECT id FROM companies WHERE domain = ? LIMIT 1`,
  );
  const insertNew = sqlite.prepare(
    `INSERT INTO companies (
       id, name, type, domain, website, phone, email,
       city, state, country,
       category, industry, status, source, source_type,
       storeleads_id, storeleads_last_synced_at,
       estimated_yearly_sales_cents, estimated_monthly_visits,
       average_product_price_cents, employee_count,
       facebook_url, instagram_url, tiktok_url, tiktok_followers,
       youtube_url, youtube_followers, ecom_platform,
       enriched_at, enrichment_source, enrichment_fetched_at,
       created_at, updated_at
     ) VALUES (
       ?, ?, 'online', ?, ?, ?, ?,
       ?, ?, ?,
       ?, ?, 'new', ?, 'storeleads',
       ?, ?,
       ?, ?,
       ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?,
       ?, 'storeleads', ?,
       ?, ?
     )`,
  );

  const txn = sqlite.transaction(() => {
    for (const d of opts.results) {
      stats.inspected++;
      try {
        const domain = d.domain?.toLowerCase();
        if (!domain) {
          stats.errors++;
          continue;
        }
        const existing = selectByDomain.get(domain) as { id: string } | undefined;
        if (existing) {
          stats.alreadyKnown++;
          continue;
        }
        const ci = d.contact_info ?? [];
        const first = (type: string) => ci.find((e) => e.type?.toLowerCase() === type)?.value ?? null;
        const follow = (type: string) => ci.find((e) => e.type?.toLowerCase() === type)?.followers ?? null;
        const categoryRaw = d.categories?.[0] ?? null;
        const industry = categoryRaw
          ? categoryRaw.split("/").map((s) => s.trim()).filter(Boolean).pop() ?? null
          : null;
        insertNew.run(
          crypto.randomUUID(),
          d.merchant_name ?? domain,
          domain,
          `https://${domain}`,
          first("phone"),
          first("email"),
          d.city ?? null,
          d.state ?? null,
          d.country_code ?? null,
          categoryRaw,
          industry,
          opts.sourceLabel,
          d.platform_domain ?? d.domain,
          now,
          typeof d.estimated_sales_yearly === "number" ? d.estimated_sales_yearly : null,
          typeof d.estimated_visits === "number" ? d.estimated_visits : null,
          typeof d.avg_price_usd === "number" ? d.avg_price_usd : null,
          typeof d.employee_count === "number" ? d.employee_count : null,
          first("facebook"),
          first("instagram"),
          first("tiktok"),
          follow("tiktok"),
          first("youtube"),
          follow("youtube"),
          d.platform?.toLowerCase() ?? null,
          now,
          now,
          now,
          now,
        );
        stats.created++;
      } catch {
        stats.errors++;
      }
    }
  });
  txn();
  return stats;
}
