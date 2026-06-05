/**
 * Filter the three StoreLeads CSV exports (apparel mother-lode +
 * gifts + libraries/museums) into clean cohorts ready to import
 * into The Frame via the existing /api/v1/integrations/storeleads/
 * import-csv endpoint.
 *
 * Filter rules (locked in with Daniel on 2026-06-03):
 *
 * APPAREL (~204K rows in, ~120-140K out):
 *   - US only (already filtered by export)
 *   - status == 'Active' (drops Password Protected)
 *   - created year <= 2025 (excludes brand-new 2026 entries — likely
 *     fresh dropshippers / not yet established)
 *   - exclude categories (leaf match):
 *       Daniel's list: Footwear, Headwear, Children's Clothing,
 *                       Athletic Apparel, Flowers
 *       Competitor: Eyewear, Eyeglasses & Contacts
 *       Wrong vertical: Wedding, Marriage, Costumes,
 *                       Sporting Goods, Sports, Fitness, Outdoors,
 *                       Hair Care, Nursery & Playroom,
 *                       Religion & Belief, Undergarments
 *   - estimated_monthly_sales < $100,000 (no chains)
 *   - NO sales floor — Daniel: "a lot of these stores are larger
 *     in person and less online" so even tiny online-revenue
 *     numbers are legitimately reachable wholesale prospects.
 *   - NO contact-info filter — rows without email/phone can be
 *     enriched later via the existing enrich-no-email endpoint.
 *
 * GIFTS:
 *   - status == Active
 *   - created year <= 2025
 *   - monthly sales < $100K (no chains)
 *   - NO category exclusions — the whole file is "Cards & Greetings"
 *     and Daniel sells to gifting stores already.
 *
 * LIBRARIES / MUSEUMS:
 *   - status == Active
 *   - created year <= 2025
 *   - monthly sales < $100K
 *   - NO category filter — Daniel: "we sell to a lot of museum gift
 *     stores" — these ARE the target segment.
 *
 * Output: one CSV per cohort in the SAME column shape as the
 * StoreLeads exports so the existing import-csv route ingests
 * them without changes. Each cohort gets a source_label appended
 * as a separate column for traceability (and a CLI flag passes it
 * through the importer when you upload).
 *
 * Usage:
 *   npx tsx scripts/storeleads-filter-cohorts.ts [outDir]
 *
 *   Default outDir: ~/Downloads
 *   Hard-coded input paths (edit at the top of main() if needed).
 *
 * Produces:
 *   <outDir>/apparel-filtered.csv
 *   <outDir>/gifts-filtered.csv
 *   <outDir>/museums-filtered.csv
 *   <outDir>/filter-summary.txt
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as Papa from "papaparse";

// ── Exclude lists ──────────────────────────────────────────────────────────
const APPAREL_EXCLUDE_CATEGORIES = new Set<string>([
  // Daniel's list
  "Footwear",
  "Headwear",
  "Children's Clothing",
  "Athletic Apparel",
  "Flowers",
  // Competitors — Jaxy sells eyewear
  "Eyewear",
  "Eyeglasses & Contacts",
  // Narrow / event-only verticals
  "Wedding",
  "Marriage",
  "Costumes",
  // Wrong vertical for fashion eyewear
  "Sporting Goods",
  "Sports",
  "Fitness",
  "Outdoors",
  "Hair Care",
  "Nursery & Playroom",
  "Religion & Belief",
  "Undergarments",
]);

const MAX_MONTHLY_SALES = 100_000; // exclude chains

// ── Helpers ────────────────────────────────────────────────────────────────
function parseFloatLoose(raw: string | undefined | null): number | null {
  if (!raw) return null;
  // StoreLeads ships sales as "USD $250000" / avg price as "USD $29.10"
  const cleaned = String(raw).replace(/[^\d.]/g, "");
  if (!cleaned || cleaned === ".") return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function createdYear(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const y = parseInt(String(raw).slice(0, 4), 10);
  return Number.isFinite(y) ? y : null;
}

/** Categories cell is colon-separated paths like
 *  "/Apparel:/Apparel/Footwear". Return every leaf segment
 *  ("Apparel", "Footwear") so we can match against the exclude
 *  set without worrying about path depth. */
function categoryLeaves(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const path of String(raw).split(":")) {
    const trimmed = path.trim();
    if (!trimmed) continue;
    const leaf = trimmed.split("/").map((s) => s.trim()).filter(Boolean).pop();
    if (leaf) out.push(leaf);
  }
  return out;
}

interface FilterStats {
  inputRows: number;
  droppedNotActive: number;
  droppedTooNew: number;
  droppedExcludedCategory: number;
  droppedLargeChain: number;
  passed: number;
  dropReasonsByCategory: Map<string, number>;
}

function processFile(opts: {
  inputPath: string;
  outputPath: string;
  sourceLabel: string;
  excludeCategories: Set<string> | null;
}): FilterStats {
  const csvText = fs.readFileSync(opts.inputPath, "utf8");
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true, skipEmptyLines: true,
  });

  const stats: FilterStats = {
    inputRows: parsed.data.length,
    droppedNotActive: 0,
    droppedTooNew: 0,
    droppedExcludedCategory: 0,
    droppedLargeChain: 0,
    passed: 0,
    dropReasonsByCategory: new Map(),
  };

  const passing: Record<string, string>[] = [];

  for (const row of parsed.data) {
    // Status: drop Password Protected (and any other non-Active
    // states). Active is the only state we want — confirmed online
    // store with a live homepage.
    if ((row.status || "").trim() !== "Active") {
      stats.droppedNotActive++;
      continue;
    }

    // Created year. StoreLeads uses this as the date they first
    // tracked the domain — proxy for store age. Drop 2026 fresh
    // adds (likely brand-new dropshippers we can't qualify yet).
    const year = createdYear(row.created);
    if (year && year > 2025) {
      stats.droppedTooNew++;
      continue;
    }

    // Category exclude — leaf match. Skip if ANY leaf hits the
    // exclude set, even if another leaf is legit (e.g. a store
    // tagged both "Apparel" and "Footwear" still gets dropped).
    if (opts.excludeCategories) {
      const leaves = categoryLeaves(row.categories);
      const hit = leaves.find((l) => opts.excludeCategories!.has(l));
      if (hit) {
        stats.droppedExcludedCategory++;
        stats.dropReasonsByCategory.set(
          hit,
          (stats.dropReasonsByCategory.get(hit) ?? 0) + 1,
        );
        continue;
      }
    }

    // Chain filter — anything pulling >$100K/mo is too big to be a
    // boutique wholesale target.
    const monthlySales = parseFloatLoose(row.estimated_monthly_sales);
    if (monthlySales !== null && monthlySales >= MAX_MONTHLY_SALES) {
      stats.droppedLargeChain++;
      continue;
    }

    // No sales FLOOR — Daniel: "a lot of these stores are larger
    // in person and less online." Even $50/mo online stores may be
    // legitimate brick-and-mortar wholesale targets.

    // No contact-info filter — rows without email/phone can be
    // enriched later via /storeleads/enrich-no-email.

    // Stamp the source label so the import-csv route can write a
    // distinct source_query and we can A/B campaigns per cohort
    // downstream.
    const stamped = { ...row, source_label: opts.sourceLabel };
    passing.push(stamped);
    stats.passed++;
  }

  fs.writeFileSync(opts.outputPath, Papa.unparse(passing));
  return stats;
}

function fmt(n: number): string {
  return n.toLocaleString();
}

function summary(label: string, s: FilterStats): string {
  const lines = [
    `=== ${label} ===`,
    `  Input rows:                          ${fmt(s.inputRows)}`,
    `  Dropped — not Active:                ${fmt(s.droppedNotActive)}`,
    `  Dropped — created > 2025:            ${fmt(s.droppedTooNew)}`,
    `  Dropped — excluded category:         ${fmt(s.droppedExcludedCategory)}`,
    `  Dropped — large chain (>= $100K/mo): ${fmt(s.droppedLargeChain)}`,
    `  Passing:                             ${fmt(s.passed)}  (${(100 * s.passed / Math.max(1, s.inputRows)).toFixed(1)}%)`,
  ];
  if (s.dropReasonsByCategory.size > 0) {
    lines.push("  Top exclude-category reasons:");
    const top = Array.from(s.dropReasonsByCategory.entries())
      .sort((a, b) => b[1] - a[1]).slice(0, 12);
    for (const [k, v] of top) lines.push(`    ${fmt(v).padStart(7)}  ${k}`);
  }
  return lines.join("\n");
}

async function main() {
  const outDir = process.argv[2] || path.join(os.homedir(), "Downloads");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const INPUT_APPAREL = path.join(os.homedir(), "Downloads", "all apparel stores domains_export (11).csv");
  const INPUT_GIFTS = path.join(os.homedir(), "Downloads", "gifts a domains_export (11).csv");
  const INPUT_MUSEUMS = path.join(os.homedir(), "Downloads", "libraries and museums domains_export (11).csv");

  for (const p of [INPUT_APPAREL, INPUT_GIFTS, INPUT_MUSEUMS]) {
    if (!fs.existsSync(p)) {
      console.error(`Input missing: ${p}`);
      process.exit(1);
    }
  }

  console.log(`Output dir: ${outDir}\n`);

  const apparelStats = processFile({
    inputPath: INPUT_APPAREL,
    outputPath: path.join(outDir, "apparel-filtered.csv"),
    sourceLabel: "storeleads_apparel_v2",
    excludeCategories: APPAREL_EXCLUDE_CATEGORIES,
  });

  const giftsStats = processFile({
    inputPath: INPUT_GIFTS,
    outputPath: path.join(outDir, "gifts-filtered.csv"),
    sourceLabel: "storeleads_cards_and_greetings",
    excludeCategories: null, // segment IS the target — no leaf exclusions
  });

  const museumsStats = processFile({
    inputPath: INPUT_MUSEUMS,
    outputPath: path.join(outDir, "museums-filtered.csv"),
    sourceLabel: "storeleads_museum_gift_shop",
    excludeCategories: null,
  });

  const summaryText =
    summary("APPAREL", apparelStats) + "\n\n" +
    summary("GIFTS (Cards & Greetings)", giftsStats) + "\n\n" +
    summary("LIBRARIES & MUSEUMS", museumsStats) + "\n\n" +
    `=== TOTAL TO IMPORT ===\n` +
    `  ${fmt(apparelStats.passed + giftsStats.passed + museumsStats.passed)} rows across 3 cohorts\n`;

  fs.writeFileSync(path.join(outDir, "filter-summary.txt"), summaryText);
  console.log(summaryText);
  console.log(`Files written:`);
  console.log(`  ${path.join(outDir, "apparel-filtered.csv")}`);
  console.log(`  ${path.join(outDir, "gifts-filtered.csv")}`);
  console.log(`  ${path.join(outDir, "museums-filtered.csv")}`);
  console.log(`  ${path.join(outDir, "filter-summary.txt")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
