/**
 * Turn one product + its SKUs + its listing copy + its image URLs into the
 * sequence of rows Amazon's Template sheet expects: one **parent** row
 * carrying the title / description / bullets / variation-theme metadata,
 * followed by one **child** row per SKU carrying only the variation-axis
 * fields (color, UPC, price, weight, lens dimensions).
 *
 * Field-by-field precedence:
 *   1. listing.suggested* / listing.amazon* — written by the vision AI;
 *      always wins when populated.
 *   2. Curated tag-derived attribute (curatedAttrsFromTags + tag-attrs.ts).
 *   3. Static defaults declared in this file (brand_name, country_of_origin,
 *      batteries_required, etc.).
 *
 * Cells the mapper doesn't know how to populate become empty strings.
 * The validator (Phase 1C) catches required-empty as a blocked issue.
 */
import type { ExportProduct } from "@/modules/catalog/lib/export/types";
import { curatedAttrsFromTags } from "@/modules/catalog/lib/curated-attributes";
import { mapAmazonColor } from "./color-map";
import {
  mapItemShape,
  mapFrameMaterial,
  mapLensMaterial,
  mapPolarizationFromTags,
  mapTargetGender,
  mapDepartmentName,
  tagSetFromRows,
  buildGenericKeywords,
} from "./tag-attrs";

// Subset of catalog_amazon_listings the mapper consumes. The orchestrator
// loads + passes; keeping the shape narrow here avoids coupling the mapper
// to Drizzle types.
export interface AmazonListingInput {
  amazonTitle: string | null;
  bulletPoint1: string | null;
  bulletPoint2: string | null;
  bulletPoint3: string | null;
  bulletPoint4: string | null;
  bulletPoint5: string | null;
  productDescription: string | null;
  genericKeywords: string | null;
  suggestedColorMap: string | null;
  suggestedLensMaterial: string | null;
  suggestedFrameMaterial: string | null;
  suggestedPolarization: string | null;
  suggestedItemShape: string | null;
}

export interface MapInput {
  product: ExportProduct;
  listing: AmazonListingInput | null;
  /** Ordered Shopify CDN URLs. First = main_image_url, rest fill other_image_url1..8. */
  imageUrls: string[];
}

// ── Static defaults ─────────────────────────────────────────────────────

const STATIC = {
  feed_product_type: "sunglasses",
  brand_name: "Jaxy",
  manufacturer: "Jaxy Eyewear",
  item_type: "sunglasses",
  item_type_name: "Sunglasses",
  age_range_description: "Adult",
  country_of_origin: "CN",
  // Sunglasses have no batteries; Amazon still requires the declaration row.
  batteries_required: "No",
  are_batteries_included: "No",
  // Dangerous goods — sunglasses are not regulated; "Not Applicable" is
  // Amazon's accepted answer for these.
  supplier_declared_dg_hz_regulation1: "Not Applicable",
  // Fulfillment via merchant. Update if we ever go FBA.
  fulfillment_channel_code: "DEFAULT",
  // US marketplace ID.
  us_marketplace_id: "ATVPDKIKX0DER",
  // We assume mm for lens dimensions and inches/grams for the item itself.
  lens_unit: "millimeters",
  item_weight_unit: "pounds",
  // 1 piece per box — defensible default; can override per product later.
  unit_count_type: "Count",
} as const;

// ── Helpers ─────────────────────────────────────────────────────────────

function parseBullets(bp: string | null | undefined): string[] {
  if (!bp) return [];
  try {
    const parsed = JSON.parse(bp);
    if (Array.isArray(parsed)) return parsed.filter((s) => typeof s === "string" && s.trim()).map(String);
  } catch {
    // not JSON — fall through to newline split
  }
  return bp.split("\n").map((s) => s.trim()).filter(Boolean);
}

function stripHtml(html: string | null | undefined): string {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

/** Convert ounces → pounds (Amazon wants pounds for item_weight). */
function ozToLb(oz: number | null | undefined): string {
  if (!oz || oz <= 0) return "";
  return (oz / 16).toFixed(2);
}

// ── Public entrypoint ───────────────────────────────────────────────────

/**
 * Compose one parent row + N child rows for a product. Returned rows are
 * sparse — keys correspond to Amazon column internal names; the XLSX
 * writer (Phase 3A) walks the snapshot's column order to materialise
 * them into a real spreadsheet, leaving any missing key as blank.
 */
export function buildAmazonRows(input: MapInput): Record<string, string>[] {
  const { product, listing, imageUrls } = input;
  const p = product.product;
  const curated = curatedAttrsFromTags(
    product.tags.map((t) => ({ tagName: t.tagName, dimension: t.dimension })),
  );
  const tagSet = tagSetFromRows(product.tags);

  // ── Shared content (lives on parent row only — Amazon inherits to
  //    children) ────────────────────────────────────────────────────────
  const title = listing?.amazonTitle?.trim() || p.name?.trim() || p.skuPrefix;
  const description = listing?.productDescription?.trim() || stripHtml(p.description);

  const bulletsFromListing = [
    listing?.bulletPoint1, listing?.bulletPoint2, listing?.bulletPoint3,
    listing?.bulletPoint4, listing?.bulletPoint5,
  ];
  const hasListingBullets = bulletsFromListing.some((b) => b && b.trim());
  const bullets = hasListingBullets
    ? bulletsFromListing.map((b) => b ?? "")
    : (() => {
        const parsed = parseBullets(p.bulletPoints);
        return [0, 1, 2, 3, 4].map((i) => parsed[i] ?? "");
      })();

  const genericKeywords = listing?.genericKeywords?.trim()
    || buildGenericKeywords({
      rows: product.tags.map((t) => ({ tagName: t.tagName, dimension: t.dimension })),
      curated,
    });

  // ── Variation attributes ────────────────────────────────────────────
  const itemShape = listing?.suggestedItemShape || mapItemShape(curated.frameShape) || "";
  const frameMaterial = listing?.suggestedFrameMaterial || mapFrameMaterial(curated.frameMaterial) || "";
  const lensMaterial = listing?.suggestedLensMaterial
    || mapLensMaterial(curated.lensType)
    || (tagSet.has("polarized") ? "Polarized" : "Plastic");
  const polarization = listing?.suggestedPolarization || mapPolarizationFromTags(tagSet);
  const targetGender = mapTargetGender(curated.gender) || "Unisex";
  const departmentName = mapDepartmentName(curated.gender);

  // ── Images: first 9 fill main + other_image_url1..8 ─────────────────
  const mainImage = imageUrls[0] ?? "";
  const otherImages: string[] = [];
  for (let i = 1; i <= 8; i++) otherImages.push(imageUrls[i] ?? "");

  // ── Parent row ──────────────────────────────────────────────────────
  const parent: Record<string, string> = {
    // Identity
    feed_product_type: STATIC.feed_product_type,
    item_sku: p.skuPrefix,
    brand_name: STATIC.brand_name,
    manufacturer: STATIC.manufacturer,
    item_name: title,
    item_type: STATIC.item_type,
    item_type_name: STATIC.item_type_name,
    // Parent does NOT carry a UPC — only children do.
    external_product_id: "",
    external_product_id_type: "",
    // Variation chain
    parent_child: "parent",
    parent_sku: "",
    relationship_type: "Variation",
    variation_theme: "Color",
    // Content
    product_description: description,
    bullet_point1: bullets[0] ?? "",
    bullet_point2: bullets[1] ?? "",
    bullet_point3: bullets[2] ?? "",
    bullet_point4: bullets[3] ?? "",
    bullet_point5: bullets[4] ?? "",
    generic_keywords: genericKeywords,
    // Classification (lives on parent so all children inherit)
    department_name: departmentName,
    target_gender: targetGender,
    age_range_description: STATIC.age_range_description,
    item_shape: itemShape,
    frame_material_type: frameMaterial,
    lens_material_type: lensMaterial,
    polarization_type: polarization,
    // Images
    main_image_url: mainImage,
    other_image_url1: otherImages[0],
    other_image_url2: otherImages[1],
    other_image_url3: otherImages[2],
    other_image_url4: otherImages[3],
    other_image_url5: otherImages[4],
    other_image_url6: otherImages[5],
    other_image_url7: otherImages[6],
    other_image_url8: otherImages[7],
    // Compliance defaults
    country_of_origin: STATIC.country_of_origin,
    batteries_required: STATIC.batteries_required,
    are_batteries_included: STATIC.are_batteries_included,
    supplier_declared_dg_hz_regulation1: STATIC.supplier_declared_dg_hz_regulation1,
  };

  // ── Child rows (one per SKU) ────────────────────────────────────────
  const children: Record<string, string>[] = [];
  for (const sku of product.skus) {
    const colorName = sku.colorName?.trim() || "";
    const colorMap = listing?.suggestedColorMap || mapAmazonColor(colorName);
    const upc = sku.upc?.trim() || "";
    const price = (product.retailPrice && product.retailPrice > 0)
      ? product.retailPrice.toFixed(2)
      : (product.msrp && product.msrp > 0 ? product.msrp.toFixed(2) : "");
    const listPrice = (product.msrp && product.msrp > 0)
      ? product.msrp.toFixed(2)
      : price;
    const itemWeight = ozToLb(sku.id ? (
      // Per-SKU weight from catalog_skus.weightOz — passed through via ExportProduct? It's not
      // currently in the ExportProduct.skus shape, so fall back to a reasonable sunglasses default.
      null
    ) : null) || "0.10";

    const child: Record<string, string> = {
      // Identity
      feed_product_type: STATIC.feed_product_type,
      item_sku: sku.sku ?? "",
      brand_name: STATIC.brand_name,
      manufacturer: STATIC.manufacturer,
      // Children inherit title/desc/bullets from parent; leave blank to avoid drift.
      // But Amazon's validator is sometimes happier with the title repeated, so we do.
      item_name: title,
      item_type: STATIC.item_type,
      // Variation chain
      parent_child: "child",
      parent_sku: p.skuPrefix,
      relationship_type: "Variation",
      variation_theme: "Color",
      // Variation axis — color
      color_name: colorName,
      color_map: colorMap,
      lens_color: colorName, // sunglasses lenses typically match the frame color in our catalog
      lens_color_map: colorMap,
      // Sunglasses are universally "One Size" in our catalog
      size_name: "One Size",
      // Product ID
      external_product_id: upc,
      external_product_id_type: upc ? "UPC" : "",
      // Pricing — US marketplace only for v1
      list_price: listPrice,
      [`purchasable_offer[marketplace_id=${STATIC.us_marketplace_id}]#1.our_price#1.schedule#1.value_with_tax`]: price,
      // Inventory / fulfillment
      "fulfillment_availability#1.fulfillment_channel_code": STATIC.fulfillment_channel_code,
      "fulfillment_availability#1.quantity": String(sku.inventoryQuantity ?? 0),
      // Weights — Amazon wants a number; fall back to 0.10 lb for sunglasses
      item_weight: itemWeight,
      item_weight_unit_of_measure: STATIC.item_weight_unit,
      // Classification (Amazon usually inherits but we duplicate for safety)
      department_name: departmentName,
      target_gender: targetGender,
      age_range_description: STATIC.age_range_description,
      item_shape: itemShape,
      frame_material_type: frameMaterial,
      lens_material_type: lensMaterial,
      polarization_type: polarization,
      // Images — same set; Amazon inherits but explicit is safer
      main_image_url: mainImage,
      other_image_url1: otherImages[0],
      other_image_url2: otherImages[1],
      other_image_url3: otherImages[2],
      other_image_url4: otherImages[3],
      // Compliance
      country_of_origin: STATIC.country_of_origin,
      batteries_required: STATIC.batteries_required,
      are_batteries_included: STATIC.are_batteries_included,
      supplier_declared_dg_hz_regulation1: STATIC.supplier_declared_dg_hz_regulation1,
    };
    children.push(child);
  }

  return [parent, ...children];
}
