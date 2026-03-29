/**
 * Import brand accounts from scrape data files into the database.
 * Idempotent — safe to run multiple times (upserts on external_id).
 *
 * Usage: npx tsx scripts/import-brand-accounts.ts
 */

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { parse } from "papaparse";

const DB_PATH = process.env.DATABASE_PATH || process.env.DATABASE_URL || path.join(process.cwd(), "data", "the-frame.db");
const DATA_DIR = path.join(process.cwd(), "data", "scrape-import");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.pragma("foreign_keys = ON");

// ── Ensure tables exist (migrations should have run, but be safe) ──
db.exec(`
  CREATE TABLE IF NOT EXISTS brand_accounts (
    id TEXT PRIMARY KEY,
    external_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    website TEXT,
    sector TEXT,
    relevance TEXT NOT NULL DEFAULT 'needs_review',
    brand_type TEXT NOT NULL DEFAULT 'unknown',
    us_locations INTEGER DEFAULT 0,
    total_locations INTEGER DEFAULT 0,
    top_country TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS company_brand_links (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id),
    brand_account_id TEXT NOT NULL REFERENCES brand_accounts(id),
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_brand_accounts_external_id ON brand_accounts(external_id);
  CREATE INDEX IF NOT EXISTS idx_brand_accounts_relevance ON brand_accounts(relevance);
  CREATE INDEX IF NOT EXISTS idx_brand_accounts_sector ON brand_accounts(sector);
  CREATE INDEX IF NOT EXISTS idx_cbl_company ON company_brand_links(company_id);
  CREATE INDEX IF NOT EXISTS idx_cbl_brand ON company_brand_links(brand_account_id);
`);

// ── Load data files ──
console.log("[import] Loading data files...");

const allBrandLocations: Record<string, { brand_name: string; locations: Array<{
  id: number; name: string; latitude: string; longitude: string;
  city: string; state: string; country: string; [k: string]: unknown;
}> }> = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "all-brand-locations.json"), "utf-8"));

const wholesaleClassification: {
  own_store_brand_ids: string[];
  wholesale_brand_ids: string[];
} = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "brand-wholesale-classification.json"), "utf-8"));

const brandsClassifiedCsv = fs.readFileSync(path.join(DATA_DIR, "brands-classified.csv"), "utf-8");
const brandsClassified = parse<Record<string, string>>(brandsClassifiedCsv, { header: true, skipEmptyLines: true }).data;

const brandDirectoryCsv = fs.readFileSync(path.join(DATA_DIR, "brand-directory.csv"), "utf-8");
const brandDirectory = parse<Record<string, string>>(brandDirectoryCsv, { header: true, skipEmptyLines: true }).data;

// ── Build lookup maps ──
const classifiedMap = new Map<string, Record<string, string>>();
for (const row of brandsClassified) {
  classifiedMap.set(row.account_id, row);
}

const directoryMap = new Map<string, Record<string, string>>();
for (const row of brandDirectory) {
  directoryMap.set(row.account_id, row);
}

const ownStoreSet = new Set(wholesaleClassification.own_store_brand_ids);
const wholesaleSet = new Set(wholesaleClassification.wholesale_brand_ids);

// ── Upsert brand accounts ──
console.log("[import] Importing brand accounts...");

const upsertBrand = db.prepare(`
  INSERT INTO brand_accounts (id, external_id, name, website, sector, relevance, brand_type, us_locations, total_locations, top_country, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  ON CONFLICT(external_id) DO UPDATE SET
    name = excluded.name,
    website = excluded.website,
    sector = excluded.sector,
    relevance = excluded.relevance,
    brand_type = excluded.brand_type,
    us_locations = excluded.us_locations,
    total_locations = excluded.total_locations,
    top_country = excluded.top_country,
    updated_at = datetime('now')
`);

const allExternalIds = new Set([
  ...Object.keys(allBrandLocations),
  ...classifiedMap.keys(),
  ...directoryMap.keys(),
]);

let brandsImported = 0;

const insertBrands = db.transaction(() => {
  for (const extId of allExternalIds) {
    const classified = classifiedMap.get(extId);
    const directory = directoryMap.get(extId);
    const locationData = allBrandLocations[extId];

    // Name: prefer classified > directory > location data > external ID
    const name = classified?.brand_name?.trim() || directory?.brand_guess?.trim() || locationData?.brand_name?.trim() || extId;

    // Website: prefer classified > directory
    const website = classified?.website?.trim() || directory?.website_domain?.trim() || null;

    // Sector from classified
    const sector = classified?.sector?.trim() || null;

    // Relevance from classified (True -> relevant, False -> irrelevant, else needs_review)
    let relevance = "needs_review";
    if (classified?.relevant === "True") relevance = "relevant";
    else if (classified?.relevant === "False") relevance = "irrelevant";

    // Brand type from wholesale classification
    let brandType = "unknown";
    if (ownStoreSet.has(extId)) brandType = "own_store";
    else if (wholesaleSet.has(extId)) brandType = "wholesale";

    // Location counts
    const usLocations = parseInt(classified?.us_locations || directory?.us_locations || "0") || 0;
    const totalLocations = parseInt(classified?.total_locations || directory?.location_count || "0") || 0;

    // Top country
    const topCountry = directory?.top_country?.trim() || null;

    upsertBrand.run(
      crypto.randomUUID(),
      extId,
      name,
      website,
      sector,
      relevance,
      brandType,
      usLocations,
      totalLocations,
      topCountry,
    );
    brandsImported++;
  }
});

insertBrands();
console.log(`[import] Inserted/updated ${brandsImported} brand accounts`);

// ── Build brand ID lookup (external_id -> db id) ──
const brandIdMap = new Map<string, string>();
const brandRows = db.prepare("SELECT id, external_id FROM brand_accounts").all() as { id: string; external_id: string }[];
for (const row of brandRows) {
  brandIdMap.set(row.external_id, row.id);
}

// ── Match brand locations to existing companies ──
console.log("[import] Matching brand locations to companies...");

// Build a lookup of UPPER(name) + UPPER(city) -> company ID
const companyRows = db.prepare("SELECT id, UPPER(name) as uname, UPPER(city) as ucity FROM companies WHERE name IS NOT NULL").all() as { id: string; uname: string; ucity: string }[];
const companyLookup = new Map<string, string>();
for (const row of companyRows) {
  if (row.uname && row.ucity) {
    companyLookup.set(`${row.uname}|${row.ucity}`, row.id);
  }
}

// Clear existing links before re-creating (idempotent)
db.prepare("DELETE FROM company_brand_links").run();

const insertLink = db.prepare(`
  INSERT INTO company_brand_links (id, company_id, brand_account_id, created_at)
  VALUES (?, ?, ?, datetime('now'))
`);

let linksCreated = 0;
const seenLinks = new Set<string>();

const insertLinks = db.transaction(() => {
  for (const [extId, data] of Object.entries(allBrandLocations)) {
    const brandDbId = brandIdMap.get(extId);
    if (!brandDbId) continue;

    for (const loc of data.locations) {
      const locName = (loc.name || "").trim().toUpperCase();
      const locCity = (loc.city || "").trim().toUpperCase();
      if (!locName || !locCity) continue;

      const key = `${locName}|${locCity}`;
      const companyId = companyLookup.get(key);
      if (!companyId) continue;

      const linkKey = `${companyId}|${brandDbId}`;
      if (seenLinks.has(linkKey)) continue;
      seenLinks.add(linkKey);

      insertLink.run(crypto.randomUUID(), companyId, brandDbId);
      linksCreated++;
    }
  }
});

insertLinks();
console.log(`[import] Created ${linksCreated} company-brand links`);

// ── DQ non-US/Canada companies ──
console.log("[import] Disqualifying non-US/Canada companies...");

const US_COUNTRY_VARIANTS = new Set([
  "US", "USA", "UNITED STATES", "UNITED STATES OF AMERICA", "U.S.", "U.S.A.",
]);
const CA_COUNTRY_VARIANTS = new Set([
  "CA", "CANADA", "CAN",
]);

const US_STATES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
  "DC", "PR", "VI", "GU", "AS", "MP",
]);

const CA_PROVINCES = new Set([
  "AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT",
  "ALBERTA", "BRITISH COLUMBIA", "MANITOBA", "NEW BRUNSWICK",
  "NEWFOUNDLAND AND LABRADOR", "NOVA SCOTIA", "NORTHWEST TERRITORIES",
  "NUNAVUT", "ONTARIO", "PRINCE EDWARD ISLAND", "QUEBEC", "SASKATCHEWAN", "YUKON",
]);

function isUsOrCanada(country: string | null, state: string | null, lat: number | null, lng: number | null): boolean {
  const upperCountry = (country || "").trim().toUpperCase();
  if (US_COUNTRY_VARIANTS.has(upperCountry) || CA_COUNTRY_VARIANTS.has(upperCountry)) return true;

  const upperState = (state || "").trim().toUpperCase();
  if (US_STATES.has(upperState) || CA_PROVINCES.has(upperState)) return true;

  // Lat/lng bounding box for US + Canada (rough)
  if (lat !== null && lng !== null) {
    if (lat >= 24.0 && lat <= 72.0 && lng >= -170.0 && lng <= -50.0) return true;
  }

  return false;
}

// Get all companies that are linked to a brand
const linkedCompanies = db.prepare(`
  SELECT DISTINCT c.id, c.country, c.state, c.status,
    (SELECT s.latitude FROM stores s WHERE s.company_id = c.id LIMIT 1) as lat,
    (SELECT s.longitude FROM stores s WHERE s.company_id = c.id LIMIT 1) as lng
  FROM companies c
  INNER JOIN company_brand_links cbl ON cbl.company_id = c.id
  WHERE c.status != 'rejected'
`).all() as { id: string; country: string | null; state: string | null; status: string; lat: number | null; lng: number | null }[];

const dqStmt = db.prepare(`
  UPDATE companies SET status = 'rejected', disqualify_reason = 'Non-US/CA location', updated_at = datetime('now')
  WHERE id = ?
`);

let companiesDQd = 0;

const dqTransaction = db.transaction(() => {
  for (const company of linkedCompanies) {
    if (!isUsOrCanada(company.country, company.state, company.lat, company.lng)) {
      dqStmt.run(company.id);
      companiesDQd++;
    }
  }
});

dqTransaction();
console.log(`[import] DQ'd ${companiesDQd} non-US/CA companies`);

// ── Final stats ──
const totalBrands = (db.prepare("SELECT count(*) as c FROM brand_accounts").get() as { c: number }).c;
const totalLinks = (db.prepare("SELECT count(*) as c FROM company_brand_links").get() as { c: number }).c;
const relevantBrands = (db.prepare("SELECT count(*) as c FROM brand_accounts WHERE relevance = 'relevant'").get() as { c: number }).c;
const irrelevantBrands = (db.prepare("SELECT count(*) as c FROM brand_accounts WHERE relevance = 'irrelevant'").get() as { c: number }).c;

console.log("\n=== Import Summary ===");
console.log(`Total brand accounts: ${totalBrands}`);
console.log(`  Relevant: ${relevantBrands}`);
console.log(`  Irrelevant: ${irrelevantBrands}`);
console.log(`  Needs review: ${totalBrands - relevantBrands - irrelevantBrands}`);
console.log(`Company-brand links: ${totalLinks}`);
console.log(`Companies DQ'd (non-US/CA): ${companiesDQd}`);

db.close();
