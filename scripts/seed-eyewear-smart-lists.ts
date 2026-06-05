/**
 * Seed the Smart Lists for the eyewear crawl cohorts.
 *
 * After scripts/import-eyewear-crawl.ts runs, the new leads exist
 * with their segment tags + source_query values. This script
 * inserts (or refreshes) the Smart Lists that surface those
 * cohorts in the Prospects UI:
 *
 *   🎯 Eyewear — Pitchable (entry+mid, multi-brand)    [outreach target]
 *   🎯 Eyewear — All affordable matches
 *   🎯 Eyewear — Reading-glasses cohort
 *   🎯 Eyewear — Carries both categories
 *   📦 Eyewear — Premium/Luxury (out of scope for now)
 *   🗂 Apparel no-eyewear — Vintage stores
 *   🗂 Apparel no-eyewear — Gift / lifestyle stores
 *   🗂 Apparel no-eyewear — All others
 *
 * Idempotent: looks up each list by name, updates the filters if
 * found, otherwise inserts a new row. Run as many times as needed
 * without dup-list buildup.
 *
 * Usage:
 *   npx tsx scripts/seed-eyewear-smart-lists.ts
 */

import { sqlite } from "../src/lib/db";

interface SmartListDef {
  name: string;
  description: string;
  filters: Record<string, unknown>;
}

// All eight lists. Filter shape uses the keys recognised by the
// smart-lists/route.ts countForFilters helper:
//   source_query: string[]    exact match
//   tag_and:      string[]    AND across tags
//   tag_not:      string[]    NOT across tags
//   has_email/has_phone:      "true" | "false"
const LISTS: SmartListDef[] = [
  {
    name: "🎯 Eyewear — Pitchable (entry+mid, multi-brand)",
    description:
      "The AI-opener outreach target: entry/mid tier eyewear-carrying " +
      "stores with multi-brand assortments (less than 40% one brand). " +
      "Excludes the Premium/Luxury price ceiling.",
    filters: {
      source_query: ["eyewear_inventory_v1_2026-06"],
      // Multi-brand assortment is the pitchability signal.
      tag_and: ["eyewear_cohort", "eyewear_multi_brand_assortment"],
      tag_not: ["eyewear_price_too_high"],
      has_email: "true",
    },
  },
  {
    name: "🎯 Eyewear — All affordable matches",
    description:
      "Broader cut: every eyewear-carrying store in the entry+mid " +
      "tier, regardless of brand concentration. Use when the " +
      "pitchable cohort is exhausted.",
    filters: {
      source_query: ["eyewear_inventory_v1_2026-06"],
      tag_and: ["eyewear_cohort"],
      tag_not: ["eyewear_price_too_high"],
    },
  },
  {
    name: "🎯 Eyewear — Reading-glasses cohort",
    description:
      "Stores that carry reading glasses (separately or alongside " +
      "sunglasses). Distinct buyer persona — gift shops, lifestyle " +
      "stores, older demographics.",
    filters: {
      source_query: ["eyewear_inventory_v1_2026-06"],
      tag_and: ["eyewear_cohort", "carries_reading_glasses"],
    },
  },
  {
    name: "🎯 Eyewear — Carries both categories",
    description:
      "Stores carrying both sunglasses AND reading glasses. Best " +
      "repeat-purchase profile — established eyewear shelves.",
    filters: {
      source_query: ["eyewear_inventory_v1_2026-06"],
      tag_and: ["eyewear_cohort", "carries_both"],
    },
  },
  {
    name: "📦 Eyewear — Premium/Luxury (out of scope for now)",
    description:
      "Stores whose eyewear AOV is above $100. Too premium for " +
      "Jaxy's current $28 MSRP positioning. Kept queryable in case " +
      "a future premium Jaxy line revisits them.",
    filters: {
      source_query: ["eyewear_inventory_v1_2026-06"],
      tag_and: ["eyewear_cohort", "eyewear_price_too_high"],
    },
  },
  {
    name: "🗂 Apparel no-eyewear — Vintage stores",
    description:
      "Apparel boutiques with no current eyewear shelf, tagged as " +
      "Vintage. Future-campaign-relevant for a vintage-styled " +
      "Jaxy launch or limited-edition retro line.",
    filters: {
      source_query: ["apparel_no_eyewear_v1_2026-06"],
      tag_and: ["apparel_no_eyewear_v1", "industry_vintage"],
    },
  },
  {
    name: "🗂 Apparel no-eyewear — Gift / lifestyle stores",
    description:
      "Apparel boutiques with no current eyewear shelf, tagged as " +
      "Gifts. Sunglasses-as-gift-item angle would be a different " +
      "outreach copy approach.",
    filters: {
      source_query: ["apparel_no_eyewear_v1_2026-06"],
      tag_and: ["apparel_no_eyewear_v1", "industry_gifts"],
    },
  },
  {
    name: "🗂 Apparel no-eyewear — All others",
    description:
      "Every other apparel boutique with no current eyewear shelf. " +
      "Catch-all for future broad campaigns.",
    filters: {
      source_query: ["apparel_no_eyewear_v1_2026-06"],
      tag_and: ["apparel_no_eyewear_v1"],
      tag_not: ["industry_vintage", "industry_gifts"],
    },
  },
];

// ── Helpers ────────────────────────────────────────────────────────────────
function countForFilters(filters: Record<string, unknown>): number {
  // Tiny mirror of smart-lists/route.ts countForFilters — kept
  // standalone here so we don't have to import from a Next.js route
  // module (which pulls in framework globals).
  const clauses: string[] = [];
  const params: unknown[] = [];

  const sqArr = filters.source_query as string[] | undefined;
  if (sqArr?.length) {
    clauses.push(`source_query IN (${sqArr.map(() => "?").join(",")})`);
    params.push(...sqArr);
  }
  const tagAnd = filters.tag_and as string[] | undefined;
  if (tagAnd?.length) {
    for (const t of tagAnd) {
      clauses.push(`tags LIKE ?`);
      params.push(`%${t}%`);
    }
  }
  const tagNot = filters.tag_not as string[] | undefined;
  if (tagNot?.length) {
    for (const t of tagNot) {
      clauses.push(`(tags IS NULL OR tags NOT LIKE ?)`);
      params.push(`%${t}%`);
    }
  }
  if (filters.has_email === "true") clauses.push(`email IS NOT NULL AND email != ''`);
  if (filters.has_email === "false") clauses.push(`(email IS NULL OR email = '')`);

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const row = sqlite.prepare(`SELECT COUNT(*) AS c FROM companies ${where}`).get(...params) as { c: number };
  return row.c;
}

// ── Main ───────────────────────────────────────────────────────────────────
function main() {
  const findByName = sqlite.prepare<[string]>(
    `SELECT id FROM smart_lists WHERE name = ? LIMIT 1`,
  );
  const insertNew = sqlite.prepare(
    `INSERT INTO smart_lists
       (id, name, description, filters, is_shared, is_default, result_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 0, ?, datetime('now'), datetime('now'))`,
  );
  const updateExisting = sqlite.prepare(
    `UPDATE smart_lists
        SET description = ?, filters = ?, result_count = ?, updated_at = datetime('now')
      WHERE id = ?`,
  );

  let created = 0;
  let updated = 0;
  for (const list of LISTS) {
    const filtersJson = JSON.stringify(list.filters);
    const count = countForFilters(list.filters);
    const existing = findByName.get(list.name) as { id: string } | undefined;
    if (existing) {
      updateExisting.run(list.description, filtersJson, count, existing.id);
      updated++;
      console.log(`  ↻  ${list.name}  (${count.toLocaleString()})`);
    } else {
      insertNew.run(crypto.randomUUID(), list.name, list.description, filtersJson, count);
      created++;
      console.log(`  +  ${list.name}  (${count.toLocaleString()})`);
    }
  }

  console.log(`\nDone. ${created} created, ${updated} updated.`);
}

main();
