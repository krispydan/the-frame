import Papa from "papaparse";
import { db, sqlite } from "@/lib/db";
import { companies, stores, contacts } from "@/modules/sales/schema";
import { eq, and } from "drizzle-orm";
import fs from "fs";

export interface ImportStats {
  totalRows: number;
  companiesCreated: number;
  storesCreated: number;
  contactsCreated: number;
  updated: number;
  skipped: number;
  errors: { row: number; message: string }[];
  durationMs: number;
}

export interface ProspectRow {
  id: string;
  name: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone: string;
  email: string;
  website: string;
  contact_form_url: string;
  latitude: string;
  longitude: string;
  category: string;
  segment: string;
  lead_sources: string;
  stockist_brands: string;
  stockist_brand_sectors: string;
  stockist_brand_count: string;
  prospect_score: string;
  rating: string;
  reviews: string;
  source_details: string;
  needs_contact_enrichment: string;
  status: string;
}

function extractDomain(website: string | null): string | null {
  if (!website) return null;
  try {
    let url = website.trim();
    if (!url.startsWith("http")) url = "https://" + url;
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return hostname || null;
  } catch {
    return null;
  }
}

function mapCategory(category: string): "independent" | "chain" | "online" | "department_store" | "boutique" | "other" {
  const c = (category || "").toLowerCase();
  if (c.includes("boutique")) return "boutique";
  if (c.includes("department")) return "department_store";
  if (c.includes("chain")) return "chain";
  if (c.includes("online")) return "online";
  return "independent";
}

function mapStatus(status: string): "new" | "contacted" | "qualified" | "rejected" | "customer" {
  const s = (status || "").toLowerCase().trim();
  if (s === "qualified") return "qualified";
  if (s === "contacted") return "contacted";
  if (s === "rejected") return "rejected";
  if (s === "customer") return "customer";
  return "new";
}

/**
 * Import prospects from CSV into Company → Store → Contact hierarchy.
 * Uses raw SQL for batch performance on 121K+ records.
 */
export async function importProspectsFromCSV(
  csvPath: string,
  options: { batchSize?: number; onProgress?: (processed: number, total: number) => void } = {}
): Promise<ImportStats> {
  const batchSize = options.batchSize ?? 500;
  const start = Date.now();
  const stats: ImportStats = {
    totalRows: 0,
    companiesCreated: 0,
    storesCreated: 0,
    contactsCreated: 0,
    updated: 0,
    skipped: 0,
    errors: [],
    durationMs: 0,
  };

  // Parse CSV
  const csvContent = fs.readFileSync(csvPath, "utf-8");
  const { data, errors: parseErrors } = Papa.parse<ProspectRow>(csvContent, {
    header: true,
    skipEmptyLines: true,
  });

  if (parseErrors.length > 0) {
    stats.errors.push(...parseErrors.slice(0, 10).map(e => ({ row: e.row ?? 0, message: e.message })));
  }

  stats.totalRows = data.length;

  // Build dedup set from existing companies (name|state)
  const existingKeys = new Set<string>();
  const existingCompanies = db.select({ name: companies.name, state: companies.state }).from(companies).all();
  for (const c of existingCompanies) {
    if (c.name && c.state) {
      existingKeys.add(`${c.name.toLowerCase()}|${(c.state || "").toLowerCase()}`);
    }
  }

  // Prepare raw statements for max performance
  const insertCompany = sqlite.prepare(`
    INSERT INTO companies (id, name, type, website, domain, phone, email, city, state, zip, country, source, icp_score, status, tags, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `);

  const insertStore = sqlite.prepare(`
    INSERT INTO stores (id, company_id, name, is_primary, address, city, state, zip, phone, email, google_rating, latitude, longitude, status, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', datetime('now'), datetime('now'))
  `);

  const insertContact = sqlite.prepare(`
    INSERT INTO contacts (id, store_id, company_id, email, phone, is_primary, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, 'import', datetime('now'), datetime('now'))
  `);

  // Process in batches using transactions
  for (let i = 0; i < data.length; i += batchSize) {
    const batch = data.slice(i, i + batchSize);

    const runBatch = sqlite.transaction(() => {
      for (let j = 0; j < batch.length; j++) {
        const row = batch[j];
        const rowIndex = i + j + 1;

        try {
          const name = (row.name || "").trim();
          const state = (row.state || "").trim();
          if (!name) {
            stats.skipped++;
            continue;
          }

          const dedupKey = `${name.toLowerCase()}|${state.toLowerCase()}`;
          if (existingKeys.has(dedupKey)) {
            stats.skipped++;
            continue;
          }
          existingKeys.add(dedupKey);

          const companyId = crypto.randomUUID();
          const storeId = crypto.randomUUID();
          const contactId = crypto.randomUUID();

          const website = row.website?.trim() || null;
          const domain = extractDomain(website);
          const email = row.email?.trim() || null;
          const phone = row.phone?.trim() || null;
          const score = row.prospect_score ? parseInt(row.prospect_score, 10) : null;
          const rating = row.rating ? parseFloat(row.rating) : null;
          const lat = row.latitude ? parseFloat(row.latitude) : null;
          const lng = row.longitude ? parseFloat(row.longitude) : null;

          // Tags from category + segment
          const tags: string[] = [];
          if (row.category) tags.push(row.category.trim());
          if (row.segment) tags.push(row.segment.trim());

          insertCompany.run(
            companyId,
            name,
            mapCategory(row.category),
            website,
            domain,
            phone,
            email,
            row.city?.trim() || null,
            state || null,
            row.zip?.trim() || null,
            row.country?.trim() || "US",
            row.lead_sources?.trim() || null,
            isNaN(score as number) ? null : score,
            mapStatus(row.status),
            tags.length > 0 ? JSON.stringify(tags) : null,
          );
          stats.companiesCreated++;

          insertStore.run(
            storeId,
            companyId,
            name,
            row.address?.trim() || null,
            row.city?.trim() || null,
            state || null,
            row.zip?.trim() || null,
            phone,
            email,
            isNaN(rating as number) ? null : rating,
            isNaN(lat as number) ? null : lat,
            isNaN(lng as number) ? null : lng,
          );
          stats.storesCreated++;

          // Create contact only if we have email or phone
          if (email || phone) {
            insertContact.run(contactId, storeId, companyId, email, phone);
            stats.contactsCreated++;
          }
        } catch (err) {
          stats.errors.push({ row: rowIndex, message: (err as Error).message });
        }
      }
    });

    runBatch();

    if (options.onProgress) {
      options.onProgress(Math.min(i + batchSize, data.length), data.length);
    }
  }

  // Auto-classify ICP for newly imported companies
  if (stats.companiesCreated > 0) {
    try {
      const { getUnscoredCompanyIds } = await import("@/modules/sales/agents/icp-classifier");
      const unscoredIds = getUnscoredCompanyIds();
      if (unscoredIds.length > 0) {
        const { agentOrchestrator } = await import("@/modules/core/lib/agent-orchestrator");
        await agentOrchestrator.runAgentSync("icp-classifier", { companyIds: unscoredIds });
      }
    } catch {
      // ICP classification is best-effort on import
    }
  }

  // Rebuild FTS5 index
  try {
    sqlite.exec(`INSERT INTO companies_fts(companies_fts) VALUES('rebuild')`);
  } catch {
    // FTS table might not exist yet, create it
    sqlite.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS companies_fts USING fts5(
        name, city, state, website, domain, notes,
        content='companies',
        content_rowid='rowid'
      )
    `);
    sqlite.exec(`INSERT INTO companies_fts(companies_fts) VALUES('rebuild')`);
  }

  stats.durationMs = Date.now() - start;
  return stats;
}
