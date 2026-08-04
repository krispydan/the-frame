/**
 * One-shot Amazon historical backfill.
 *
 *   npx tsx scripts/amazon-backfill.ts --from 2026-06-01
 *   npx tsx scripts/amazon-backfill.ts --from 2026-06-01 --to 2026-08-03
 *   npx tsx scripts/amazon-backfill.ts --from 2026-06-01 --dry-run
 *
 * Run this once, early. Amazon serves settlements for 90 days only, so every
 * day this is deferred is a day of settlement history that becomes
 * permanently unrecoverable. Orders and traffic have longer upstream
 * retention, but settlements are the ones that expire.
 *
 * Safe to re-run: order rows upsert, settlement rows dedupe by count, and
 * traffic/inventory upsert by date. A second run costs time, not accuracy.
 */

import { backfillAmazon } from "@/modules/integrations/lib/amazon/sync";
import { getSyncState } from "@/modules/integrations/lib/amazon/ingest";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function isIsoDate(s: string | undefined): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

async function main() {
  const from = arg("from");
  const to = arg("to");
  const dryRun = process.argv.includes("--dry-run");

  if (!isIsoDate(from)) {
    console.error("Usage: tsx scripts/amazon-backfill.ts --from YYYY-MM-DD [--to YYYY-MM-DD] [--dry-run]");
    process.exit(1);
  }
  if (to !== undefined && !isIsoDate(to)) {
    console.error(`--to must be YYYY-MM-DD, got "${to}"`);
    process.exit(1);
  }
  if (!process.env.WINDSOR_API_KEY) {
    console.error("WINDSOR_API_KEY is not set. Export it (or add it to .env.local) and retry.");
    process.exit(1);
  }

  console.log(`\nAmazon backfill — from ${from}${to ? ` to ${to}` : ""}${dryRun ? " (DRY RUN)" : ""}`);

  if (dryRun) {
    console.log("\nDry run: no data will be written. Planned reports, in execution order:");
    console.log("  1. settlements        (90-day cap — the only irreplaceable data)");
    console.log("  2. orders by order date");
    console.log("  3. orders by last update");
    console.log("  4. sales & traffic");
    console.log("  5. FBA inventory snapshot");
    console.log("\nRe-run without --dry-run to execute.\n");
    return;
  }

  const started = Date.now();
  const result = await backfillAmazon({ from, to });

  console.log("\n── Results ──");
  for (const o of result.outcomes) {
    const status = o.ok ? "ok    " : "FAILED";
    const range = o.dateFrom ? ` ${o.dateFrom}..${o.dateTo}` : "";
    const counts = o.ingest
      ? ` received=${o.ingest.received} inserted=${o.ingest.inserted} updated=${o.ingest.updated} skipped=${o.ingest.skipped}`
      : "";
    console.log(`  ${status} ${o.report.padEnd(22)}${range}${counts} (${Math.round(o.durationMs / 1000)}s)`);
    if (!o.ok) console.log(`         ↳ ${o.errorKind}: ${o.error}`);
  }

  if (result.warnings.length > 0) {
    console.log("\n── Warnings ──");
    for (const w of result.warnings) console.log(`  • ${w}`);
  }

  console.log("\n── Sync state ──");
  for (const s of getSyncState()) {
    console.log(`  ${s.reportName.padEnd(22)} ${String(s.lastStatus).padEnd(8)} through=${s.lastSyncedThrough ?? "-"} rows=${s.rowsIngested}`);
  }

  const failed = result.outcomes.filter((o) => !o.ok);
  console.log(
    `\nInserted ${result.totalInserted}, updated ${result.totalUpdated}, rejected ${result.totalRejected} in ${Math.round((Date.now() - started) / 1000)}s.`,
  );

  if (failed.length > 0) {
    // Non-zero exit so a wrapper script or CI step notices. Reports that
    // merely timed out are worth simply re-running.
    console.log(`\n${failed.length} report(s) failed. Timeouts are common upstream — re-running usually clears them.`);
    process.exit(2);
  }
  console.log("All reports completed.\n");
}

main().catch((e) => {
  console.error("\nBackfill aborted:", e instanceof Error ? e.message : e);
  process.exit(1);
});
