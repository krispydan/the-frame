/**
 * One-shot backfill: walk every company row, compute its industry bucket
 * from its tags, and write it to companies.industry.
 *
 * Idempotent — re-running just overwrites with the same value. Safe to run
 * repeatedly while tweaking the rules in industry-mapping.ts.
 *
 * Usage:
 *   npx tsx scripts/backfill-industry.ts            # dry run (prints summary, no writes)
 *   npx tsx scripts/backfill-industry.ts --apply    # actually write to DB
 *   npx tsx scripts/backfill-industry.ts --apply --only=manual_review  # only rows where tags[0] matches
 */
import { sqlite } from "@/lib/db";
import {
  parseTagsBlob,
  mapTagsToIndustry,
  INDUSTRY_DISPLAY,
  type Industry,
} from "@/modules/sales/lib/industry-mapping";

interface Row { id: string; name: string; tags: string | null; industry: string | null }

function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const onlyArg = args.find((a) => a.startsWith("--only="));
  const onlyFilter = onlyArg ? onlyArg.slice("--only=".length) : null;

  console.log(`Mode: ${apply ? "LIVE (writes)" : "DRY RUN"}`);
  if (onlyFilter) console.log(`Filter: only rows whose tags[0] matches /${onlyFilter}/i`);

  const rows = sqlite.prepare(`SELECT id, name, tags, industry FROM companies`).all() as Row[];
  console.log(`Loaded ${rows.length} companies\n`);

  const counts: Record<Industry, number> = Object.fromEntries(
    (Object.keys(INDUSTRY_DISPLAY) as Industry[]).map((k) => [k, 0]),
  ) as Record<Industry, number>;

  let willUpdate = 0;
  let unchanged = 0;
  const onlyRe = onlyFilter ? new RegExp(onlyFilter, "i") : null;

  const updateStmt = sqlite.prepare("UPDATE companies SET industry = ? WHERE id = ?");
  const tx = sqlite.transaction((batch: Array<{ id: string; industry: string }>) => {
    for (const b of batch) updateStmt.run(b.industry, b.id);
  });

  const writeBatch: Array<{ id: string; industry: string }> = [];
  const BATCH_SIZE = 1000;

  for (const r of rows) {
    const tags = parseTagsBlob(r.tags);
    if (onlyRe && !(tags[0] && onlyRe.test(tags[0]))) continue;

    const m = mapTagsToIndustry(tags);
    counts[m.industry]++;

    if (r.industry === m.industry) {
      unchanged++;
      continue;
    }
    willUpdate++;

    if (apply) {
      writeBatch.push({ id: r.id, industry: m.industry });
      if (writeBatch.length >= BATCH_SIZE) {
        tx(writeBatch.splice(0, writeBatch.length));
      }
    }
  }

  if (apply && writeBatch.length > 0) tx(writeBatch);

  console.log("══ Distribution (proposed) ══");
  const ordered = (Object.keys(counts) as Industry[])
    .map((k) => ({ industry: k, label: INDUSTRY_DISPLAY[k].label, tier: INDUSTRY_DISPLAY[k].tier, count: counts[k] }))
    .sort((a, b) => b.count - a.count);
  // eslint-disable-next-line no-console
  console.table(ordered);

  console.log(`\nWould update: ${willUpdate}    Already correct: ${unchanged}`);
  if (apply) {
    console.log(`✓ ${willUpdate} rows updated.`);
  } else {
    console.log(`(Dry run — pass --apply to write.)`);
  }
}

main();
