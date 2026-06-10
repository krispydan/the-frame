/**
 * Import the 7 Helium 10 Cerebro shape exports from ~/Downloads into
 * catalog_keywords. One reverse-ASIN export per frame shape; shape is
 * derived from each PHRASE by the scrub module, not from the file, so
 * head terms shared across shapes dedup automatically.
 *
 * Usage:
 *   npx tsx scripts/import-cerebro-keywords.ts [--source <label>]
 *
 * Default source label is "cerebro-<today>". Re-running with the same
 * label is idempotent (upsert refreshes metrics, preserves overrides).
 *
 * On prod, run inside the container so it writes the Railway volume db:
 *   railway ssh --service the-frame \
 *     "cd /app && npx tsx scripts/import-cerebro-keywords.ts"
 * (upload the CSVs to /app first, or use the /import API route instead.)
 */
import os from "os";
import path from "path";
import fs from "fs";
import { sqlite } from "@/lib/db";
import { importCerebroCsv } from "@/modules/catalog/lib/keywords/import-cerebro";

// The 7 exports as downloaded (filenames include the source ASIN + date).
const FILES = [
  "round sunglases  US_AMAZON_cerebro_B087NL587P_2026-06-09.csv",
  "cat eye sunglasses US_AMAZON_cerebro_B0BM9JGLJS_2026-06-09.csv",
  "Square sunglasses US_AMAZON_cerebro_B0BZS2FXMH_2026-06-09.csv",
  "aviator sunglasses US_AMAZON_cerebro_B09RZS3B83_2026-06-09.csv",
  "oval sunglasses US_AMAZON_cerebro_B0F8HWPP54_2026-06-09.csv",
  "rectangle sunglasses US_AMAZON_cerebro_B0FR945GJF_2026-06-09.csv",
  "hexagon US_AMAZON_cerebro_B0F9F8ST4D_2026-06-09.csv",
];

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main() {
  const today = new Date().toISOString().slice(0, 10);
  const source = arg("--source") ?? `cerebro-${today}`;
  const dir = arg("--dir") ?? path.join(os.homedir(), "Downloads");

  console.log(`Importing Cerebro keywords → source="${source}" from ${dir}\n`);

  // Full-batch importer: reset this source first so re-running with
  // tuned scrub rules can't leave orphaned rows (a phrase that flips
  // keep→off_intent is no longer re-emitted, so upsert alone can't clear
  // it). Preserve manual overrides across the reset. Pass --no-reset to
  // append instead.
  let savedOverrides: Array<{ phrase: string; override_status: string }> = [];
  if (!process.argv.includes("--no-reset")) {
    savedOverrides = sqlite
      .prepare("SELECT phrase, override_status FROM catalog_keywords WHERE source = ? AND override_status IS NOT NULL")
      .all(source) as typeof savedOverrides;
    const del = sqlite.prepare("DELETE FROM catalog_keywords WHERE source = ?").run(source);
    if (del.changes > 0) {
      console.log(`  reset: cleared ${del.changes} existing rows for source (preserving ${savedOverrides.length} overrides)\n`);
    }
  }

  const totals = { keep: 0, brand: 0, irrelevant: 0, off_intent: 0, junk: 0 };
  let stored = 0;

  for (const file of FILES) {
    const full = path.join(dir, file);
    if (!fs.existsSync(full)) {
      console.warn(`  ⚠ missing: ${file} — skipped`);
      continue;
    }
    const s = importCerebroCsv(full, { source });
    stored += s.stored;
    for (const k of Object.keys(totals) as (keyof typeof totals)[]) {
      totals[k] += s.byVerdict[k];
    }
    const shapes = Object.entries(s.keepByShape)
      .sort((a, b) => b[1] - a[1])
      .map(([sh, n]) => `${sh}:${n}`)
      .join(" ");
    console.log(
      `  ${file.slice(0, 28).padEnd(30)} ${String(s.totalRows).padStart(6)} rows → ` +
      `keep ${String(s.byVerdict.keep).padStart(5)} | brand ${String(s.byVerdict.brand).padStart(4)} | ` +
      `irrel ${String(s.byVerdict.irrelevant).padStart(4)} | off ${String(s.byVerdict.off_intent).padStart(5)}  [${shapes}]`,
    );
  }

  // Re-apply any manual overrides that survived the reset.
  if (savedOverrides.length > 0) {
    const upd = sqlite.prepare("UPDATE catalog_keywords SET override_status = ? WHERE phrase = ? AND source = ?");
    let reapplied = 0;
    for (const o of savedOverrides) reapplied += upd.run(o.override_status, o.phrase, source).changes;
    console.log(`Re-applied ${reapplied}/${savedOverrides.length} overrides.`);
  }

  const distinct = sqlite.prepare("SELECT COUNT(*) c FROM catalog_keywords WHERE source = ?").get(source) as { c: number };
  console.log(
    `\nDone. ${distinct.c} distinct rows in table for this source. ` +
    `Run totals → keep ${totals.keep}, brand ${totals.brand}, ` +
    `irrelevant ${totals.irrelevant}, off_intent ${totals.off_intent}, junk ${totals.junk}`,
  );
}

main();
