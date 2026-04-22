/**
 * SKU parsing helpers for Jaxy SKUs.
 *
 * Jaxy SKU pattern: JX{factory_digit}{4-digit-style}-{color}
 * Examples:
 *   JX3004-BLK -> factory "JX3", style "3004", color "BLK"
 *   JX4012-TOR -> factory "JX4", style "4012", color "TOR"
 */

export const SKU_PATTERN = /^(JX\d)(\d+)-([A-Z0-9]+)$/i;

export type ParsedSku = {
  sku: string;
  factoryCode: string;
  styleCode: string;
  colorCode: string;
};

export function parseSku(sku: string): ParsedSku | null {
  const m = SKU_PATTERN.exec(sku.trim());
  if (!m) return null;
  return {
    sku: sku.trim().toUpperCase(),
    factoryCode: m[1].toUpperCase(),
    styleCode: m[2],
    colorCode: m[3].toUpperCase(),
  };
}

/**
 * Detect a single vendor (factory code) from a list of SKUs.
 * Throws if SKUs span multiple factories, or none match the pattern.
 */
export function detectVendor(skus: string[]): { vendor: string; unmatched: string[] } {
  const vendors = new Set<string>();
  const unmatched: string[] = [];
  for (const sku of skus) {
    const parsed = parseSku(sku);
    if (parsed) {
      vendors.add(parsed.factoryCode);
    } else {
      unmatched.push(sku);
    }
  }
  if (vendors.size === 0) {
    throw new Error(
      `Could not detect vendor from any SKU. Unmatched: ${unmatched.slice(0, 5).join(", ")}${unmatched.length > 5 ? "..." : ""}`
    );
  }
  if (vendors.size > 1) {
    throw new Error(
      `SKUs come from multiple factories: ${Array.from(vendors).sort().join(", ")}. Split into separate POs.`
    );
  }
  return { vendor: Array.from(vendors)[0], unmatched };
}

/**
 * Generate a PO number of the form {VENDOR}-{YYYYMMDD}, appending -A, -B, -C...
 * if the base is already taken in existingPoNumbers.
 */
export function autogeneratePoNumber(vendor: string, existingPoNumbers: Set<string>, today: Date = new Date()): string {
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, "0");
  const d = String(today.getDate()).padStart(2, "0");
  const base = `${vendor}-${y}${m}${d}`;
  if (!existingPoNumbers.has(base)) return base;
  for (let i = 1; i <= 26; i++) {
    const candidate = `${base}-${String.fromCharCode(64 + i)}`; // A=65
    if (!existingPoNumbers.has(candidate)) return candidate;
  }
  throw new Error("Too many PO collisions for one day. Provide a PO number manually.");
}

/**
 * Sum quantities for duplicate SKUs. Returns the consolidated list plus the
 * SKUs that were duplicated.
 */
export function consolidateDuplicates<T extends { sku: string; quantity: number; unitPrice?: number | null; vendorSku?: string | null }>(
  rows: T[]
): { rows: T[]; duplicates: string[] } {
  const byKey = new Map<string, T>();
  const dupes = new Set<string>();
  for (const r of rows) {
    const key = r.sku.toUpperCase();
    const prev = byKey.get(key);
    if (prev) {
      dupes.add(key);
      byKey.set(key, {
        ...prev,
        quantity: prev.quantity + r.quantity,
        unitPrice: r.unitPrice ?? prev.unitPrice ?? null,
        vendorSku: r.vendorSku ?? prev.vendorSku ?? null,
      } as T);
    } else {
      byKey.set(key, { ...r, sku: key } as T);
    }
  }
  return { rows: Array.from(byKey.values()), duplicates: Array.from(dupes) };
}
