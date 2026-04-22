/**
 * Shopify CSV Export — ported from ~/jaxy-catalog-tool/src/lib/export/shopify.ts
 */
import type { ExportProduct, ValidationIssue, ProductValidationResult } from "./types";
import Papa from "papaparse";
import { catalogImageUrl } from "@/lib/storage/image-url";

function absUrl(filePath: string | null | undefined): string {
  return catalogImageUrl(filePath) || "";
}

const SHAPE_TAGS = new Set(["aviator", "cat-eye", "round", "square", "oversized", "rectangle", "wayfarer", "oval", "geometric"]);
const STYLE_TAGS = new Set(["retro", "vintage", "classic", "modern", "bold", "statement", "timeless", "trendy"]);

// Constant fields every Jaxy product shares
const JAXY_CONSTANTS = {
  productCategory: "Apparel & Accessories > Clothing Accessories > Sunglasses",
  ageGroup: "adults",
  hsCode: "9004.10",
  countryOfOrigin: "CN",
} as const;

// ─────────────────────────────────────────────────────────────────────
// Landed cost calculation
// ─────────────────────────────────────────────────────────────────────
//
// Shopify's "Cost per item" column drives the gross-margin figures in
// Shopify Analytics → Finance → Margin reports, the Profit report, and
// per-order profit calculations. If we ship the raw FOB number from
// catalog_skus.cost_price, every margin number in Shopify will be
// overstated by ~25–50% because it ignores duties and freight.
//
// We don't have per-shipment landed costs in the DB yet, so we apply a
// single deterministic adjustment to the FOB cost:
//
//   landed = (FOB × COST_LANDED_MULTIPLIER) + COST_LANDED_FLAT
//
// ── Why 1.25 × FOB (default multiplier) ───────────────────────────────
// For Chinese-manufactured sunglasses imported to the US on HS 9004.10
// the ad-valorem costs stack roughly like this:
//
//   US import duty on HS 9004.10 ............. ~2%
//   Section 301 China list 3 tariff .......... ~7.5% (25% post-Sept '25)
//   MPF + HMF fees ............................ ~0.3%
//   Customs broker fee (amortized) ............ ~3–5%
//   Foreign-trade handling + docs ............. ~2–3%
//   Contingency buffer ........................ ~3–5%
//                                              ─────
//                            total ad-valorem ≈ 20–25%
//
// User has confirmed 25% is the right figure for Jaxy's current lane,
// which also covers recent Section 301 increases on eyewear frames.
//
// ── Why +$0.50 flat (default adder) ───────────────────────────────────
// Freight scales with shipment density, not unit price, so a pure %
// multiplier under-allocates freight cost to cheap units. We know:
//
//   - Air-freight a full sunglasses carton costs ~$300–$400
//   - A carton holds ~500–800 units (light + small)
//   - ≈ $0.40–$0.60 freight per unit
//
// $0.50 is the conservative midpoint and matches what the user sees on
// recent shipments. Being slightly high here makes margin look
// slightly worse than reality, which is the safer reporting bias.
//
// ── Worked examples (at current DB FOB range) ─────────────────────────
//   $1.38 FOB → (1.38 × 1.25) + 0.50 = $2.23
//   $1.98 FOB → (1.98 × 1.25) + 0.50 = $2.98   ← current avg
//   $2.00 FOB → (2.00 × 1.25) + 0.50 = $3.00
//
// ── Tuning in production ──────────────────────────────────────────────
// Set in Railway env vars when real landed data is available:
//   COST_LANDED_MULTIPLIER=1.25
//   COST_LANDED_FLAT=0.50
//
// For higher fidelity later we can move to per-shipment landed costs
// on catalog_skus (add a `landed_cost` column, populate from broker
// invoices) and drop this heuristic.
// ─────────────────────────────────────────────────────────────────────
function getLandedCostAdjustment() {
  const mult = parseFloat(process.env.COST_LANDED_MULTIPLIER ?? "1.25");
  const flat = parseFloat(process.env.COST_LANDED_FLAT ?? "0.50");
  return {
    // Guard against garbage env values; fall back to defaults rather
    // than emit NaN into the CSV.
    multiplier: Number.isFinite(mult) && mult > 0 ? mult : 1.25,
    flat: Number.isFinite(flat) && flat >= 0 ? flat : 0.5,
  };
}

/**
 * Compute the landed cost (FOB + duties + freight) for a single SKU.
 * Emitted into Shopify's "Cost per item" column. See the long
 * explanation above for how the multiplier and flat adder are derived.
 *
 * Returns "" for missing/invalid FOB values so Shopify leaves the cell
 * blank (which Shopify treats as "no cost data" — different from 0.00
 * which would be a very misleading 100% margin).
 */
function landedCostFor(fob: number | null | undefined): string {
  if (fob == null || !Number.isFinite(fob) || fob <= 0) return "";
  const { multiplier, flat } = getLandedCostAdjustment();
  return (fob * multiplier + flat).toFixed(2);
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function joinWords(...parts: (string | null | undefined | false)[]): string {
  return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function truncateToWordBoundary(s: string, max: number): string {
  if (s.length <= max) return s;
  const trimmed = s.slice(0, max);
  const lastSpace = trimmed.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? trimmed.slice(0, lastSpace) : trimmed).replace(/[ ,\-]+$/, "");
}

interface SeoContext {
  name: string;         // "Havana Haze"
  shape: string;        // "round"
  style: string;        // "vintage" | "retro" | "classic" | ...
  gender: string;       // "women" | "men" | "unisex"
  isPolarized: boolean;
  hasUv400: boolean;
  colorLabel: string;   // "Brown" (already capitalized display form)
  keywordTag: string | null;
}

function buildSeoContext(
  productName: string,
  firstColorDisplay: string | null,
  tagsByDim: Map<string, string[]>,
  productGender: string | null,
  productFrameShape: string | null,
): SeoContext {
  const shape = (
    (tagsByDim.get("frame_shape") ?? tagsByDim.get("frameShape") ?? [])[0]
    ?? productFrameShape
    ?? ""
  ).toLowerCase();
  const style = (tagsByDim.get("style") ?? []).find((t) =>
    STYLE_TAGS.has(t.toLowerCase()),
  )?.toLowerCase() ?? "";
  const lensTags = (tagsByDim.get("lens") ?? []).map((t) => t.toLowerCase());
  const genderTagged = (tagsByDim.get("gender") ?? [])[0]?.toLowerCase() ?? "";
  const genderRaw = genderTagged || (productGender ?? "unisex").toLowerCase();
  const gender =
    genderRaw === "womens" ? "women"
    : genderRaw === "mens" ? "men"
    : genderRaw; // "unisex"
  const keywordTag = (tagsByDim.get("keyword") ?? [])[0] ?? null;
  return {
    name: productName,
    shape,
    style,
    gender,
    isPolarized: lensTags.includes("polarized"),
    hasUv400: lensTags.includes("uv400"),
    colorLabel: firstColorDisplay || "",
    keywordTag,
  };
}

/**
 * Product SEO title — target ≤60 chars for Google SERP.
 * Template: `{Style} {Shape} {Polarization} Sunglasses for {Gender} — {Name} | Jaxy`
 * Falls back gracefully when fields are empty.
 */
function buildSeoTitle(ctx: SeoContext): string {
  const descriptor = joinWords(
    capitalize(ctx.style),
    capitalize(ctx.shape),
    ctx.isPolarized ? "Polarized" : "",
    "Sunglasses",
  );
  const audience =
    ctx.gender === "women" ? "for Women"
    : ctx.gender === "men" ? "for Men"
    : ctx.gender === "unisex" ? "for Women & Men"
    : "";
  const lead = joinWords(descriptor, audience, `\u2014 ${ctx.name}`);
  // Always keep the brand suffix
  const full = `${lead} | Jaxy`;
  if (full.length <= 60) return full;
  // Drop the em-dash + product name section if too long, keep descriptor + brand
  const withoutName = `${joinWords(descriptor, audience)} | Jaxy`;
  if (withoutName.length <= 60) return withoutName;
  // Final fallback
  return truncateToWordBoundary(full, 57) + " | Jaxy";
}

/**
 * Image alt text — target ≤125 chars. Position-aware:
 *   - idx 0 (collection hero): "Jaxy {Name} — {Style} {Shape} {Polarization} sunglasses in {Colors}"
 *   - per-SKU front (variant image): "Jaxy {Name} in {Color} — {Shape} {Polarization} sunglasses"
 *   - angle shots: "Jaxy {Name} {Shape} sunglasses — {angle} view"
 *   - lifestyle: "Jaxy {Name} sunglasses styled — {imageTypeSlug | 'lifestyle'}"
 */
function buildImageAltText(
  ctx: SeoContext,
  role: { kind: "hero" } | { kind: "variant-front"; colorDisplay: string | null }
       | { kind: "angle"; angle: string } | { kind: "lifestyle"; label: string },
): string {
  const shapeBit = ctx.shape ? capitalize(ctx.shape) : "";
  const polBit = ctx.isPolarized ? "Polarized" : "";

  let alt = "";
  switch (role.kind) {
    case "hero": {
      const colors = ctx.colorLabel ? `in ${ctx.colorLabel}` : "";
      alt = joinWords(
        `Jaxy ${ctx.name} \u2014`,
        capitalize(ctx.style),
        shapeBit,
        polBit,
        "sunglasses",
        colors,
      );
      break;
    }
    case "variant-front": {
      const color = role.colorDisplay ? ` in ${role.colorDisplay}` : "";
      alt = joinWords(
        `Jaxy ${ctx.name}${color} \u2014`,
        shapeBit,
        polBit,
        "sunglasses",
      );
      break;
    }
    case "angle": {
      alt = joinWords(
        `Jaxy ${ctx.name}`,
        shapeBit,
        "sunglasses \u2014",
        role.angle,
        "view",
      );
      break;
    }
    case "lifestyle": {
      const label = role.label
        .replace(/^(lifestyle|studio)-?/, "")
        .replace(/-/g, " ")
        .trim() || "lifestyle";
      alt = joinWords(`Jaxy ${ctx.name} sunglasses styled \u2014`, label);
      break;
    }
  }
  return truncateToWordBoundary(alt, 125);
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export type ShopifyChannel = "retail" | "wholesale";

export function validateProductsForShopify(exportProducts: ExportProduct[], channel: ShopifyChannel = "retail"): ProductValidationResult[] {
  return exportProducts.map((ep) => {
    const issues: ValidationIssue[] = [];
    if (!ep.product.name?.trim()) issues.push({ field: "name", message: "Product name is required", severity: "blocked" });
    if (!ep.product.description?.trim()) issues.push({ field: "description", message: "Product description is required", severity: "blocked" });
    if (ep.skus.length === 0) issues.push({ field: "skus", message: "At least one SKU is required", severity: "blocked" });
    if (!ep.retailPrice) issues.push({ field: "retailPrice", message: "Retail price is required", severity: "blocked" });
    if (channel === "wholesale" && !ep.wholesalePrice) issues.push({ field: "wholesalePrice", message: "Wholesale price required", severity: "blocked" });
    const hasApproved = ep.images.some((i) => i.status === "approved");
    if (!hasApproved) issues.push({ field: "images", message: "At least one approved image required", severity: "blocked" });
    if (!ep.product.category) issues.push({ field: "category", message: "Category is not set", severity: "warning" });
    const hasError = issues.some((i) => i.severity === "blocked");
    const hasWarning = issues.some((i) => i.severity === "warning");
    return {
      productId: ep.product.id, productName: ep.product.name || ep.product.skuPrefix,
      skuPrefix: ep.product.skuPrefix,
      status: hasError ? "blocked" : hasWarning ? "warning" : "ready",
      issues, skuResults: [],
    };
  });
}

type ExportImage = ExportProduct["images"][number];

const EXTRA_ANGLES_FOR_MAIN_SKU = ["side", "other-side", "top"] as const;

function isLifestyleImage(img: ExportImage): boolean {
  const slug = img.imageTypeSlug ?? "";
  return slug.startsWith("lifestyle") || slug.startsWith("studio-");
}

/**
 * Build the Shopify image list for one product, in display order.
 *
 * RETAIL channel (consumer storefront):
 *   1. First SKU's front square (single-product hero — standard
 *      Shopify grid tile).
 *   2. Remaining SKU fronts (color swatches).
 *   3. First SKU's side / other-side / top (detail angles).
 *   4. Lifestyle / studio-* images if present.
 *   NOTE: the collection composite is deliberately EXCLUDED from
 *   retail — DTC shoppers see the multi-color composite as a category
 *   header, not a product image.
 *
 * WHOLESALE channel (Faire-style buyer-facing catalog):
 *   1. Collection composite first — wholesale buyers want to see all
 *      colorways on the grid tile at a glance (mirrors Faire).
 *   2. Per-SKU fronts.
 *   3. First SKU's angles.
 *   4. Lifestyle / studio-* images if present.
 *
 * Returns the ordered list and a per-SKU → front-image map used to
 * populate Shopify's "Variant Image" column so color-swatch selection
 * swaps to the right photo natively.
 *
 * Exported so the validator can stat exactly the files the CSV would
 * reference (and nothing extra).
 */
export function buildShopifyImageList(
  ep: ExportProduct,
  channel: ShopifyChannel = "retail",
): {
  productImages: ExportImage[];
  frontBySkuId: Map<string, ExportImage>;
} {
  const approved = ep.images.filter((i) => i.status === "approved" && i.filePath);

  const productImages: ExportImage[] = [];
  const collection = approved.find((i) => i.source === "collection");

  // Build per-SKU front map once — used for both channel branches and
  // for the CSV's "Variant Image" column.
  const frontBySkuId = new Map<string, ExportImage>();
  for (const sku of ep.skus) {
    const front = approved.find(
      (i) => i.skuId === sku.id && i.source === "square" && i.imageTypeSlug === "front",
    );
    if (front) frontBySkuId.set(sku.id, front);
  }
  const firstSkuFront = ep.skus[0] ? frontBySkuId.get(ep.skus[0].id) : undefined;

  if (channel === "wholesale") {
    // 1. Collection first (Faire-style hero)
    if (collection) productImages.push(collection);
    // 2. Per-SKU fronts
    for (const sku of ep.skus) {
      const f = frontBySkuId.get(sku.id);
      if (f) productImages.push(f);
    }
  } else {
    // RETAIL — collection composite is intentionally skipped
    // 1. First SKU's front as hero
    if (firstSkuFront) productImages.push(firstSkuFront);
    // 2. Remaining SKU fronts
    for (const sku of ep.skus) {
      const f = frontBySkuId.get(sku.id);
      if (f && !productImages.includes(f)) productImages.push(f);
    }
  }

  // 3. First SKU's other angles (product detail views)
  const firstSku = ep.skus[0];
  if (firstSku) {
    for (const angle of EXTRA_ANGLES_FOR_MAIN_SKU) {
      const img = approved.find(
        (i) => i.skuId === firstSku.id && i.source === "square" && i.imageTypeSlug === angle,
      );
      if (img) productImages.push(img);
    }
  }

  // 4. Lifestyle / studio scene images (any source, any SKU)
  for (const img of approved) {
    if (isLifestyleImage(img) && !productImages.includes(img)) {
      productImages.push(img);
    }
  }

  return { productImages, frontBySkuId };
}

export function generateShopifyCSV(exportProducts: ExportProduct[], channel: ShopifyChannel = "retail"): string {
  const rows: Record<string, string>[] = [];

  for (const ep of exportProducts) {
    const handle = slugify(ep.product.name || ep.product.skuPrefix || ep.product.id);
    const tagString = ep.tags.map((t) => t.tagName).filter(Boolean).join(", ");
    const lensTag = ep.tags.find((t) => t.dimension === "lens")?.tagName || "";

    // Group tags by dimension for easier lookup
    const tagsByDim = new Map<string, string[]>();
    for (const t of ep.tags) {
      if (!t.dimension || !t.tagName) continue;
      const arr = tagsByDim.get(t.dimension) ?? [];
      arr.push(t.tagName);
      tagsByDim.set(t.dimension, arr);
    }

    const { productImages, frontBySkuId } = buildShopifyImageList(ep, channel);

    // Alt-role map is populated below once firstSku is known.
    type AltRole =
      | { kind: "hero" }
      | { kind: "variant-front"; colorDisplay: string | null }
      | { kind: "angle"; angle: string }
      | { kind: "lifestyle"; label: string };
    const altRoleByImageId = new Map<string, AltRole>();

    const variantPrice = channel === "wholesale"
      ? ((ep.wholesalePrice && ep.wholesalePrice > 0) ? ep.wholesalePrice.toFixed(2) : "8.00")
      : ((ep.retailPrice && ep.retailPrice > 0) ? ep.retailPrice.toFixed(2) : "24.00");
    // Wholesale never shows a compare-at price — retailers set their own
    // retail margin, so any strike-through would be misleading.
    // Retail uses MSRP for the compare-at strike-through.
    const compareAtPrice = channel === "wholesale"
      ? ""
      : ((ep.msrp && ep.msrp > 0) ? ep.msrp.toFixed(2) : "");

    const firstSku = ep.skus[0];
    const firstImage = productImages[0];
    const firstVariantImage = firstSku ? frontBySkuId.get(firstSku.id) : undefined;

    // Build SEO + alt context now that firstSku is known.
    const seoCtx = buildSeoContext(
      ep.product.name || ep.product.skuPrefix || "",
      firstSku?.colorName ?? null,
      tagsByDim,
      ep.product.gender,
      ep.product.frameShape,
    );
    const seoTitle = buildSeoTitle(seoCtx);

    // Seed alt-role map (populated now that we know firstSku/productImages).
    if (productImages[0]?.source === "collection") {
      altRoleByImageId.set(productImages[0].id, { kind: "hero" });
    }
    for (const sku of ep.skus) {
      const front = frontBySkuId.get(sku.id);
      if (front) {
        altRoleByImageId.set(front.id, { kind: "variant-front", colorDisplay: sku.colorName || null });
      }
    }
    if (firstSku) {
      for (const angle of EXTRA_ANGLES_FOR_MAIN_SKU) {
        const img = productImages.find((i) => i.skuId === firstSku.id && i.imageTypeSlug === angle);
        if (img) altRoleByImageId.set(img.id, { kind: "angle", angle });
      }
    }
    for (const img of productImages) {
      if (!altRoleByImageId.has(img.id)) {
        altRoleByImageId.set(img.id, { kind: "lifestyle", label: img.imageTypeSlug ?? "lifestyle" });
      }
    }
    if (productImages[0] && !altRoleByImageId.has(productImages[0].id)) {
      altRoleByImageId.set(productImages[0].id, { kind: "hero" });
    }
    const altFor = (img: ExportImage | undefined): string => {
      if (!img) return "";
      const role = altRoleByImageId.get(img.id) ?? ({ kind: "hero" } as AltRole);
      return buildImageAltText(seoCtx, role);
    };

    rows.push({
      Handle: handle, Title: ep.product.name || "", "Body (HTML)": ep.product.description || "",
      Vendor: "Jaxy",
      "Product Category": JAXY_CONSTANTS.productCategory,
      Type: ep.product.category || "Sunglasses",
      Tags: tagString, Published: "TRUE",
      "Option1 Name": ep.skus.length > 1 ? "Color" : "Title",
      "Option1 Value": firstSku?.colorName || "Default Title",
      "Variant SKU": firstSku?.sku || "",
      "Variant Inventory Tracker": "shopify",
      "Variant Inventory Policy": "continue",
      "Variant Fulfillment Service": "manual",
      "Variant Price": variantPrice,
      "Variant Compare At Price": compareAtPrice,
      "Variant Requires Shipping": "true",
      "Variant Taxable": "true",
      "Variant HS Code": JAXY_CONSTANTS.hsCode,
      "Variant Country of Origin": JAXY_CONSTANTS.countryOfOrigin,
      "Variant Image": absUrl(firstVariantImage?.filePath),
      "Variant Weight Unit": "oz",
      "Cost per item": landedCostFor(firstSku?.costPrice ?? null),
      "Image Src": absUrl(firstImage?.filePath), "Image Position": firstImage ? "1" : "",
      "Image Alt Text": altFor(firstImage),
      "SEO Title": seoTitle, "SEO Description": ep.product.shortDescription || "",
      Status: "active",
      "Metafield: custom.lens_type [single_line_text_field]": lensTag,
      // Shopify's standard shopify.* metafields (age-group, color-pattern,
      // eyewear-frame-color/design, lens-color, lens-polarization,
      // target-gender) are metaobject references, not plain text —
      // CSV import rejects string values with "Value require that you
      // select a metaobject". Set these once per product in Shopify's
      // Bulk Editor UI where the taxonomy picker resolves metaobject
      // GIDs natively. Keeping `custom.lens_type` because it's a
      // free-text metafield we own.
    });

    for (let i = 1; i < ep.skus.length; i++) {
      const sku = ep.skus[i];
      const variantImage = frontBySkuId.get(sku.id);
      rows.push({
        Handle: handle, Title: "", "Body (HTML)": "", Vendor: "",
        "Product Category": "",
        Type: "", Tags: "", Published: "",
        "Option1 Name": "", "Option1 Value": sku.colorName || "",
        "Variant SKU": sku.sku || "",
        "Variant Inventory Tracker": "shopify",
        "Variant Inventory Policy": "continue",
        "Variant Fulfillment Service": "manual",
        "Variant Price": variantPrice,
        "Variant Compare At Price": compareAtPrice,
        "Variant Requires Shipping": "true",
        "Variant Taxable": "true",
        "Variant HS Code": JAXY_CONSTANTS.hsCode,
        "Variant Country of Origin": JAXY_CONSTANTS.countryOfOrigin,
        "Variant Image": absUrl(variantImage?.filePath),
        "Variant Weight Unit": "oz",
        "Cost per item": landedCostFor(sku.costPrice ?? null),
        "Image Src": "", "Image Position": "", "Image Alt Text": "", "SEO Title": "", "SEO Description": "",
        Status: "",
        "Metafield: custom.lens_type [single_line_text_field]": "",
      });
    }

    for (let i = 1; i < productImages.length; i++) {
      rows.push({
        Handle: handle, Title: "", "Body (HTML)": "", Vendor: "",
        "Product Category": "",
        Type: "", Tags: "", Published: "",
        "Option1 Name": "", "Option1 Value": "", "Variant SKU": "",
        "Variant Inventory Tracker": "",
        "Variant Inventory Policy": "",
        "Variant Fulfillment Service": "",
        "Variant Price": "",
        "Variant Compare At Price": "",
        "Variant Requires Shipping": "",
        "Variant Taxable": "",
        "Variant HS Code": "",
        "Variant Country of Origin": "",
        "Variant Image": "",
        "Variant Weight Unit": "",
        "Cost per item": "",
        "Image Src": absUrl(productImages[i].filePath), "Image Position": String(i + 1),
        "Image Alt Text": altFor(productImages[i]),
        "SEO Title": "", "SEO Description": "",
        Status: "",
        "Metafield: custom.lens_type [single_line_text_field]": "",
      });
    }
  }

  return Papa.unparse(rows, { header: true });
}
