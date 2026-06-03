/**
 * Local one-shot enrichment: take a CSV of leads (with a Website
 * column), look up each via StoreLeads, and write an enriched CSV
 * with everything useful for category/lookalike analysis —
 * categories, industry, product_count, avg/min/max price,
 * yearly sales, visits, employee count, description, meta title,
 * platform, contact info, social URLs.
 *
 * Usage:
 *   STORELEADS_API_KEY=... npx tsx scripts/storeleads-enrich-csv.ts \
 *     "<input.csv>" "<output.csv>"
 *
 * Defaults the output path to "<input>.enriched.csv" next to the
 * input if you don't pass one.
 *
 * Input must have a `Website` column. Other columns (Contact Name,
 * Store Name, etc.) are passed through verbatim so you can match
 * the enriched row back to the source.
 */

import * as fs from "fs";
import * as path from "path";
import * as Papa from "papaparse";
import {
  bulkGetStoresByDomain,
  isConfigured as storeleadsConfigured,
  type StoreLeadsDomain,
} from "../src/modules/sales/lib/storeleads/client";

// ── Junk-domain blocklist ──────────────────────────────────────────────────
// Mirror of the enrich-no-email route's list. Sending a Facebook /
// Yelp / generic-email URL to StoreLeads is guaranteed to miss, so
// strip them before the API call.
const JUNK_DOMAINS = new Set([
  "facebook.com", "fb.com", "m.facebook.com",
  "instagram.com",
  "twitter.com", "x.com",
  "linkedin.com",
  "pinterest.com",
  "tiktok.com",
  "youtube.com", "youtu.be",
  "reddit.com",
  "threads.net",
  "yelp.com", "m.yelp.com", "biz.yelp.com",
  "yellowpages.com", "yp.com",
  "foursquare.com",
  "mapquest.com",
  "tripadvisor.com",
  "google.com", "maps.google.com",
  "bing.com",
  "bizapedia.com",
  "dnb.com",
  "manta.com",
  "bbb.org",
  "nextdoor.com",
  "wixsite.com", "wix.com",
  "weebly.com",
  "godaddysites.com",
  "squarespace.com",
  "webador.com",
  "jimdosite.com",
  "site123.me",
  "yahoo.com",
  "gmail.com",
  "hotmail.com",
  "wordpress.com",
  "blogspot.com",
]);

// ── Domain normalisation ───────────────────────────────────────────────────
/** Turn whatever the CSV gave us ("https://www.foo.com/about/", "foo.com",
 *  "www.foo.com") into a bare apex `foo.com`. Returns null if nothing
 *  usable. */
function normalizeDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = String(raw).trim().toLowerCase();
  if (!s) return null;
  // Strip scheme
  s = s.replace(/^https?:\/\//, "");
  // Strip path / query / hash
  s = s.split("/")[0].split("?")[0].split("#")[0];
  // Strip leading www.
  s = s.replace(/^www\./, "");
  // Bail on anything that doesn't look like a domain
  if (!s.includes(".")) return null;
  if (s.includes(" ")) return null;
  return s;
}

function isJunkDomain(d: string): boolean {
  return JUNK_DOMAINS.has(d);
}

// ── Field flattening ────────────────────────────────────────────────────────
/** Helper to read a contact_info entry by type. */
function firstByType(sl: StoreLeadsDomain, type: string): string | null {
  const ci = (sl as Record<string, unknown>).contact_info as
    | Array<{ type?: string; value?: string; followers?: number }>
    | undefined;
  if (!Array.isArray(ci)) return null;
  return ci.find((e) => e.type?.toLowerCase() === type)?.value ?? null;
}
function followersByType(sl: StoreLeadsDomain, type: string): number | null {
  const ci = (sl as Record<string, unknown>).contact_info as
    | Array<{ type?: string; value?: string; followers?: number }>
    | undefined;
  if (!Array.isArray(ci)) return null;
  return ci.find((e) => e.type?.toLowerCase() === type)?.followers ?? null;
}

/** Flatten the StoreLeads response into a single row for the CSV. */
function flatten(sl: StoreLeadsDomain): Record<string, unknown> {
  const r = sl as unknown as Record<string, unknown>;
  return {
    sl_merchant_name: r.merchant_name ?? null,
    sl_title: r.title ?? null,
    sl_description: r.description ?? null,
    sl_platform: r.platform ?? null,
    sl_platform_domain: r.platform_domain ?? null,
    sl_categories: Array.isArray(sl.categories) ? sl.categories.join(" | ") : null,
    sl_industry: Array.isArray(sl.categories) && sl.categories.length
      ? sl.categories[0].split("/").filter(Boolean).pop() ?? null
      : null,
    sl_country: sl.country_code ?? null,
    sl_state: sl.state ?? null,
    sl_city: sl.city ?? null,
    sl_location: r.location ?? null,
    sl_employee_count: sl.employee_count ?? null,
    sl_product_count: r.product_count ?? null,
    sl_variant_count: r.variant_count ?? null,
    sl_collection_count: r.collection_count ?? null,
    sl_vendor_count: r.vendor_count ?? null,
    // Prices come back in USD cents on this API
    sl_avg_price_usd: typeof r.avg_price_usd === "number" ? (r.avg_price_usd as number) / 100 : null,
    sl_min_price_usd: typeof r.min_price_usd === "number" ? (r.min_price_usd as number) / 100 : null,
    sl_max_price_usd: typeof r.max_price_usd === "number" ? (r.max_price_usd as number) / 100 : null,
    // estimated_sales / estimated_sales_yearly come in USD cents from
    // the API (verified against Berriez: 118894764 → $1.19M/yr, which
    // matches the prose stat StoreLeads' UI shows). Convert to dollars
    // for human-readable analysis.
    sl_estimated_sales_monthly_usd: typeof sl.estimated_sales === "number" ? sl.estimated_sales / 100 : null,
    sl_estimated_sales_yearly_usd: typeof sl.estimated_sales_yearly === "number" ? sl.estimated_sales_yearly / 100 : null,
    sl_estimated_visits: sl.estimated_visits ?? null,
    sl_estimated_page_views: sl.estimated_page_views ?? null,
    sl_monthly_app_spend_usd: r.monthly_app_spend ?? null,
    sl_rank: r.rank ?? null,
    sl_rank_percentile: r.rank_percentile ?? null,
    sl_platform_rank: r.platform_rank ?? null,
    sl_apps_count: Array.isArray(r.apps) ? (r.apps as unknown[]).length : 0,
    sl_technologies_count: Array.isArray(r.technologies) ? (r.technologies as unknown[]).length : 0,
    sl_features: Array.isArray(r.features) ? (r.features as string[]).join(" | ") : null,
    sl_email: firstByType(sl, "email"),
    sl_phone: firstByType(sl, "phone"),
    sl_facebook: firstByType(sl, "facebook"),
    sl_instagram: firstByType(sl, "instagram"),
    sl_instagram_followers: followersByType(sl, "instagram"),
    sl_tiktok: firstByType(sl, "tiktok"),
    sl_tiktok_followers: followersByType(sl, "tiktok"),
    sl_youtube: firstByType(sl, "youtube"),
    sl_youtube_followers: followersByType(sl, "youtube"),
    sl_about_us_url: r.about_us ?? null,
    sl_last_updated_at: r.last_updated_at ?? null,
    sl_currency: sl.currency_code ?? null,
    sl_language: sl.language_code ?? null,
  };
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3] || inputPath?.replace(/\.csv$/i, ".enriched.csv") || "enriched.csv";

  if (!inputPath) {
    console.error("Usage: tsx scripts/storeleads-enrich-csv.ts <input.csv> [output.csv]");
    process.exit(1);
  }
  if (!fs.existsSync(inputPath)) {
    console.error(`Input not found: ${inputPath}`);
    process.exit(1);
  }
  if (!storeleadsConfigured()) {
    console.error("STORELEADS_API_KEY not set in env");
    process.exit(1);
  }

  console.log(`Reading: ${inputPath}`);
  const csvText = fs.readFileSync(inputPath, "utf8");
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true, skipEmptyLines: true,
  });
  if (parsed.errors.length) {
    console.warn(`CSV parse warnings: ${parsed.errors.slice(0, 3).map((e) => e.message).join("; ")}${parsed.errors.length > 3 ? ` (+${parsed.errors.length - 3})` : ""}`);
  }
  const rows = parsed.data;
  console.log(`Loaded ${rows.length} rows`);

  // Pick the website column tolerantly — case + spacing variants.
  const websiteKey = Object.keys(rows[0] ?? {}).find(
    (k) => k.trim().toLowerCase() === "website",
  );
  if (!websiteKey) {
    console.error('Could not find a "Website" column in the CSV.');
    process.exit(1);
  }

  // Build the unique domain set (dedupe across rows that point at the
  // same store, e.g. multiple contacts at one boutique). Keep the
  // first row index against each domain so we can write enriched
  // fields back without doing N^2 lookups.
  const domainToRows = new Map<string, number[]>();
  const rowDomain: Array<string | null> = [];
  const rowSkipReason: Array<string | null> = [];

  for (let i = 0; i < rows.length; i++) {
    const w = rows[i][websiteKey];
    const d = normalizeDomain(w);
    if (!d) {
      rowDomain.push(null);
      rowSkipReason.push("no_website");
      continue;
    }
    if (isJunkDomain(d)) {
      rowDomain.push(null);
      rowSkipReason.push(`junk:${d}`);
      continue;
    }
    rowDomain.push(d);
    rowSkipReason.push(null);
    if (!domainToRows.has(d)) domainToRows.set(d, []);
    domainToRows.get(d)!.push(i);
  }

  const uniqueDomains = Array.from(domainToRows.keys());
  console.log(`Domains:`);
  console.log(`  unique to look up: ${uniqueDomains.length}`);
  console.log(`  junk skipped:      ${rowSkipReason.filter((r) => r?.startsWith("junk:")).length}`);
  console.log(`  no-website skipped:${rowSkipReason.filter((r) => r === "no_website").length}`);

  // Bulk lookup. 100 per call, ~250ms pacing built into the client.
  // We do our own simple loop here so we can show progress.
  const BATCH = 100;
  const enrichmentByDomain = new Map<string, StoreLeadsDomain | null>();
  for (let i = 0; i < uniqueDomains.length; i += BATCH) {
    const chunk = uniqueDomains.slice(i, i + BATCH);
    const t0 = Date.now();
    try {
      const map = await bulkGetStoresByDomain(chunk, { followRedirects: true });
      for (const d of chunk) {
        enrichmentByDomain.set(d, map[d] ?? null);
      }
      const found = chunk.filter((d) => map[d]).length;
      console.log(
        `  [${i + chunk.length}/${uniqueDomains.length}] ` +
        `batch hit ${found}/${chunk.length} in ${Date.now() - t0}ms`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`  [${i + chunk.length}/${uniqueDomains.length}] batch error: ${msg}`);
      for (const d of chunk) enrichmentByDomain.set(d, null);
    }
  }

  const totalFound = Array.from(enrichmentByDomain.values()).filter(Boolean).length;
  console.log(`\nEnrichment hit rate: ${totalFound}/${uniqueDomains.length} ` +
    `(${(100 * totalFound / Math.max(1, uniqueDomains.length)).toFixed(1)}%)`);

  // Build output rows. Preserve every input column, then append the
  // enrichment columns + a meta column showing what happened to
  // each row (enriched, not_found, junk, no_website).
  const outRows = rows.map((row, i) => {
    const d = rowDomain[i];
    const skip = rowSkipReason[i];
    const sl = d ? enrichmentByDomain.get(d) : null;
    const enrichmentCols: Record<string, unknown> = sl
      ? flatten(sl)
      : Object.fromEntries(SAMPLE_ENRICHED_COLS.map((c) => [c, null]));
    return {
      ...row,
      _normalized_domain: d ?? "",
      _enrichment_status: sl
        ? "enriched"
        : d
        ? "not_found_in_storeleads"
        : skip ?? "no_website",
      ...enrichmentCols,
    };
  });

  const outCsv = Papa.unparse(outRows);
  fs.writeFileSync(outputPath, outCsv);
  console.log(`\nWrote ${outRows.length} rows → ${path.resolve(outputPath)}`);
  console.log(`Open it in Sheets / Numbers and pivot on sl_industry or sl_categories.`);
}

/** Ensure every output row has the same column set even when no
 *  enrichment landed — Papa.unparse uses the FIRST row's keys for
 *  the header line, so we pin a canonical column list. */
const SAMPLE_ENRICHED_COLS = [
  "sl_merchant_name", "sl_title", "sl_description", "sl_platform",
  "sl_platform_domain", "sl_categories", "sl_industry",
  "sl_country", "sl_state", "sl_city", "sl_location",
  "sl_employee_count",
  "sl_product_count", "sl_variant_count", "sl_collection_count", "sl_vendor_count",
  "sl_avg_price_usd", "sl_min_price_usd", "sl_max_price_usd",
  "sl_estimated_sales_monthly_usd", "sl_estimated_sales_yearly_usd",
  "sl_estimated_visits", "sl_estimated_page_views",
  "sl_monthly_app_spend_usd",
  "sl_rank", "sl_rank_percentile", "sl_platform_rank",
  "sl_apps_count", "sl_technologies_count", "sl_features",
  "sl_email", "sl_phone",
  "sl_facebook", "sl_instagram", "sl_instagram_followers",
  "sl_tiktok", "sl_tiktok_followers",
  "sl_youtube", "sl_youtube_followers",
  "sl_about_us_url", "sl_last_updated_at",
  "sl_currency", "sl_language",
];

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
