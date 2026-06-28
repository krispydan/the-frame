/**
 * Seed opening FIFO cost layers from the first 9 inbound shipments.
 *
 * These goods are ALREADY on the balance sheet in Inventory (1400) from the
 * factory + KCI/DHL bills, so seeding creates NO Xero entry — it only builds
 * the FIFO subledger so the daily COGS job has opening inventory to deplete.
 *
 * Landed cost is capitalized: each layer's per-unit cost = product + allocated
 * (freight + broker) + allocated duty. Freight + duty are allocated across the
 * shipment's lines BY VALUE (units × unitCost), matching how customs assesses
 * duty and giving a stable freight split when per-SKU weights aren't available.
 *
 * Guarded + idempotent: skips a line whose (po_number, sku) layer already
 * exists; refuses $0/implausible product cost; validates each shipment's units
 * + factory total against the COG report before writing.
 *
 * Usage:
 *   npx tsx scripts/seed-opening-cost-layers.ts                 # dry run
 *   npx tsx scripts/seed-opening-cost-layers.ts --apply         # write layers
 *   npx tsx scripts/seed-opening-cost-layers.ts path/to.json --apply
 */
import { readFileSync } from "node:fs";
import { createLayersForShipment, type ShipmentInput } from "@/modules/finance/lib/cogs-ingest";

interface SeedFile { shipments: ShipmentInput[] }

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const pathArg = args.find((a) => !a.startsWith("--")) || "scripts/data/opening-cost-layers.json";

const money = (n: number) => `$${n.toFixed(2)}`;

function main() {
  let file: SeedFile;
  try {
    file = JSON.parse(readFileSync(pathArg, "utf8"));
  } catch (e) {
    console.error(`Could not read seed data at ${pathArg}: ${e}`);
    process.exit(1);
  }

  console.log(`\n${apply ? "APPLYING" : "DRY RUN"} — opening cost layers from ${pathArg}\n`);

  let grandLanded = 0, grandCreated = 0, grandSkipped = 0;
  const problems: string[] = [];

  for (const s of file.shipments) {
    const tag = `${s.factory ?? ""} ${s.mode.toUpperCase()} (${s.poNumber}/${s.invoiceNumber ?? ""})`;
    if (s.lines.length === 0) { problems.push(`${tag}: no lines — skipped`); continue; }

    const r = createLayersForShipment(s, { apply });

    if (!r.validation.unitsOk || !r.validation.factoryOk) {
      problems.push(`${tag}: ${r.validation.message} — ${apply ? "NOT written" : "would block"}`);
    }
    for (const u of r.unmapped) problems.push(`${tag}: SKU ${u} not in catalog`);
    for (const rej of r.rejected) problems.push(`${tag}: ${rej.sku} rejected — ${rej.reason}`);

    grandCreated += r.created; grandSkipped += r.skipped; grandLanded += r.landedTotal;
    console.log(`${tag}`);
    console.log(`  units ${r.sumUnits} · factory ${money(r.sumFactory)} · freight ${money(s.freightTotal ?? 0)} · broker ${money(s.brokerTotal ?? 0)} · duty ${money(s.dutyTotal ?? 0)}`);
    console.log(`  landed ${money(r.landedTotal)}  →  ${r.created} layer(s) ${apply ? "created" : "would create"}${r.skipped ? `, ${r.skipped} already exist` : ""}${r.unmapped.length ? `, ${r.unmapped.length} unmapped` : ""}\n`);
  }

  console.log("──────────────────────────────────────────");
  console.log(`${apply ? "Created" : "Would create"} ${grandCreated} layers · ${grandSkipped} skipped`);
  console.log(`Total seeded landed cost: ${money(Math.round(grandLanded * 100) / 100)}  (COG report target: $81,245.77)`);
  if (problems.length) {
    console.log(`\n⚠️  ${problems.length} issue(s):`);
    for (const p of problems) console.log(`   - ${p}`);
    console.log(`\nFix the seed data so every shipment reconciles, then re-run.`);
  }
  if (!apply) console.log(`\nDry run only — re-run with --apply to write layers.`);
  console.log("");
}

main();
