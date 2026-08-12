import { compareStrength, hasReadingPowerSkus } from "@/modules/catalog/lib/reading-glasses";

export type ValidationSeverity = "ready" | "blocked" | "warning";

export interface ValidationIssue {
  field: string;
  message: string;
  severity: "blocked" | "warning";
}

export interface ProductValidationResult {
  productId: string;
  productName: string;
  skuPrefix: string;
  status: ValidationSeverity;
  issues: ValidationIssue[];
  skuResults: SkuValidationResult[];
}

export interface SkuValidationResult {
  skuId: string;
  sku: string;
  status: ValidationSeverity;
  issues: ValidationIssue[];
}

export interface ExportProduct {
  product: {
    id: string;
    skuPrefix: string;
    name: string | null;
    description: string | null;
    shortDescription: string | null;
    bulletPoints: string | null;
    category: string | null;
    frameShape: string | null;
    frameMaterial: string | null;
    gender: string | null;
    lensType: string | null;
    /** "spring" | "standard" | null (untagged). */
    hinge: string | null;
    // Physical frame dimensions in millimetres — see
    // src/modules/catalog/lib/frame-size.ts.
    lensWidth: number | null;
    bridgeWidth: number | null;
    templeLength: number | null;
    lensHeight: number | null;
    frameWidth: number | null;
    frameHeight: number | null;
    frameSize: string | null;
  };
  skus: {
    id: string;
    sku: string | null;
    colorName: string | null;
    /** Lens color, separate from the frame color in colorName. Drives the
     *  Shopify variant title `{Frame} Frame / {Lens} Lens` (Phase 5).
     *  Nullable — when absent, variant title falls back to single-axis. */
    lensColorName: string | null;
    colorHex: string | null;
    size: string | null;
    upc: string | null;
    inStock: boolean | null;
    /** Bare-frame weight in ounces (catalog_skus.weight_oz), from the
     *  factory size sheet. Null until measured. */
    weightOz: number | null;
    /** Reading-glasses diopter, e.g. 1.50. Null for sunglasses/optical. */
    readingPower: number | null;
    /** Reading-glasses blue-light coating flag. Null for sunglasses/optical. */
    hasBlueLightFilter: boolean | null;
    inventoryQuantity: number;
    costPrice: number | null;
  }[];
  images: {
    id: string;
    skuId: string;
    filePath: string | null;
    /** Absolute public URL (R2 CDN) when set — preferred over filePath. */
    url: string | null;
    width: number | null;
    height: number | null;
    status: string | null;
    isBest: boolean | null;
    source: string | null;
    imageTypeSlug: string | null;
  }[];
  tags: {
    tagName: string | null;
    dimension: string | null;
  }[];
  wholesalePrice: number | null;
  retailPrice: number | null;
  msrp: number | null;
}

/**
 * True when a product should be treated as reading glasses by the
 * channel exporters — i.e. it gets a Strength variation axis.
 *
 * Checks the tag-derived category first, then falls back to the SKU
 * data: bulk imports (import-po) don't always write the productType
 * tag, but their power SKUs are unambiguous.
 */
export function isReadingProduct(ep: ExportProduct): boolean {
  const cat = (ep.product.category ?? "").toLowerCase();
  if (cat === "reading" || cat === "reading_glasses") return true;
  return hasReadingPowerSkus(ep.skus);
}

/**
 * The SKUs that become real channel variants.
 *
 * For reading glasses the import stores a power-less colorway "base" row
 * (e.g. `JX3010-R-BLK`, readingPower null) alongside its seven power
 * rows. That base row is a grouping artifact — shipping it would create
 * a phantom variant with a blank Strength — so it is filtered out here,
 * and the remainder ordered by colorway then strength (Blue Light first).
 *
 * Everything else (sunglasses, optical) is returned untouched, so those
 * exports are byte-identical to before.
 */
export function variantSkus(ep: ExportProduct): ExportProduct["skus"] {
  if (!isReadingProduct(ep)) return ep.skus;
  const powered = ep.skus.filter((s) => s.readingPower != null);
  // A reader with no power rows at all (mid-import) still needs variants.
  if (powered.length === 0) return ep.skus;
  const colorOrder = new Map<string, number>();
  for (const s of ep.skus) {
    const key = s.colorName ?? "";
    if (!colorOrder.has(key)) colorOrder.set(key, colorOrder.size);
  }
  return [...powered].sort((a, b) => {
    const ca = colorOrder.get(a.colorName ?? "") ?? 0;
    const cb = colorOrder.get(b.colorName ?? "") ?? 0;
    return ca !== cb ? ca - cb : compareStrength(a, b);
  });
}
