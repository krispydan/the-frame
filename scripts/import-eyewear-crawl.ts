/**
 * Import the Shopify eyewear crawl output into The Frame as new leads.
 *
 * Reads three local CSVs from ~/Downloads/:
 *   - sunglasses-products.csv   (89K matched product rows from the crawl)
 *   - sunglasses-state.jsonl    (per-domain crawl outcome: has/no/error)
 *   - apparel-filtered.csv      (143K firmographic rows — source cohort)
 *
 * Produces two cohorts in `companies`:
 *
 *   - source_type='shopify_crawl', source_query='eyewear_inventory_v1_2026-06'
 *     The ~14,567 stores carrying sunglasses or reading glasses.
 *     Populated with per-store eyewear aggregates (top brand, price
 *     range, sample titles, top 3 competitor brands).
 *
 *   - source_type='shopify_crawl', source_query='apparel_no_eyewear_v1_2026-06'
 *     The ~62,263 apparel boutiques that have no eyewear today —
 *     secondary cohort for future campaign angles (vintage,
 *     gifting, lifestyle).
 *
 * For each new row, appends segmentation tags to companies.tags so
 * the Smart Lists UI can slice by price tier / brand concentration /
 * category mix / top brand. Excludes the AJ Morgan cohort (already
 * being contacted separately).
 *
 * After upsert, fires the existing rule-based ICP classifier
 * (icpClassifierHandler) on the new rows so they get tier scoring.
 *
 * Usage:
 *   npx tsx scripts/import-eyewear-crawl.ts \
 *     [--dry-run] [--limit N] [--no-classifier]
 *
 * Defaults to dry-run=false. --limit caps the number of NEW rows
 * created (existing-row merges still run). --no-classifier skips
 * the final ICP scoring pass (useful for fast iteration during
 * import development).
 *
 * Idempotent: re-running upserts new rows + fills NULLs on existing
 * rows. Segment tags appended without duplicates.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as Papa from "papaparse";
import { sqlite } from "../src/lib/db";
import { icpClassifierHandler } from "../src/modules/sales/agents/icp-classifier";

// ── Config knobs ───────────────────────────────────────────────────────────
const DL = path.join(os.homedir(), "Downloads");
const PRODUCTS_CSV = path.join(DL, "sunglasses-products.csv");
const STATE_LOG = path.join(DL, "sunglasses-state.jsonl");
const COHORT_CSV = path.join(DL, "apparel-filtered.csv");

const EYEWEAR_SOURCE_QUERY = "eyewear_inventory_v1_2026-06";
const NO_EYEWEAR_SOURCE_QUERY = "apparel_no_eyewear_v1_2026-06";
const SOURCE_LABEL_EYEWEAR = "shopify_crawl:eyewear_v1";
const SOURCE_LABEL_NO_EYEWEAR = "shopify_crawl:apparel_no_eyewear_v1";

// ── Vendor filters — must match sunglasses-report.py to stay aligned ──
const NOISE_VENDORS = new Set([
  "printify", "trendsi", "my store", "mysite", "default title",
  "shopify", "", "unknown", "vendor",
]);
function isRealBrand(vendor: string | null | undefined): boolean {
  if (!vendor) return false;
  return !NOISE_VENDORS.has(vendor.trim().toLowerCase());
}

/** AJ Morgan spelling-variant matcher — same logic as
 *  sunglasses-report.py's is_focus_brand(). Excludes Niven Morgan,
 *  Morgan the Label, etc. */
function isAjMorgan(vendor: string | null | undefined): boolean {
  if (!vendor) return false;
  const v = vendor.trim().toLowerCase();
  if (!v.includes("morgan")) return false;
  if ([
    "niven morgan", "morgan the label", "morgan & co", "morgan & co.",
    "morgan stewart", "morgan parker",
  ].includes(v)) return false;
  if (v.includes("aj ") || v.includes("a.j.") || v.includes("a j ")) return true;
  return false;
}

// ── Types ───────────────────────────────────────────────────────────────────
interface ProductRow {
  domain: string;
  store_name: string;
  product_id?: string;
  product_title: string;
  product_url: string;
  product_handle: string;
  product_vendor: string;
  product_type: string;
  product_price: string;
  product_image: string;
  product_category: string; // "sunglasses" | "reading_glasses"
  match_reason: string;
}

interface CohortRow {
  domain: string;
  merchant_name?: string;
  about_us_url?: string;
  city?: string;
  country_code?: string;
  emails?: string;
  phones?: string;
  estimated_yearly_sales?: string;
  estimated_monthly_visits?: string;
  estimated_monthly_sales?: string;
  facebook?: string;
  instagram?: string;
  meta_description?: string;
  description?: string;
  platform?: string;
  state?: string;
  status?: string;
  zip?: string;
  street_address?: string;
  categories?: string;
  contact_page_url?: string;
  source_label?: string;
}

interface StateLine {
  domain: string;
  status: "has_sunglasses" | "no_sunglasses" | "error" | "skipped_not_shopify";
}

/** Per-store rollup for the eyewear cohort. Built up by walking the
 *  product CSV and joining domain -> products. */
interface EyewearAggregate {
  domain: string;
  store_name: string;
  vendor_counts: Map<string, number>;
  prices: number[];
  categories: Set<"sunglasses" | "reading_glasses">;
  sample_titles: string[];   // first 3 distinct titles encountered
  total_sku_count: number;
  has_aj_morgan: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function normDomain(d: string): string {
  return String(d || "").trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "");
}

function parseFloatLoose(s: string | undefined | null): number | null {
  if (!s) return null;
  const cleaned = String(s).replace(/[^\d.]/g, "");
  if (!cleaned || cleaned === ".") return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseCurrencyToCents(s: string | undefined | null): number | null {
  const n = parseFloatLoose(s);
  return n === null ? null : Math.round(n * 100);
}

function pickFirst(s: string | undefined | null): string | null {
  if (!s) return null;
  // StoreLeads multi-cell separators: colon (phones), comma/semicolon
  // (emails), pipe, newline. Same logic as the storeleads importer.
  const first = String(s).split(/[,;:|\n]+/).map((x) => x.trim()).find(Boolean);
  return first || null;
}

function fmtPriceRange(prices: number[]): string | null {
  if (prices.length === 0) return null;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  if (min === max) return `$${min.toFixed(0)}`;
  return `$${min.toFixed(0)}–$${max.toFixed(0)}`;
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function priceTierTag(medianPrice: number | null): string {
  if (medianPrice === null) return "eyewear_tier_unknown";
  if (medianPrice < 20) return "eyewear_tier_sub20";
  if (medianPrice < 50) return "eyewear_tier_entry";
  if (medianPrice < 100) return "eyewear_tier_mid";
  if (medianPrice < 200) return "eyewear_tier_premium";
  return "eyewear_tier_luxury";
}

function isPriceTooHigh(tier: string): boolean {
  return tier === "eyewear_tier_premium" || tier === "eyewear_tier_luxury";
}

function concentrationTag(vendorCounts: Map<string, number>): string | null {
  let total = 0;
  let top = 0;
  for (const c of vendorCounts.values()) {
    total += c;
    if (c > top) top = c;
  }
  if (total < 5) return null; // not enough signal to score
  const share = top / total;
  if (share > 0.8) return "eyewear_loyalist";
  if (share > 0.4) return "eyewear_anchor_brand";
  return "eyewear_multi_brand_assortment";
}

function brandSlug(brand: string): string {
  return brand.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

// ── Load + group products ───────────────────────────────────────────────────
function loadProducts(): Map<string, ProductRow[]> {
  const csvText = fs.readFileSync(PRODUCTS_CSV, "utf8");
  const parsed = Papa.parse<ProductRow>(csvText, {
    header: true, skipEmptyLines: true,
  });
  const byDomain = new Map<string, ProductRow[]>();
  for (const row of parsed.data) {
    const d = normDomain(row.domain);
    if (!d) continue;
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d)!.push(row);
  }
  return byDomain;
}

/** Roll up a domain's product rows into a single EyewearAggregate. */
function rollUp(domain: string, products: ProductRow[]): EyewearAggregate {
  const agg: EyewearAggregate = {
    domain,
    store_name: products[0]?.store_name || domain,
    vendor_counts: new Map(),
    prices: [],
    categories: new Set(),
    sample_titles: [],
    total_sku_count: products.length,
    has_aj_morgan: false,
  };
  const seenTitles = new Set<string>();
  for (const p of products) {
    const v = (p.product_vendor || "").trim();
    if (isRealBrand(v)) {
      agg.vendor_counts.set(v, (agg.vendor_counts.get(v) ?? 0) + 1);
    }
    if (isAjMorgan(v)) agg.has_aj_morgan = true;

    const price = parseFloatLoose(p.product_price);
    if (price !== null && price > 0) agg.prices.push(price);

    if (p.product_category === "sunglasses" || p.product_category === "reading_glasses") {
      agg.categories.add(p.product_category);
    } else if (!p.product_category) {
      // pre-categorisation rows default to sunglasses (the original
      // detection target before reading-glasses landed)
      agg.categories.add("sunglasses");
    }

    if (p.product_title && agg.sample_titles.length < 3 && !seenTitles.has(p.product_title)) {
      seenTitles.add(p.product_title);
      agg.sample_titles.push(p.product_title);
    }
  }
  return agg;
}

// ── Load cohort firmographics ──────────────────────────────────────────────
function loadCohort(): Map<string, CohortRow> {
  const csvText = fs.readFileSync(COHORT_CSV, "utf8");
  const parsed = Papa.parse<CohortRow>(csvText, {
    header: true, skipEmptyLines: true,
  });
  const byDomain = new Map<string, CohortRow>();
  for (const row of parsed.data) {
    const d = normDomain(row.domain);
    if (!d) continue;
    byDomain.set(d, row);
  }
  return byDomain;
}

// ── Load state log → settled-domain → outcome ───────────────────────────────
function loadState(): Map<string, "has_sunglasses" | "no_sunglasses" | "error"> {
  const out = new Map<string, "has_sunglasses" | "no_sunglasses" | "error">();
  if (!fs.existsSync(STATE_LOG)) return out;
  for (const line of fs.readFileSync(STATE_LOG, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as StateLine;
      if (obj.domain) out.set(obj.domain, obj.status as "has_sunglasses" | "no_sunglasses" | "error");
    } catch { /* skip bad lines */ }
  }
  return out;
}

// ── Build the segment tags for a single eyewear lead ───────────────────────
function eyewearTags(agg: EyewearAggregate, priceTierTagValue: string): string[] {
  const tags: string[] = ["eyewear_cohort", "crawl_v1"];

  // Category mix
  if (agg.categories.has("sunglasses") && agg.categories.has("reading_glasses")) {
    tags.push("carries_both");
  } else if (agg.categories.has("sunglasses")) {
    tags.push("carries_sunglasses");
  } else if (agg.categories.has("reading_glasses")) {
    tags.push("carries_reading_glasses");
  }

  // Price tier
  tags.push(priceTierTagValue);
  if (isPriceTooHigh(priceTierTagValue)) {
    tags.push("eyewear_price_too_high");
  }

  // Brand concentration (only when ≥5 SKUs)
  const conc = concentrationTag(agg.vendor_counts);
  if (conc) tags.push(conc);

  // Top brand bucket — only for the brand with the most SKUs at THIS
  // store, slugged. Lets the UI filter "stores carrying RAEN" quickly.
  const sortedVendors = Array.from(agg.vendor_counts.entries())
    .sort((a, b) => b[1] - a[1]);
  if (sortedVendors.length > 0) {
    tags.push(`carries_${brandSlug(sortedVendors[0][0])}`);
  }

  return tags;
}

function noEyewearTags(cohort: CohortRow): string[] {
  const tags: string[] = ["apparel_no_eyewear_v1", "crawl_v1"];
  // Industry leaf — last segment of the StoreLeads category path.
  // "/Apparel/Vintage" → "vintage", "/Gifts" → "gifts", etc.
  // Lower-case + slugged for tag stability.
  if (cohort.categories) {
    for (const path of cohort.categories.split(/[:;]/)) {
      const leaf = path.split("/").map((s) => s.trim()).filter(Boolean).pop();
      if (leaf) {
        tags.push(`industry_${leaf.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")}`);
        break; // primary leaf only — keep tags concise
      }
    }
  }
  return tags;
}

// ── Upsert flow ─────────────────────────────────────────────────────────────
interface ImportStats {
  inserted: number;
  mergedExisting: number;
  skippedNoDomain: number;
  skippedAjMorgan: number;
  skippedNoCohort: number;
  skippedErrorState: number;
  durationMs: number;
}

interface UpsertContext {
  now: string;
  sourceQuery: string;
  sourceLabel: string;
  tagsForRow: string[];
  // Eyewear-specific aggregates — null for the no-eyewear cohort.
  topBrand: string | null;
  eyewearCategories: string | null;
  eyewearSkuCount: number | null;
  eyewearPriceRange: string | null;
  eyewearPriceMedianCents: number | null;
  eyewearTopCompetitors: string | null;
  eyewearSampleTitles: string | null;
}

const selectByDomain = sqlite.prepare<[string]>(
  `SELECT id, status, tags FROM companies WHERE domain = ? LIMIT 1`,
);

const insertNew = sqlite.prepare(
  `INSERT INTO companies (
     id, name, type, domain, website, phone, email,
     address, city, state, country, status,
     source, source_type, source_query,
     description, meta_description,
     ecom_platform, estimated_yearly_sales_cents, estimated_monthly_visits,
     facebook_url, instagram_url,
     top_brand, eyewear_categories, eyewear_sku_count,
     eyewear_price_range, eyewear_price_median_cents,
     eyewear_top_competitors, eyewear_sample_titles,
     tags, created_at, updated_at
   ) VALUES (
     ?, ?, 'online', ?, ?, ?, ?,
     ?, ?, ?, ?, 'new',
     ?, 'shopify_crawl', ?,
     ?, ?,
     ?, ?, ?,
     ?, ?,
     ?, ?, ?,
     ?, ?,
     ?, ?,
     ?, ?, ?
   )`,
);

const mergeExisting = sqlite.prepare(
  `UPDATE companies
      SET name              = COALESCE(name, ?),
          phone             = COALESCE(phone, ?),
          email             = COALESCE(email, ?),
          city              = COALESCE(city, ?),
          state             = COALESCE(state, ?),
          country           = COALESCE(country, ?),
          description       = COALESCE(description, ?),
          meta_description  = COALESCE(meta_description, ?),
          ecom_platform     = COALESCE(ecom_platform, ?),
          estimated_yearly_sales_cents = COALESCE(estimated_yearly_sales_cents, ?),
          estimated_monthly_visits     = COALESCE(estimated_monthly_visits, ?),
          facebook_url      = COALESCE(facebook_url, ?),
          instagram_url     = COALESCE(instagram_url, ?),
          -- Eyewear aggregates: COALESCE so a no-eyewear cohort
          -- re-pass doesn't blow away an earlier eyewear-cohort
          -- aggregate.
          top_brand                    = COALESCE(top_brand, ?),
          eyewear_categories           = COALESCE(eyewear_categories, ?),
          eyewear_sku_count            = COALESCE(eyewear_sku_count, ?),
          eyewear_price_range          = COALESCE(eyewear_price_range, ?),
          eyewear_price_median_cents   = COALESCE(eyewear_price_median_cents, ?),
          eyewear_top_competitors      = COALESCE(eyewear_top_competitors, ?),
          eyewear_sample_titles        = COALESCE(eyewear_sample_titles, ?),
          tags              = ?,
          updated_at        = ?
    WHERE id = ?`,
);

/** Merge a new tag set into an existing JSON-array tags column.
 *  Returns the JSON-stringified deduped union. */
function mergeTags(existingJson: string | null, newTags: string[]): string {
  let existing: string[] = [];
  if (existingJson) {
    try {
      const parsed = JSON.parse(existingJson);
      if (Array.isArray(parsed)) existing = parsed.map(String);
    } catch { /* preserve as empty */ }
  }
  const set = new Set<string>([...existing, ...newTags]);
  return JSON.stringify(Array.from(set));
}

function upsert(
  domain: string,
  cohort: CohortRow,
  ctx: UpsertContext,
): { created: boolean; companyId: string } {
  const existing = selectByDomain.get(domain) as
    | { id: string; status: string; tags: string | null } | undefined;

  const mergedTags = mergeTags(existing?.tags ?? null, ctx.tagsForRow);
  const merchantName = (cohort.merchant_name && cohort.merchant_name.trim())
    || domain;
  const website = `https://${domain}`;
  const phone = pickFirst(cohort.phones);
  const email = pickFirst(cohort.emails);
  const address = (cohort.street_address || "").trim() || null;
  const city = (cohort.city || "").trim() || null;
  // The state column on StoreLeads' newer CSV exports is actually the
  // store-status flag ("Active"); the geographic state is in the
  // `region` field (when populated) or has to be inferred. We persist
  // whatever's in state for backwards-compat, but downstream geo
  // reports should treat it cautiously.
  const cohortState = (cohort.state || "").trim();
  const state = cohortState && cohortState !== "Active" ? cohortState : null;
  const country = (cohort.country_code || "").trim() || null;
  const description = (cohort.description || "").trim() || null;
  const metaDescription = (cohort.meta_description || "").trim() || null;
  const ecomPlatform = (cohort.platform || "").trim().toLowerCase() || null;
  const yearlySalesCents = parseCurrencyToCents(cohort.estimated_yearly_sales);
  const monthlyVisits = parseFloatLoose(cohort.estimated_monthly_visits);
  const facebookUrl = pickFirst(cohort.facebook);
  const instagramUrl = pickFirst(cohort.instagram);

  if (existing) {
    mergeExisting.run(
      merchantName, phone, email, city, state, country,
      description, metaDescription, ecomPlatform,
      yearlySalesCents,
      monthlyVisits === null ? null : Math.round(monthlyVisits),
      facebookUrl, instagramUrl,
      ctx.topBrand, ctx.eyewearCategories, ctx.eyewearSkuCount,
      ctx.eyewearPriceRange, ctx.eyewearPriceMedianCents,
      ctx.eyewearTopCompetitors, ctx.eyewearSampleTitles,
      mergedTags, ctx.now, existing.id,
    );
    return { created: false, companyId: existing.id };
  }

  const id = crypto.randomUUID();
  insertNew.run(
    id, merchantName, domain, website, phone, email,
    address, city, state, country,
    ctx.sourceLabel, ctx.sourceQuery,
    description, metaDescription,
    ecomPlatform, yearlySalesCents,
    monthlyVisits === null ? null : Math.round(monthlyVisits),
    facebookUrl, instagramUrl,
    ctx.topBrand, ctx.eyewearCategories, ctx.eyewearSkuCount,
    ctx.eyewearPriceRange, ctx.eyewearPriceMedianCents,
    ctx.eyewearTopCompetitors, ctx.eyewearSampleTitles,
    mergedTags, ctx.now, ctx.now,
  );
  return { created: true, companyId: id };
}

// ── Main ───────────────────────────────────────────────────────────────────
interface Args {
  dryRun: boolean;
  limit: number | null;
  noClassifier: boolean;
}

function parseArgs(): Args {
  const args: Args = { dryRun: false, limit: null, noClassifier: false };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--no-classifier") args.noClassifier = true;
    else if (a === "--limit") args.limit = parseInt(process.argv[++i] || "0", 10) || null;
  }
  return args;
}

async function main() {
  const args = parseArgs();
  console.log(`Eyewear crawl importer ${args.dryRun ? "(DRY RUN)" : ""}`);
  for (const p of [PRODUCTS_CSV, STATE_LOG, COHORT_CSV]) {
    if (!fs.existsSync(p)) {
      console.error(`Missing: ${p}`);
      process.exit(1);
    }
  }

  const t0 = Date.now();
  console.log(`\nReading ${COHORT_CSV}…`);
  const cohort = loadCohort();
  console.log(`  ${cohort.size.toLocaleString()} firmographic rows`);

  console.log(`Reading ${STATE_LOG}…`);
  const state = loadState();
  console.log(`  ${state.size.toLocaleString()} processed domains`);

  console.log(`Reading ${PRODUCTS_CSV}…`);
  const productsByDomain = loadProducts();
  console.log(`  ${productsByDomain.size.toLocaleString()} matched domains`);

  // ── Build per-domain rollups for the eyewear cohort ──
  console.log(`\nRolling up eyewear aggregates…`);
  const eyewearAggs = new Map<string, EyewearAggregate>();
  let ajMorganSkipped = 0;
  for (const [domain, products] of Array.from(productsByDomain.entries())) {
    const agg = rollUp(domain, products);
    if (agg.has_aj_morgan) {
      ajMorganSkipped++;
      continue;
    }
    eyewearAggs.set(domain, agg);
  }
  console.log(`  ${eyewearAggs.size.toLocaleString()} eyewear stores after AJ Morgan exclusion`);
  console.log(`  ${ajMorganSkipped.toLocaleString()} stores excluded (AJ Morgan)`);

  // ── Process eyewear cohort ──
  const now = new Date().toISOString();
  const eyewearStats: ImportStats = {
    inserted: 0, mergedExisting: 0, skippedNoDomain: 0,
    skippedAjMorgan: ajMorganSkipped, skippedNoCohort: 0, skippedErrorState: 0,
    durationMs: 0,
  };
  const eyewearCompanyIds: string[] = [];

  if (!args.dryRun) {
    console.log(`\nUpserting eyewear cohort (${eyewearAggs.size.toLocaleString()} stores)…`);
    const txn = sqlite.transaction(() => {
      let count = 0;
      for (const [domain, agg] of Array.from(eyewearAggs.entries())) {
        if (args.limit && eyewearStats.inserted >= args.limit) break;
        const cohortRow = cohort.get(domain);
        if (!cohortRow) {
          eyewearStats.skippedNoCohort++;
          continue;
        }

        const medianPrice = median(agg.prices);
        const tier = priceTierTag(medianPrice);
        const tags = eyewearTags(agg, tier);

        // Top brand + competitors
        const sortedVendors = Array.from(agg.vendor_counts.entries())
          .sort((a, b) => b[1] - a[1]);
        const topBrand = sortedVendors[0]?.[0] || null;
        const competitors = sortedVendors.slice(1, 4).map((v) => v[0]).join("|") || null;
        const categories = Array.from(agg.categories).sort().join(",") || null;
        const priceRange = fmtPriceRange(agg.prices);
        const sampleTitles = agg.sample_titles.join("|") || null;

        const ctx: UpsertContext = {
          now, sourceQuery: EYEWEAR_SOURCE_QUERY, sourceLabel: SOURCE_LABEL_EYEWEAR,
          tagsForRow: tags, topBrand,
          eyewearCategories: categories,
          eyewearSkuCount: agg.total_sku_count,
          eyewearPriceRange: priceRange,
          eyewearPriceMedianCents: medianPrice === null ? null : Math.round(medianPrice * 100),
          eyewearTopCompetitors: competitors,
          eyewearSampleTitles: sampleTitles,
        };

        const res = upsert(domain, cohortRow, ctx);
        eyewearCompanyIds.push(res.companyId);
        if (res.created) eyewearStats.inserted++;
        else eyewearStats.mergedExisting++;

        if (++count % 1000 === 0) {
          process.stdout.write(`\r  ${count.toLocaleString()} processed…`);
        }
      }
      process.stdout.write("\n");
    });
    txn();
  }

  console.log(`Eyewear cohort done:`);
  console.log(`  Inserted:           ${eyewearStats.inserted.toLocaleString()}`);
  console.log(`  Merged existing:    ${eyewearStats.mergedExisting.toLocaleString()}`);
  console.log(`  Skipped no-cohort:  ${eyewearStats.skippedNoCohort.toLocaleString()}`);
  console.log(`  Skipped AJ Morgan:  ${eyewearStats.skippedAjMorgan.toLocaleString()}`);

  // ── Process no-eyewear cohort ──
  const noEyewearStats: ImportStats = {
    inserted: 0, mergedExisting: 0, skippedNoDomain: 0,
    skippedAjMorgan: 0, skippedNoCohort: 0, skippedErrorState: 0,
    durationMs: 0,
  };
  const noEyewearCompanyIds: string[] = [];

  if (!args.dryRun) {
    // The no-eyewear cohort = domains in state log with status==
    // "no_sunglasses" that have a cohort row but are NOT in
    // eyewearAggs. Errors are skipped — the crawl never confirmed
    // their state.
    const noEyewearDomains: string[] = [];
    for (const [domain, status] of Array.from(state.entries())) {
      if (status === "no_sunglasses" && cohort.has(domain) && !eyewearAggs.has(domain)) {
        noEyewearDomains.push(domain);
      } else if (status === "error") {
        noEyewearStats.skippedErrorState++;
      }
    }
    console.log(`\nUpserting no-eyewear cohort (${noEyewearDomains.length.toLocaleString()} stores)…`);

    const txn = sqlite.transaction(() => {
      let count = 0;
      for (const domain of noEyewearDomains) {
        if (args.limit && noEyewearStats.inserted >= args.limit) break;
        const cohortRow = cohort.get(domain)!;
        const tags = noEyewearTags(cohortRow);

        const ctx: UpsertContext = {
          now, sourceQuery: NO_EYEWEAR_SOURCE_QUERY, sourceLabel: SOURCE_LABEL_NO_EYEWEAR,
          tagsForRow: tags,
          topBrand: null, eyewearCategories: null, eyewearSkuCount: null,
          eyewearPriceRange: null, eyewearPriceMedianCents: null,
          eyewearTopCompetitors: null, eyewearSampleTitles: null,
        };

        const res = upsert(domain, cohortRow, ctx);
        noEyewearCompanyIds.push(res.companyId);
        if (res.created) noEyewearStats.inserted++;
        else noEyewearStats.mergedExisting++;

        if (++count % 5000 === 0) {
          process.stdout.write(`\r  ${count.toLocaleString()} processed…`);
        }
      }
      process.stdout.write("\n");
    });
    txn();
  }

  console.log(`No-eyewear cohort done:`);
  console.log(`  Inserted:           ${noEyewearStats.inserted.toLocaleString()}`);
  console.log(`  Merged existing:    ${noEyewearStats.mergedExisting.toLocaleString()}`);
  console.log(`  Skipped error-state:${noEyewearStats.skippedErrorState.toLocaleString()}`);

  // ── ICP classifier pass ──
  if (!args.dryRun && !args.noClassifier) {
    const allIds = [...eyewearCompanyIds, ...noEyewearCompanyIds];
    if (allIds.length > 0) {
      console.log(`\nRunning ICP classifier on ${allIds.length.toLocaleString()} new rows…`);
      const res = await icpClassifierHandler({ companyIds: allIds });
      if (res.success && res.data) {
        const summary = (res.data as { summary?: Record<string, number> }).summary;
        if (summary) {
          console.log(`  Tier summary:`);
          for (const [tier, n] of Object.entries(summary)) {
            console.log(`    ${tier}: ${(n as number).toLocaleString()}`);
          }
        }
      } else {
        console.warn(`  Classifier returned: ${JSON.stringify(res)}`);
      }
    }
  } else if (args.noClassifier) {
    console.log(`\nSkipping classifier (--no-classifier flag).`);
  }

  const dur = (Date.now() - t0) / 1000;
  console.log(`\nDone in ${dur.toFixed(1)}s.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
