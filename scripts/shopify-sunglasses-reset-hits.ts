/**
 * Reset the matched (has_sunglasses) stores from the crawler's
 * state log AND the products CSV, so a subsequent crawl re-crawls
 * just those stores with the new per-store cap.
 *
 * Use this when you've bumped STOP_AFTER_MATCHES and want the
 * old 5-per-store rows re-collected at the new cap (e.g. 25).
 *
 * Leaves no_sunglasses + error rows alone — those stay settled
 * and don't get re-crawled.
 *
 * Usage:
 *   npx tsx scripts/shopify-sunglasses-reset-hits.ts \
 *     [stateLog.jsonl] [productsCsv.csv]
 *
 * Defaults to the same paths the crawler uses
 * (~/Downloads/sunglasses-{state.jsonl, products.csv}).
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

function main() {
  const dl = (n: string) => path.join(os.homedir(), "Downloads", n);
  const statePath = process.argv[2] || dl("sunglasses-state.jsonl");
  const productsPath = process.argv[3] || dl("sunglasses-products.csv");

  if (!fs.existsSync(statePath)) {
    console.error(`State log not found: ${statePath}`);
    process.exit(1);
  }

  // Backup before mutating — Daniel's been bitten by data-loss
  // gotchas already today.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.copyFileSync(statePath, `${statePath}.${stamp}.bak`);
  if (fs.existsSync(productsPath)) {
    fs.copyFileSync(productsPath, `${productsPath}.${stamp}.bak`);
  }
  console.log(`Backups written with .${stamp}.bak suffix.\n`);

  // 1. Read state log, collect matched-store domains and the
  //    rows to keep. Last-line-wins per domain (matches StateLog's
  //    semantic).
  const lines = fs.readFileSync(statePath, "utf8").split("\n");
  const latestByDomain = new Map<string, { line: string; status: string }>();
  for (const raw of lines) {
    if (!raw.trim()) continue;
    try {
      const obj = JSON.parse(raw) as { domain?: string; status?: string };
      if (obj.domain && obj.status) {
        latestByDomain.set(obj.domain, { line: raw, status: obj.status });
      }
    } catch { /* skip partial last write */ }
  }

  const matchedDomains = new Set<string>();
  let droppedFromState = 0;
  const keptLines: string[] = [];
  for (const [domain, info] of Array.from(latestByDomain.entries())) {
    if (info.status === "has_sunglasses") {
      matchedDomains.add(domain);
      droppedFromState++;
    } else {
      keptLines.push(info.line);
    }
  }

  // 2. Rewrite state log atomically.
  const tmpState = `${statePath}.tmp`;
  fs.writeFileSync(tmpState, keptLines.join("\n") + (keptLines.length ? "\n" : ""));
  fs.renameSync(tmpState, statePath);

  console.log(`State log:`);
  console.log(`  matched (re-crawl):       ${matchedDomains.size.toLocaleString()}`);
  console.log(`  kept (no_sunglasses/err): ${keptLines.length.toLocaleString()}`);
  console.log(`  total before:             ${latestByDomain.size.toLocaleString()}`);

  // 3. Filter products CSV — drop rows whose domain is in
  //    matchedDomains. Keep the header line.
  if (!fs.existsSync(productsPath)) {
    console.log(`\nProducts CSV missing (${productsPath}) — nothing to filter.`);
    return;
  }
  const csvLines = fs.readFileSync(productsPath, "utf8").split("\n");
  if (csvLines.length === 0) {
    console.log(`\nProducts CSV empty.`);
    return;
  }

  // Find the domain column index from the header so we don't have
  // to parse every row as CSV.
  const header = csvLines[0];
  const cols = header.split(",").map((c) => c.trim());
  const domainIdx = cols.indexOf("domain");
  if (domainIdx === -1) {
    console.error(`Products CSV header missing 'domain' column — aborting.`);
    process.exit(1);
  }

  // Quick-and-dirty: split on commas. Domain column values from
  // the crawler never contain commas (it's a hostname), so this
  // is safe.
  let dropped = 0;
  let kept = 0;
  const newCsv: string[] = [header];
  for (let i = 1; i < csvLines.length; i++) {
    const line = csvLines[i];
    if (!line.trim()) continue;
    const fields = line.split(",");
    const dom = fields[domainIdx]?.trim();
    if (dom && matchedDomains.has(dom)) {
      dropped++;
    } else {
      newCsv.push(line);
      kept++;
    }
  }
  const tmpCsv = `${productsPath}.tmp`;
  fs.writeFileSync(tmpCsv, newCsv.join("\n") + "\n");
  fs.renameSync(tmpCsv, productsPath);

  console.log(`\nProducts CSV:`);
  console.log(`  rows dropped (will be re-crawled): ${dropped.toLocaleString()}`);
  console.log(`  rows kept:                         ${kept.toLocaleString()}`);

  console.log(`\nReady. Re-run the crawler — it'll re-crawl the ${matchedDomains.size.toLocaleString()} matched stores with the new STOP_AFTER_MATCHES cap.`);
}

main();
