/**
 * Pack → unit normalization for COGS / FIFO.
 *
 * Some factory POs and ShipHero SKUs are expressed as packs (a 12-pack or
 * 4-pack), not individual units. Inventory, cost layers, and COGS must all
 * be in UNITS so a pack-PO and a unit-order deplete the same FIFO layers.
 *
 * Convention (matches the ShipHero UOM mapping in
 * src/modules/operations/lib/shiphero/uom-mapping.ts): a pack SKU carries a
 * `-<N>PK` suffix, e.g. `JX1001-BLK-12PK` = 12 × `JX1001-BLK`. A bare SKU
 * (`JX1001-BLK`) is a single unit.
 *
 * IMPORTANT accounting invariant: cost layers store cost PER UNIT. When a PO
 * line is a pack of N, multiply the line quantity by N to get the unit
 * count, and divide the line's landed cost by the unit count — NOT by the
 * pack count. Getting this asymmetric makes COGS off by a factor of N.
 */

const PACK_SUFFIX = /-(\d+)PK$/i;

/**
 * Number of individual units represented by one of this SKU.
 * `JX1001-BLK-12PK` → 12, `…-4PK` → 4, bare SKU → 1.
 * Returns 1 for null/empty/non-pack SKUs.
 */
export function parsePackSize(sku: string | null | undefined): number {
  if (!sku) return 1;
  const m = PACK_SUFFIX.exec(sku.trim());
  if (!m) return 1;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * Convert a quantity expressed in this SKU's unit-of-measure into individual
 * units. `unitsFor("JX1001-BLK-12PK", 100)` → 1200.
 */
export function unitsFor(sku: string | null | undefined, qty: number): number {
  return qty * parsePackSize(sku);
}

/**
 * The bare unit SKU for a (possibly-pack) SKU — strips the `-<N>PK` suffix so
 * pack-POs and unit-orders resolve to the same SKU for FIFO layer lookup.
 * `JX1001-BLK-12PK` → `JX1001-BLK`; bare SKU returned unchanged.
 */
export function unitSkuOf(sku: string | null | undefined): string | null {
  if (!sku) return null;
  return sku.trim().replace(PACK_SUFFIX, "");
}

/** True if the SKU is a multi-pack (has a `-<N>PK` suffix with N > 1). */
export function isPackSku(sku: string | null | undefined): boolean {
  return parsePackSize(sku) > 1;
}
