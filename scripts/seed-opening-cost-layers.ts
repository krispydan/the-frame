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
import { sqlite } from "@/lib/db";
import { createCostLayer, ZeroCostError } from "@/modules/finance/lib/fifo-engine";

interface SeedLine { sku: string; units: number; unitCost: number }
interface SeedShipment {
  factory: string;
  mode: "air" | "ocean";
  poNumber: string;
  invoiceNumber: string;
  receivedAt: string;       // YYYY-MM-DD (ShipHero physical receipt date)
  freightTotal: number;     // freight + shipping
  brokerTotal: number;      // import entry / FDA / misc broker fees
  dutyTotal: number;
  expectedUnits: number;    // from the COG report, for validation
  expectedFactoryTotal: number;
  lines: SeedLine[];
}
interface SeedFile { shipments: SeedShipment[] }

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const pathArg = args.find((a) => !a.startsWith("--")) || "scripts/data/opening-cost-layers.json";

const round = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => `$${n.toFixed(2)}`;

function resolveSkuId(sku: string): string | null {
  const row = sqlite.prepare("SELECT id FROM catalog_skus WHERE sku = ? LIMIT 1").get(sku) as { id: string } | undefined;
  return row?.id ?? null;
}
function layerExists(poNumber: string, skuId: string): boolean {
  return !!sqlite.prepare(
    "SELECT id FROM inventory_cost_layers WHERE po_number = ? AND sku_id = ? LIMIT 1",
  ).get(poNumber, skuId);
}

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
    const sumUnits = s.lines.reduce((a, l) => a + l.units, 0);
    const sumFactory = round(s.lines.reduce((a, l) => a + l.units * l.unitCost, 0));
    const tag = `${s.factory} ${s.mode.toUpperCase()} (${s.poNumber}/${s.invoiceNumber})`;

    // Validation gate — refuse to seed a shipment whose lines don't reconcile.
    if (s.lines.length === 0) { problems.push(`${tag}: no lines — skipped`); continue; }
    if (sumUnits !== s.expectedUnits) {
      problems.push(`${tag}: units ${sumUnits} ≠ expected ${s.expectedUnits} — skipped`);
      continue;
    }
    if (Math.abs(sumFactory - s.expectedFactoryTotal) > 1.0) {
      problems.push(`${tag}: factory total ${money(sumFactory)} ≠ expected ${money(s.expectedFactoryTotal)} — skipped`);
      continue;
    }

    const freightPlusBroker = s.freightTotal + s.brokerTotal;
    let created = 0, skipped = 0, unmapped = 0, shipLanded = 0;

    for (const l of s.lines) {
      // Value-based allocation of freight+broker and duty (DB-independent).
      const valueShare = sumFactory > 0 ? (l.units * l.unitCost) / sumFactory : 0;
      const freightPerUnit = round((freightPlusBroker * valueShare) / l.units * 10000) / 10000;
      const dutiesPerUnit = round((s.dutyTotal * valueShare) / l.units * 10000) / 10000;
      shipLanded += (l.unitCost + freightPerUnit + dutiesPerUnit) * l.units;

      const skuId = resolveSkuId(l.sku);
      if (!skuId) {
        unmapped++;
        problems.push(`${tag}: SKU ${l.sku} not in catalog`);
        continue; // can't create a layer without a catalog SKU id
      }
      if (layerExists(s.poNumber, skuId)) { skipped++; grandSkipped++; continue; }

      if (apply) {
        try {
          createCostLayer({
            skuId, poNumber: s.poNumber, quantity: l.units,
            unitCost: l.unitCost, freightPerUnit, dutiesPerUnit,
            shippingMethod: s.mode, receivedAt: `${s.receivedAt}T12:00:00.000Z`,
          });
          created++;
        } catch (e) {
          if (e instanceof ZeroCostError) problems.push(`${tag}: ${l.sku} rejected — ${e.message}`);
          else throw e;
        }
      } else {
        created++; // would-create (SKU resolves)
      }
    }
    if (unmapped) console.log(`  (${unmapped} line(s) have no catalog SKU on this DB)`);

    grandCreated += created; grandLanded += shipLanded;
    console.log(`${tag}`);
    console.log(`  units ${sumUnits} · factory ${money(sumFactory)} · freight ${money(s.freightTotal)} · broker ${money(s.brokerTotal)} · duty ${money(s.dutyTotal)}`);
    console.log(`  landed ${money(round(shipLanded))}  →  ${created} layer(s) ${apply ? "created" : "would create"}${skipped ? `, ${skipped} already exist` : ""}\n`);
  }

  console.log("──────────────────────────────────────────");
  console.log(`${apply ? "Created" : "Would create"} ${grandCreated} layers · ${grandSkipped} skipped`);
  console.log(`Total seeded landed cost: ${money(round(grandLanded))}  (COG report target: $81,245.77)`);
  if (problems.length) {
    console.log(`\n⚠️  ${problems.length} issue(s):`);
    for (const p of problems) console.log(`   - ${p}`);
    console.log(`\nFix the seed data so every shipment reconciles, then re-run.`);
  }
  if (!apply) console.log(`\nDry run only — re-run with --apply to write layers.`);
  console.log("");
}

main();
