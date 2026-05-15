/**
 * Dedupe the `tags` JSON array on every prospect (companies) row.
 *
 * Usage (local against your dev DB, or after pulling a prod copy):
 *
 *   # Dry run — shows what would change
 *   npx tsx scripts/dedupe-prospect-tags.ts --dry-run
 *
 *   # Apply
 *   npx tsx scripts/dedupe-prospect-tags.ts
 *
 * For prod, prefer the admin endpoint:
 *
 *   curl -X POST https://theframe.getjaxy.com/api/v1/sales/prospects/dedupe-tags \
 *     -H "Content-Type: application/json" \
 *     -b "<your session cookie>" \
 *     -d '{"dryRun": true}'
 *
 * (DATABASE_PATH on Railway points at /data which doesn't exist locally,
 * so `railway run` invocations of this script will fail — use the
 * endpoint or `railway ssh` for prod.)
 */
import { dedupeAllProspectTags } from "@/modules/sales/lib/dedupe-tags";

function main() {
  const dryRun = process.argv.includes("--dry-run");
  console.log(`Dedupe prospect tags ${dryRun ? "(dry run)" : "(applying)"}...\n`);

  const result = dedupeAllProspectTags({ dryRun });

  for (const c of result.changes.slice(0, 50)) {
    const removedNote = c.removed === 1 ? "1 duplicate" : `${c.removed} duplicates`;
    console.log(`  ${c.id.slice(0, 8)}  ${c.name ?? "(no name)"}`);
    console.log(`    before (${c.before.length}): ${c.before.slice(0, 8).join(", ")}${c.before.length > 8 ? ", …" : ""}`);
    console.log(`    after  (${c.after.length}):  ${c.after.join(", ")}`);
    console.log(`    removed: ${removedNote}\n`);
  }
  if (result.changes.length > 50) {
    console.log(`  …and ${result.changes.length - 50} more.\n`);
  }
  if (result.malformed.length > 0) {
    console.log(`Malformed rows (not modified): ${result.malformed.length}`);
    for (const m of result.malformed.slice(0, 10)) {
      console.log(`  ${m.id.slice(0, 8)}  ${m.name ?? "(no name)"}: ${m.raw.slice(0, 80)}`);
    }
  }

  console.log("Summary:");
  console.log(`  scanned:       ${result.scanned}`);
  console.log(`  modified:      ${result.modified}`);
  console.log(`  total removed: ${result.totalRemoved}`);
  console.log(`  malformed:     ${result.malformed.length}`);
  process.exit(0);
}

main();
