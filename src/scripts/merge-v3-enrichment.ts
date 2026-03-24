/**
 * Merge outscraper v3 enrichment data into The Frame database.
 * Matches by google_place_id, domain, or name+state.
 * Updates existing records with email/rating/reviews, inserts new ones.
 * Usage: npx tsx src/scripts/merge-v3-enrichment.ts
 */
import path from "path";
import fs from "fs";

const dbPath = path.join(process.cwd(), "data", "the-frame.db");
process.env.DATABASE_URL = dbPath;

import { db, sqlite } from "@/lib/db";

const CSV_PATH = path.resolve(
  process.env.HOME || "~",
  "Dropbox/Obsidian/jaxy/sales/lead-verification/results/expansion-v3/expansion-v3-master.csv"
);

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

function extractDomain(website: string): string | null {
  if (!website) return null;
  try {
    let url = website.trim();
    if (!url.startsWith("http")) url = "https://" + url;
    const hostname = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    if (hostname && hostname.includes(".")) return hostname;
  } catch {}
  return null;
}

async function main() {
  console.log("🚀 Starting v3 enrichment merge...");
  console.log(`📂 CSV: ${CSV_PATH}`);
  console.log(`💾 DB: ${dbPath}`);

  const content = fs.readFileSync(CSV_PATH, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());
  const headers = parseCSVLine(lines[0]);
  const rows = lines.slice(1).map((line) => {
    const vals = parseCSVLine(line);
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => (obj[h] = vals[i] || ""));
    return obj;
  });

  console.log(`📊 Rows to process: ${rows.length}`);

  // Add indexes for fast lookup
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_companies_place_id ON companies(google_place_id)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_companies_name_state ON companies(LOWER(name), LOWER(state))`);
  console.log("📇 Indexes ready.");

  // Prepare statements
  const findByPlaceId = sqlite.prepare(
    `SELECT id, email, google_place_id FROM companies WHERE google_place_id = ? LIMIT 1`
  );
  const findByDomain = sqlite.prepare(
    `SELECT id, email, google_place_id FROM companies WHERE domain = ? LIMIT 1`
  );
  const findByNameState = sqlite.prepare(
    `SELECT id, email, google_place_id FROM companies WHERE LOWER(name) = LOWER(?) AND LOWER(state) = LOWER(?) LIMIT 1`
  );

  const updateCompany = sqlite.prepare(`
    UPDATE companies SET
      email = COALESCE(NULLIF(email, ''), ?),
      google_rating = COALESCE(?, google_rating),
      google_review_count = COALESCE(?, google_review_count),
      google_place_id = COALESCE(NULLIF(google_place_id, ''), ?),
      segment = COALESCE(NULLIF(segment, ''), ?),
      category = COALESCE(NULLIF(category, ''), ?),
      source_type = CASE WHEN source_type IS NULL OR source_type = '' THEN 'outscraper' ELSE source_type END,
      enrichment_status = 'enriched',
      enriched_at = datetime('now'),
      enrichment_source = 'outscraper-v3',
      updated_at = datetime('now')
    WHERE id = ?
  `);

  const updateStore = sqlite.prepare(`
    UPDATE stores SET
      google_place_id = COALESCE(NULLIF(google_place_id, ''), ?),
      google_rating = COALESCE(?, google_rating),
      email = COALESCE(NULLIF(email, ''), ?),
      updated_at = datetime('now')
    WHERE company_id = ? AND is_primary = 1
  `);

  const findContactByCompany = sqlite.prepare(
    `SELECT id, email FROM contacts WHERE company_id = ? LIMIT 1`
  );

  const insertCompany = sqlite.prepare(`
    INSERT INTO companies (id, name, website, domain, phone, email, address, city, state, zip,
      google_place_id, google_rating, google_review_count, source, source_type, segment, category,
      status, enrichment_status, enriched_at, enrichment_source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'outscraper-v3', 'outscraper', ?, ?, 'new',
      'enriched', datetime('now'), 'outscraper-v3', datetime('now'), datetime('now'))
  `);

  const insertStore = sqlite.prepare(`
    INSERT INTO stores (id, company_id, name, is_primary, address, city, state, zip, phone, email,
      google_place_id, google_rating, status, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'active', datetime('now'), datetime('now'))
  `);

  const insertContact = sqlite.prepare(`
    INSERT INTO contacts (id, company_id, store_id, email, is_primary, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, 'outscraper-v3', datetime('now'), datetime('now'))
  `);

  const insertContact2 = sqlite.prepare(`
    INSERT INTO contacts (id, company_id, store_id, email, is_primary, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, 'outscraper-v3', datetime('now'), datetime('now'))
  `);

  let matched = 0, inserted = 0, skipped = 0, email2Added = 0;

  const runAll = sqlite.transaction(() => {
    let processed = 0;
    for (const row of rows) {
      processed++;
      if (processed % 1000 === 0) console.log(`  📊 ${processed} / ${rows.length}`);
      const name = row.name?.trim();
      if (!name) { skipped++; continue; }

      const domain = extractDomain(row.website);
      const placeId = row.place_id?.trim() || null;
      const state = row.state?.trim() || "";
      const email = row.email?.trim() || null;
      const email2 = row.email_2?.trim() || null;
      const rating = row.rating ? parseFloat(row.rating) || null : null;
      const reviews = row.reviews ? parseInt(row.reviews) || null : null;
      const segment = row.segment?.trim() || null;
      const category = row.category?.trim() || null;

      // Try to find existing company
      let existing: any = null;
      if (placeId) existing = findByPlaceId.get(placeId);
      if (!existing && domain) existing = findByDomain.get(domain);
      if (!existing && state) existing = findByNameState.get(name, state);

      if (existing) {
        // Update company
        updateCompany.run(email, rating, reviews, placeId, segment, category, existing.id);
        updateStore.run(placeId, rating, email, existing.id);

        // Add email_2 as secondary contact if present
        if (email2) {
          const storeRow: any = sqlite.prepare(`SELECT id FROM stores WHERE company_id = ? AND is_primary = 1 LIMIT 1`).get(existing.id);
          const storeId = storeRow?.id || null;
          insertContact2.run(crypto.randomUUID(), existing.id, storeId, email2);
          email2Added++;
        }
        matched++;
      } else {
        // Insert new company + store + contact
        const companyId = crypto.randomUUID();
        const storeId = crypto.randomUUID();

        insertCompany.run(companyId, name, row.website?.trim() || null, domain,
          row.phone?.trim() || null, email, row.address?.trim() || null,
          row.city?.trim() || null, state || null, row.zip?.trim() || null,
          placeId, rating, reviews, segment, category);

        insertStore.run(storeId, companyId, name, row.address?.trim() || null,
          row.city?.trim() || null, state || null, row.zip?.trim() || null,
          row.phone?.trim() || null, email, placeId, rating);

        if (email) {
          insertContact.run(crypto.randomUUID(), companyId, storeId, email);
        }
        if (email2) {
          insertContact2.run(crypto.randomUUID(), companyId, storeId, email2);
        }
        inserted++;
      }
    }
  });

  runAll();

  console.log("\n✅ Merge complete!");
  console.log(`  🔗 Matched & updated: ${matched}`);
  console.log(`  ➕ New inserts: ${inserted}`);
  console.log(`  📧 Email_2 contacts added: ${email2Added}`);
  console.log(`  ⏭️  Skipped: ${skipped}`);

  // Rebuild FTS5 index
  console.log("\n🔄 Rebuilding FTS5 index...");
  sqlite.exec(`DELETE FROM companies_fts`);
  sqlite.exec(`
    INSERT INTO companies_fts(rowid, name, city, state, website, domain, notes)
    SELECT rowid, name, city, state, website, domain, notes FROM companies
  `);
  console.log("✅ FTS5 index rebuilt.");

  // Final counts
  const companyCount = sqlite.prepare(`SELECT count(*) as cnt FROM companies`).get() as any;
  const storeCount = sqlite.prepare(`SELECT count(*) as cnt FROM stores`).get() as any;
  const contactCount = sqlite.prepare(`SELECT count(*) as cnt FROM contacts`).get() as any;
  const withEmail = sqlite.prepare(`SELECT count(*) as cnt FROM companies WHERE email IS NOT NULL AND email != ''`).get() as any;

  console.log("\n📊 Final database counts:");
  console.log(`  🏢 Companies: ${companyCount.cnt}`);
  console.log(`  🏪 Stores: ${storeCount.cnt}`);
  console.log(`  👤 Contacts: ${contactCount.cnt}`);
  console.log(`  📧 Companies with email: ${withEmail.cnt}`);

  // Sample enriched records
  const samples = sqlite.prepare(`
    SELECT name, state, email, google_rating, google_review_count, enrichment_source
    FROM companies WHERE enrichment_source = 'outscraper-v3' AND email IS NOT NULL LIMIT 5
  `).all();
  console.log("\n🔍 Sample enriched records:");
  for (const s of samples as any[]) {
    console.log(`  ${s.name} (${s.state}) — ${s.email} — ⭐${s.google_rating} (${s.google_review_count} reviews)`);
  }
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
