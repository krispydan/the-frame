/**
 * Shipment → FIFO cost layers ingestion.
 *
 * The deterministic, DB-touching core shared by the opening-inventory seed
 * script and the `finance.create_cost_layers_from_shipment` MCP tool. Parsing
 * invoices (xlsx/xls/pdf/csv) is done by the caller (the agent has vision +
 * spreadsheet parsing); this module owns the accounting: validate → allocate
 * freight/duty by value → create guarded, idempotent layers.
 */
import { sqlite } from "@/lib/db";
import { createCostLayer, ZeroCostError } from "./fifo-engine";

export interface ShipmentLine { sku: string; units: number; unitCost: number }
export interface ShipmentInput {
  factory?: string;
  mode: "air" | "ocean";
  poNumber: string;
  invoiceNumber?: string;
  receivedAt: string;             // YYYY-MM-DD (ShipHero physical receipt date)
  freightTotal?: number;          // freight + shipping (allocated by value)
  brokerTotal?: number;           // import entry / FDA / misc broker fees
  dutyTotal?: number;             // allocated by value
  expectedUnits?: number;         // optional validation gate
  expectedFactoryTotal?: number;  // optional validation gate
  lines: ShipmentLine[];
}

export interface ShipmentResult {
  poNumber: string;
  sumUnits: number;
  sumFactory: number;
  landedTotal: number;
  created: number;
  skipped: number;            // layer already existed (idempotent)
  rejected: Array<{ sku: string; reason: string }>;   // $0/implausible cost
  unmapped: string[];         // SKU not in catalog
  validation: { unitsOk: boolean; factoryOk: boolean; message?: string };
}

const round = (n: number) => Math.round(n * 100) / 100;

function resolveSkuId(sku: string): string | null {
  const r = sqlite.prepare("SELECT id FROM catalog_skus WHERE sku = ? LIMIT 1").get(sku) as { id: string } | undefined;
  return r?.id ?? null;
}
function layerExists(poNumber: string, skuId: string): boolean {
  return !!sqlite.prepare("SELECT id FROM inventory_cost_layers WHERE po_number = ? AND sku_id = ? LIMIT 1").get(poNumber, skuId);
}

/**
 * Create cost layers for one shipment. Allocates (freight + broker) and duty
 * across the lines BY VALUE (units × unitCost), matching how customs assesses
 * duty. With apply=false it computes + validates but writes nothing (dry run).
 */
export function createLayersForShipment(s: ShipmentInput, opts: { apply: boolean }): ShipmentResult {
  const sumUnits = s.lines.reduce((a, l) => a + l.units, 0);
  const sumFactory = round(s.lines.reduce((a, l) => a + l.units * l.unitCost, 0));
  const freightPlusBroker = (s.freightTotal ?? 0) + (s.brokerTotal ?? 0);
  const dutyTotal = s.dutyTotal ?? 0;

  const res: ShipmentResult = {
    poNumber: s.poNumber, sumUnits, sumFactory, landedTotal: 0,
    created: 0, skipped: 0, rejected: [], unmapped: [],
    validation: { unitsOk: true, factoryOk: true },
  };

  // Optional validation gate — refuse to write a shipment that doesn't reconcile.
  if (s.expectedUnits != null && sumUnits !== s.expectedUnits) {
    res.validation.unitsOk = false;
    res.validation.message = `units ${sumUnits} ≠ expected ${s.expectedUnits}`;
  }
  if (s.expectedFactoryTotal != null && Math.abs(sumFactory - s.expectedFactoryTotal) > 1.0) {
    res.validation.factoryOk = false;
    res.validation.message = `${res.validation.message ? res.validation.message + "; " : ""}factory ${sumFactory} ≠ expected ${s.expectedFactoryTotal}`;
  }
  const blockWrite = opts.apply && (!res.validation.unitsOk || !res.validation.factoryOk);

  for (const l of s.lines) {
    const valueShare = sumFactory > 0 ? (l.units * l.unitCost) / sumFactory : 0;
    const freightPerUnit = round((freightPlusBroker * valueShare) / l.units * 10000) / 10000;
    const dutiesPerUnit = round((dutyTotal * valueShare) / l.units * 10000) / 10000;
    res.landedTotal += (l.unitCost + freightPerUnit + dutiesPerUnit) * l.units;

    const skuId = resolveSkuId(l.sku);
    if (!skuId) { res.unmapped.push(l.sku); continue; }
    if (layerExists(s.poNumber, skuId)) { res.skipped++; continue; }
    if (!opts.apply || blockWrite) { res.created++; continue; } // would-create

    try {
      createCostLayer({
        skuId, poNumber: s.poNumber, quantity: l.units,
        unitCost: l.unitCost, freightPerUnit, dutiesPerUnit,
        shippingMethod: s.mode, receivedAt: `${s.receivedAt}T12:00:00.000Z`,
      });
      res.created++;
    } catch (e) {
      if (e instanceof ZeroCostError) res.rejected.push({ sku: l.sku, reason: e.message });
      else throw e;
    }
  }

  res.landedTotal = round(res.landedTotal);
  return res;
}
