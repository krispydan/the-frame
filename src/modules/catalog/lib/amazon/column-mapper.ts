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
  // Must match the country_of_origin enum from the template snapshot
  // verbatim — "CN" was a 2-letter code that the snapshot doesn't accept;
  // the snapshot's enum has full country names ("China", "United States").
  country_of_origin: "China",
  // Origin disclosure for the listing's Tech Specs panel. Snapshot enum:
  // ['Made in the USA or Imported', 'Imported', 'Made in the USA and
  // Imported', 'Made in the USA']. Jaxy frames are manufactured in
  // China so "Imported" is the truthful pick.
  import_designation: "Imported",
  // Sunglasses have no batteries; Amazon still requires the declaration row.
  batteries_required: "No",
  are_batteries_included: "No",
  // Dangerous goods — sunglasses are not regulated; "Not Applicable" is
  // Amazon's accepted answer for these.
  supplier_declared_dg_hz_regulation1: "Not Applicable",
  // Fulfillment via merchant. Must match the template enum verbatim.
  fulfillment_channel_code: "Fulfillment by Merchant (Default)",
  // US marketplace ID.
  us_marketplace_id: "ATVPDKIKX0DER",
  // Item weight unit must match the template enum exactly
  // (LB/OZ/KG/MG/GR). We weigh in ounces. Frame-dimension units live
  // per-field — see frameDimensionsBlock — because the template has
  // four separate *_unit_of_measure columns and no single "lens_unit".
  item_weight_unit: "OZ",
  // Per-unit PACKAGE dimensions + weight (the item in its retail
  // packaging). Amazon needs these to compute FBA fees, and the
  // Send-to-Amazon inbound flow blocks if they're missing from the
  // catalog. Every Jaxy frame ships in the same pouch/box: 8 x 3.5 x
  // 0.5 in, 2.5 oz. Units must match the enum exactly: IN / OZ.
  package_length: "8",
  package_width: "3.5",
  package_height: "0.5",
  package_dim_unit: "IN",
  package_weight: "2.5",
  package_weight_unit: "OZ",
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

/** Format a numeric ounce value for Amazon's item_weight field. We
 *  declare item_weight_unit_of_measure = "OZ" up top so the value
 *  passes through as-is rather than being converted to pounds. */
function ozAsString(oz: number | null | undefined): string {
  if (!oz || oz <= 0) return "";
  return oz.toFixed(2);
}

/** Default frame dimensions (mm) when the catalog row has none.
 *  Industry-standard medium-frame sizes for adult sunglasses — keeps
 *  Amazon's required-empty check happy without misrepresenting the
 *  product. Override in the catalog product editor when a specific
 *  frame has different specs. */
const FRAME_DIM_DEFAULTS = {
  lensWidth: 61,
  bridgeWidth: 18,
  templeLength: 146,
  lensHeight: 57,
} as const;

/** Map our catalog dimension fields → Amazon's dimension columns +
 *  per-field unit_of_measure cells. Three things this fixes vs the
 *  prior inline mapping:
 *
 *  1. Amazon's temple column is `arm_length`, not `temple_length`.
 *     Writing the wrong key meant the data was silently dropped at
 *     write time and the cell shipped blank.
 *  2. lens_width is REQUIRED per the snapshot, and the
 *     *_unit_of_measure enums want "MM" not "millimeters". The old
 *     `lens_unit` static was a free-text label that didn't match any
 *     Amazon column either.
 *  3. Defaults fill in industry-standard adult sunglasses dimensions
 *     when the catalog row has nulls, so validation doesn't block on
 *     "lens_width required" for products we haven't measured yet. */
function frameDimensionsBlock(p: {
  lensWidth: number | null;
  bridgeWidth: number | null;
  templeLength: number | null;
  lensHeight: number | null;
}): Record<string, string> {
  const lw = p.lensWidth ?? FRAME_DIM_DEFAULTS.lensWidth;
  const bw = p.bridgeWidth ?? FRAME_DIM_DEFAULTS.bridgeWidth;
  const tl = p.templeLength ?? FRAME_DIM_DEFAULTS.templeLength;
  const lh = p.lensHeight ?? FRAME_DIM_DEFAULTS.lensHeight;
  return {
    lens_width: String(lw),
    lens_width_unit_of_measure: "MM",
    bridge_width: String(bw),
    bridge_width_unit_of_measure: "MM",
    arm_length: String(tl),
    arm_length_unit_of_measure: "MM",
    lens_height: String(lh),
    lens_height_unit_of_measure: "MM",
  };
}

/** Per-unit package dimensions + weight, identical for every Jaxy
 *  frame (8 x 3.5 x 0.5 in, 2.5 oz). Required by the FBA inbound flow;
 *  emitted on both parent + child rows so the catalog has them
 *  regardless of which row Amazon reads. Eight cells: 3 dims + dim unit
 *  + weight + weight unit (package_*_unit_of_measure are per-field). */
function packageDimensionsBlock(): Record<string, string> {
  return {
    package_length: STATIC.package_length,
    package_length_unit_of_measure: STATIC.package_dim_unit,
    package_width: STATIC.package_width,
    package_width_unit_of_measure: STATIC.package_dim_unit,
    package_height: STATIC.package_height,
    package_height_unit_of_measure: STATIC.package_dim_unit,
    package_weight: STATIC.package_weight,
    package_weight_unit_of_measure: STATIC.package_weight_unit,
  };
}

/** Trim s to maxChars, breaking on the last whitespace before the cap so
 *  we don't lop mid-word. No ellipsis — Amazon's title field looks more
 *  natural with a clean cut than "…". */
function truncateAtWord(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  const slice = s.slice(0, maxChars);
  const lastSpace = slice.lastIndexOf(" ");
  // Don't truncate too aggressively — if the last space is in the first
  // ~70% of the slice, the result loses too many keywords. Take the
  // hard cut instead.
  if (lastSpace > maxChars * 0.6) return slice.slice(0, lastSpace).trim();
  return slice.trim();
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
  // Amazon's sunglasses template caps item_name at 50 chars (verified
  // against the snapshot's Data Definitions). The current AI prompt
  // doesn't enforce that limit, so most generated titles are 100-150
  // chars and fail validation. Truncate defensively at 50 chars on a
  // word boundary as a safety net — the prompt + regeneration is the
  // long-term fix.
  const rawTitle = listing?.amazonTitle?.trim() || p.name?.trim() || p.skuPrefix;
  const title = truncateAtWord(rawTitle, 50);
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
  // Per ops: Jaxy products are marketed for both men and women, so
  // target_gender always ships as Unisex regardless of any
  // gender-leaning tag the AI might have picked up. The "men and women"
  // intent maps to Amazon's "Unisex" enum value (target_gender enum is
  // single-select: Unisex / Female / Male).
  const targetGender = "Unisex";
  const departmentName = "Unisex Adult";
  // Per ops: parent's `model` field is the SKU prefix (JX4008), and
  // `model_name` is the marketing product name. Both fields are
  // optional on Amazon's snapshot but help dedup variation rollups in
  // Seller Central + appear on the listing's tech-specs panel.
  // model_name is capped at 50 chars per the snapshot, so apply the
  // same word-boundary truncate we use for item_name.
  const modelNumber = p.skuPrefix;
  const modelName = truncateAtWord(p.name?.trim() || p.skuPrefix, 50);

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
    model: modelNumber,
    model_name: modelName,
    item_name: title,
    item_type: STATIC.item_type,
    item_type_name: STATIC.item_type_name,
    // Parent does NOT carry a UPC — only children do.
    external_product_id: "",
    external_product_id_type: "",
    // Variation chain — enum values must match the template snapshot
    // exactly (Parent/Child capitalized; variation_theme uses Amazon's
    // exact format, not a free-text label).
    parent_child: "Parent",
    parent_sku: "",
    relationship_type: "Variation",
    // "color/lenscolor" = Amazon's two-axis theme covering frame color
    // (Amazon's "color_name") AND lens color (Amazon's "lens_color").
    // Matches Jaxy's actual SKU pattern: "Brown/Purple", "Green",
    // "Tortoise/Rose" — frame and lens vary together. "LensColor" alone
    // implied only the lens tint changed across SKUs, which isn't right.
    variation_theme: "color/lenscolor",
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
    // Frame dimensions (mm) — see frameDimensionsBlock for the mapping
    // rationale + default fallbacks for unmeasured products.
    ...frameDimensionsBlock(p),
    ...packageDimensionsBlock(),
    // Compliance defaults
    country_of_origin: STATIC.country_of_origin,
    import_designation: STATIC.import_designation,
    batteries_required: STATIC.batteries_required,
    are_batteries_included: STATIC.are_batteries_included,
    supplier_declared_dg_hz_regulation1: STATIC.supplier_declared_dg_hz_regulation1,
  };

  // ── Child rows (TWO per catalog SKU — one FBM, one FBA) ─────────────
  // Per ops: ship dual listings under the same parent so each colorway
  // has both an FBM offer (we ship via ShipHero) and an FBA offer
  // (Amazon ships from their warehouse for Prime eligibility). Same
  // physical product, same UPC on both — the only differences are
  // item_sku (FBA gets a "-FBA" suffix), the fulfillment_channel_code,
  // and we leave FBA's quantity blank so Amazon's inbound shipments
  // own the count rather than our number stomping theirs.
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
    const itemWeight = ozAsString(sku.id ? (
      // Per-SKU weight from catalog_skus.weightOz — passed through via ExportProduct? It's not
      // currently in the ExportProduct.skus shape, so fall back to a reasonable sunglasses default.
      null
    ) : null) || "1.60";

    const baseSku = sku.sku ?? "";
    // FBM child — operator-fulfilled (the default Jaxy flow via
    // ShipHero). Quantity carries over from the catalog row so Amazon
    // knows how many we have to sell.
    const fbmChild: Record<string, string> = {
      // Identity
      feed_product_type: STATIC.feed_product_type,
      item_sku: baseSku,
      brand_name: STATIC.brand_name,
      manufacturer: STATIC.manufacturer,
      // Same model + model_name across all children — they're parent-
      // identity attributes, but Amazon's processor wants them on each
      // row to dedup the variation rollup.
      model: modelNumber,
      model_name: modelName,
      // Children inherit title/desc/bullets from parent; leave blank to avoid drift.
      // But Amazon's validator is sometimes happier with the title repeated, so we do.
      item_name: title,
      item_type: STATIC.item_type,
      // Variation chain — enum values match the snapshot exactly.
      // parent_child = "Child" (capitalized); variation_theme must
      // match the parent and be one of Amazon's accepted values.
      parent_child: "Child",
      parent_sku: p.skuPrefix,
      relationship_type: "Variation",
      // "color/lenscolor" = Amazon's two-axis theme covering frame color
    // (Amazon's "color_name") AND lens color (Amazon's "lens_color").
    // Matches Jaxy's actual SKU pattern: "Brown/Purple", "Green",
    // "Tortoise/Rose" — frame and lens vary together. "LensColor" alone
    // implied only the lens tint changed across SKUs, which isn't right.
    variation_theme: "color/lenscolor",
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
      // Inventory / fulfillment — FBM defaults; the FBA twin built
      // below overrides channel + quantity.
      "fulfillment_availability#1.fulfillment_channel_code": STATIC.fulfillment_channel_code,
      "fulfillment_availability#1.quantity": String(sku.inventoryQuantity ?? 0),
      "fulfillment_availability#1.is_inventory_available": "Enabled",
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
      // Frame dimensions — duplicated from parent so child SKU rows
      // inherit correctly even when Amazon de-couples them.
      ...frameDimensionsBlock(p),
      ...packageDimensionsBlock(),
      // Compliance
      country_of_origin: STATIC.country_of_origin,
      import_designation: STATIC.import_designation,
      batteries_required: STATIC.batteries_required,
      are_batteries_included: STATIC.are_batteries_included,
      supplier_declared_dg_hz_regulation1: STATIC.supplier_declared_dg_hz_regulation1,
    };
    // FBA twin — Fulfilled by Amazon. Same physical product → same UPC,
    // same parent_sku, same color / lens_color / price / images. Three
    // overrides:
    //   1. item_sku gets "-FBA" suffix so the two offers don't collide.
    //   2. fulfillment_channel_code = Fulfillment by Amazon (NA).
    //   3. quantity is blank — Amazon's inbound shipments own the count
    //      on the FBA side; setting our own number would conflict with
    //      their warehouse receipts.
    const fbaChild: Record<string, string> = {
      ...fbmChild,
      item_sku: baseSku ? `${baseSku}-FBA` : "",
      "fulfillment_availability#1.fulfillment_channel_code": "Fulfillment by Amazon (NA)",
      "fulfillment_availability#1.quantity": "",
      "fulfillment_availability#1.is_inventory_available": "Enabled",
    };

    children.push(fbmChild, fbaChild);
  }

  return [parent, ...children];
}
