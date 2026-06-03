/**
 * Import a StoreLeads.app CSV export into the `companies` table.
 *
 * Two formats are accepted: their per-search export (the two CSVs Daniel
 * dragged in — boutique women's clothing + vintage) and any future
 * search export with the same column shape. Columns we recognise:
 *
 *   domain, about_us_url, average_product_price_usd, categories, city,
 *   cluster_domains, company_ids, company_location, contact_page_url,
 *   country_code, created, description, domain_url, emails,
 *   employee_count, estimated_monthly_pageviews, estimated_monthly_visits,
 *   estimated_yearly_sales, facebook, instagram, phones, platform,
 *   region, state, status, street_address, tiktok, tiktok_followers,
 *   youtube, youtube_followers
 *
 * Merge rule: ALWAYS fill a field that's currently null on the company
 * row; NEVER overwrite a non-null value. The single exception is
 * `storeleads_last_synced_at`, which we always stamp so we can see when
 * we last touched a row from this source.
 *
 * Dedup: match by normalised domain first (the most reliable key for
 * ecommerce stores). If no domain match, insert as a new row tagged
 * source_type='storeleads'.
 */
import Papa from "papaparse";
import fs from "fs";
import { sqlite } from "@/lib/db";
import { extractDomain } from "../import-engine";

// ─── CSV row + import stats ───────────────────────────────────────────────

export interface StoreLeadsCsvRow {
  domain?: string;
  about_us_url?: string;
  average_product_price_usd?: string;
  categories?: string;
  city?: string;
  cluster_domains?: string;
  company_ids?: string;
  company_location?: string;
  contact_page_url?: string;
  country_code?: string;
  created?: string;
  description?: string;
  domain_url?: string;
  emails?: string;
  employee_count?: string;
  estimated_monthly_pageviews?: string;
  estimated_monthly_visits?: string;
  estimated_yearly_sales?: string;
  facebook?: string;
  instagram?: string;
  /** Present on newer StoreLeads CSV exports; absent on earlier ones. */
  merchant_name?: string;
  /** The <meta name="description"> tag — what appears in Google
   *  results. Often identical to `description` on Shopify stores
   *  but can diverge. Newer StoreLeads exports include it. */
  meta_description?: string;
  phones?: string;
  platform?: string;
  region?: string;
  state?: string;
  status?: string;
  street_address?: string;
  tiktok?: string;
  tiktok_followers?: string;
  youtube?: string;
  youtube_followers?: string;
}

export interface StoreLeadsImportStats {
  totalRows: number;
  /** Rows that resulted in a brand-new company insert. */
  created: number;
  /** Rows that matched an existing company by domain and filled in nulls. */
  mergedByDomain: number;
  /** Rows skipped because the same domain appeared earlier in the same file. */
  skippedDuplicate: number;
  /** Rows skipped because they had no usable domain at all. */
  skippedNoDomain: number;
  errors: Array<{ row: number; message: string }>;
  /** Distinct categories observed (for visibility in the import summary). */
  categoriesSeen: Record<string, number>;
  durationMs: number;
}

// ─── Normalisation helpers ────────────────────────────────────────────────

/**
 * Parse a StoreLeads currency string into integer cents. They format
 * yearly-sales as `"USD $250000"` (no decimals) and average-price as
 * `"USD $29.10"`. Both shapes resolve into integer cents (25000000,
 * 2910). Returns null on anything unparseable.
 */
function parseCurrencyToCents(raw: string | undefined | null): number | null {
  if (!raw) return null;
  // Strip currency code (e.g. "USD") and the $ sign, keep digits + dot.
  const m = raw.replace(/[A-Z]{3}/g, "").match(/(\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(",", "."));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function parseInt0(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const n = parseInt(String(raw).replace(/[, ]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

/** Pick the first non-empty value from a multi-value cell.
 *
 *  StoreLeads CSV exports use a mix of separators across columns:
 *    - emails:  comma OR semicolon
 *    - phones:  COLON ":"  ← discovered the hard way: company
 *                 edccbde1-0b8d-42b0-8ebc-dbbb248b1cd6 had its
 *                 phone stored as `+1 916-584-4540:+1 916-...`
 *                 because we weren't splitting on colon.
 *    - emails / urls also occasionally pipe-separated.
 *  Split on all common separators so the first-of-list logic
 *  actually picks one value instead of stuffing the whole
 *  concatenated string into a single column. */
function firstOf(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const parts = splitMulti(raw);
  return parts[0] ?? null;
}

/** Same split logic as firstOf, exported as a list — used by the
 *  cleanup pass to recover the additional values that got lost. */
export function splitMulti(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return String(raw)
    .split(/[,;:|\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Lowercase + trim domains for dedup keys. */
function normDomain(raw: string | undefined | null): string | null {
  if (!raw) return null;
  return extractDomain(String(raw));
}

// ─── Main importer ────────────────────────────────────────────────────────

export interface ImportOptions {
  /** Free-text label to record in `companies.source` (e.g. the CSV filename
   *  or a custom batch label). */
  sourceLabel?: string;
  /** Streamed progress callback. */
  onProgress?: (processed: number, total: number) => void;
}

export async function importStoreLeadsCsv(
  csvPath: string,
  options: ImportOptions = {},
): Promise<StoreLeadsImportStats> {
  const start = Date.now();
  const csv = fs.readFileSync(csvPath, "utf-8");
  const { data, errors: parseErrors } = Papa.parse<StoreLeadsCsvRow>(csv, {
    header: true,
    skipEmptyLines: true,
  });
  if (parseErrors.length > 0) {
    // Papa errors are non-fatal per-row; surface the first few as warnings.
    console.warn(
      `[storeleads-import] Papa parse warnings (${parseErrors.length}):`,
      parseErrors.slice(0, 5).map((e) => `${e.row}: ${e.message}`),
    );
  }

  const stats: StoreLeadsImportStats = {
    totalRows: data.length,
    created: 0,
    mergedByDomain: 0,
    skippedDuplicate: 0,
    skippedNoDomain: 0,
    errors: [],
    categoriesSeen: {},
    durationMs: 0,
  };
  const sourceLabel = options.sourceLabel ?? `storeleads_csv:${csvPath.split("/").pop()}`;
  const now = new Date().toISOString();

  // Track which domains we've seen in this run so a duplicate row in the
  // same CSV doesn't double-merge.
  const seenInRun = new Set<string>();

  // Prepared statements — much faster than per-row Drizzle.
  const selectByDomain = sqlite.prepare<[string]>(
    `SELECT * FROM companies WHERE domain = ? LIMIT 1`,
  );
  // We build the UPDATE dynamically per row (only filling NULLs); see merge() below.
  const insertNew = sqlite.prepare(
    `INSERT INTO companies (
       id, name, type, domain, website, phone, email,
       address, city, state, country,
       category, industry, status, source, source_type, source_query,
       storeleads_id, storeleads_last_synced_at,
       employee_count, estimated_monthly_visits, estimated_yearly_sales_cents,
       average_product_price_cents,
       facebook_url, instagram_url, tiktok_url, tiktok_followers,
       youtube_url, youtube_followers, contact_form_url,
       ecom_platform, description, meta_description,
       enriched_at, enrichment_source, enrichment_fetched_at,
       created_at, updated_at
     ) VALUES (
       ?, ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?, 'new', ?, 'storeleads', ?,
       ?, ?,
       ?, ?, ?,
       ?,
       ?, ?, ?, ?,
       ?, ?, ?,
       ?, ?, ?,
       ?, 'storeleads', ?,
       ?, ?
     )`,
  );

  const txn = sqlite.transaction(() => {
    let i = 0;
    for (const row of data) {
      i++;
      try {
        const domain = normDomain(row.domain || row.domain_url);
        if (!domain) {
          stats.skippedNoDomain++;
          continue;
        }
        if (seenInRun.has(domain)) {
          stats.skippedDuplicate++;
          continue;
        }
        seenInRun.add(domain);

        // Derive the shared field set from the CSV row.
        const fields = deriveFields(row, domain);
        if (fields.categories) {
          const c = fields.categories;
          stats.categoriesSeen[c] = (stats.categoriesSeen[c] ?? 0) + 1;
        }

        // Existing row → merge (fill nulls only); else insert.
        const existing = selectByDomain.get(domain) as Record<string, unknown> | undefined;
        if (existing) {
          mergeRow({
            id: existing.id as string,
            existing,
            fields,
            now,
          });
          stats.mergedByDomain++;
        } else {
          insertNew.run(
            crypto.randomUUID(),
            fields.merchantName,
            // catalog "type" enum; "online" is most accurate for a Shopify shop
            "online",
            domain,
            fields.website,
            fields.phone,
            fields.email,
            fields.address,
            fields.city,
            fields.state,
            fields.country,
            fields.categories,
            fields.industry,
            sourceLabel,
            fields.categories || null,
            fields.storeleadsId,
            now, // storeleads_last_synced_at
            fields.employeeCount,
            fields.estimatedMonthlyVisits,
            fields.estimatedYearlySalesCents,
            fields.averageProductPriceCents,
            fields.facebookUrl,
            fields.instagramUrl,
            fields.tiktokUrl,
            fields.tiktokFollowers,
            fields.youtubeUrl,
            fields.youtubeFollowers,
            fields.contactFormUrl,
            fields.ecomPlatform,
            fields.description,
            fields.metaDescription,
            now, // enriched_at
            now, // enrichment_fetched_at
            now, // created_at
            now, // updated_at
          );
          stats.created++;
        }

        if (options.onProgress && i % 250 === 0) {
          options.onProgress(i, stats.totalRows);
        }
      } catch (e) {
        stats.errors.push({
          row: i,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
  });
  txn();

  stats.durationMs = Date.now() - start;
  return stats;
}

// ─── Field derivation + merge ─────────────────────────────────────────────

interface DerivedFields {
  merchantName: string;
  website: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  categories: string | null;
  industry: string | null;
  storeleadsId: string | null;
  employeeCount: number | null;
  estimatedMonthlyVisits: number | null;
  estimatedYearlySalesCents: number | null;
  averageProductPriceCents: number | null;
  facebookUrl: string | null;
  instagramUrl: string | null;
  tiktokUrl: string | null;
  tiktokFollowers: number | null;
  youtubeUrl: string | null;
  youtubeFollowers: number | null;
  contactFormUrl: string | null;
  ecomPlatform: string | null;
  description: string | null;
  metaDescription: string | null;
}

function deriveFields(row: StoreLeadsCsvRow, domain: string): DerivedFields {
  const categories = row.categories?.trim() || null;
  // StoreLeads gives the categories as a slash-delimited path
  // ("/Apparel/Women's Clothing"). Use the leaf segment as the
  // industry bucket so it slots into our existing industry filter UI.
  const industry = (() => {
    if (!categories) return null;
    const seg = categories
      .split("/")
      .map((s) => s.trim())
      .filter(Boolean)
      .pop();
    return seg ?? null;
  })();

  return {
    // merchant_name is on the newer CSV exports (the one with the
    // column header literally `merchant_name`). Older exports omit it,
    // so fall back to the domain. The merge step below knows to
    // overwrite a domain-named row if a real merchant_name lands later.
    merchantName: row.merchant_name?.trim() || domain,
    website: row.domain_url?.trim() || `https://${domain}`,
    phone: firstOf(row.phones),
    email: (firstOf(row.emails) || "").toLowerCase() || null,
    address: row.street_address?.trim() || null,
    city: row.city?.trim() || null,
    state: row.state?.trim() || null,
    country: row.country_code?.trim() || null,
    categories,
    industry,
    storeleadsId: firstOf(row.company_ids),
    employeeCount: parseInt0(row.employee_count),
    estimatedMonthlyVisits: parseInt0(row.estimated_monthly_visits),
    estimatedYearlySalesCents: parseCurrencyToCents(row.estimated_yearly_sales),
    averageProductPriceCents: parseCurrencyToCents(row.average_product_price_usd),
    facebookUrl: row.facebook?.trim() || null,
    instagramUrl: row.instagram?.trim() || null,
    tiktokUrl: row.tiktok?.trim() || null,
    tiktokFollowers: parseInt0(row.tiktok_followers),
    youtubeUrl: row.youtube?.trim() || null,
    youtubeFollowers: parseInt0(row.youtube_followers),
    contactFormUrl: row.contact_page_url?.trim() || null,
    ecomPlatform: row.platform?.trim().toLowerCase() || null,
    description: row.description?.trim() || null,
    metaDescription: row.meta_description?.trim() || null,
  };
}

/**
 * Fill any null column on the existing row with the StoreLeads value.
 * Always stamp storeleads_last_synced_at + updated_at. Never overwrite
 * a non-null hand-edited value.
 */
function mergeRow(opts: {
  id: string;
  existing: Record<string, unknown>;
  fields: DerivedFields;
  now: string;
}) {
  const { id, existing, fields, now } = opts;
  // (csv column on companies, value to fill if null)
  const fillCandidates: Array<[string, unknown]> = [
    ["website", fields.website],
    ["phone", fields.phone],
    ["email", fields.email],
    ["address", fields.address],
    ["city", fields.city],
    ["state", fields.state],
    ["country", fields.country],
    ["category", fields.categories],
    ["industry", fields.industry],
    ["storeleads_id", fields.storeleadsId],
    ["employee_count", fields.employeeCount],
    ["estimated_monthly_visits", fields.estimatedMonthlyVisits],
    ["estimated_yearly_sales_cents", fields.estimatedYearlySalesCents],
    ["average_product_price_cents", fields.averageProductPriceCents],
    ["facebook_url", fields.facebookUrl],
    ["instagram_url", fields.instagramUrl],
    ["tiktok_url", fields.tiktokUrl],
    ["tiktok_followers", fields.tiktokFollowers],
    ["youtube_url", fields.youtubeUrl],
    ["youtube_followers", fields.youtubeFollowers],
    ["contact_form_url", fields.contactFormUrl],
    ["ecom_platform", fields.ecomPlatform],
    ["description", fields.description],
    ["meta_description", fields.metaDescription],
  ];

  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [col, val] of fillCandidates) {
    if (val == null) continue;
    // Only fill if existing is null/empty-string — never clobber.
    const cur = existing[col];
    if (cur != null && cur !== "") continue;
    sets.push(`${col} = ?`);
    vals.push(val);
  }

  // Special-case the `name` column: an earlier import of the same row
  // (when the CSV didn't carry merchant_name) defaulted the name to
  // the bare domain. If the CSV now ships a real merchant_name AND the
  // current name in the DB is just the domain, replace it. We never
  // clobber a hand-edited name (anything other than the domain literal).
  const existingName = (existing.name as string | null | undefined) ?? "";
  const existingDomain = (existing.domain as string | null | undefined) ?? "";
  const namesEqual = (a: string, b: string) =>
    a.trim().toLowerCase() === b.trim().toLowerCase();
  if (
    fields.merchantName &&
    !namesEqual(fields.merchantName, existingDomain) &&
    (existingName === "" || namesEqual(existingName, existingDomain))
  ) {
    sets.push("name = ?");
    vals.push(fields.merchantName);
  }

  // Always-write fields: timestamp + updated_at.
  sets.push("storeleads_last_synced_at = ?");
  vals.push(now);
  sets.push("updated_at = ?");
  vals.push(now);

  if (sets.length === 0) return;
  vals.push(id);
  sqlite.prepare(`UPDATE companies SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}
