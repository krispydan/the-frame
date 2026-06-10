/**
 * Validate the Amazon row-set for a product against the template snapshot.
 * Runs before download — if any blocked issue exists we refuse the
 * download instead of letting the user submit a spreadsheet Amazon will
 * silently reject.
 *
 * Severity model (matches src/modules/catalog/lib/export/types.ts):
 *   - blocked  : Amazon will reject the row. Required-empty, enum
 *                mismatch, malformed URL, length overflow, high-ASCII.
 *   - warning  : Amazon will accept but the listing will under-perform.
 *                Missing generic_keywords, missing other_image_url2+,
 *                short title, sub-3 bullets.
 *
 * The validator returns one ProductValidationResult per product (with
 * per-SKU drilldown via skuResults) so the UI can group issues sensibly
 * — Amazon's spreadsheet has parent+children rows but ops thinks in
 * products.
 */
import type {
  ProductValidationResult,
  SkuValidationResult,
  ValidationIssue,
} from "@/modules/catalog/lib/export/types";
import { getAmazonColumns, type AmazonColumnDef } from "./template-snapshot";

const HIGH_ASCII_RE = /[®©™™®©]/;

/** Rows the validator inspects — sparse Record<attr, string> from the mapper. */
export type AmazonRow = Record<string, string>;

export interface ValidateInput {
  productId: string;
  productName: string;
  skuPrefix: string;
  /** First row = parent, subsequent rows = children (one per SKU). */
  rows: AmazonRow[];
  /** Parallel to rows[1..] — used to attribute child-row issues back to their SKU. */
  skuIdentifiers: Array<{ skuId: string; sku: string }>;
}

function worst(issues: ValidationIssue[]): ProductValidationResult["status"] {
  if (issues.some((i) => i.severity === "blocked")) return "blocked";
  if (issues.some((i) => i.severity === "warning")) return "warning";
  return "ready";
}

/**
 * Per-cell rules driven entirely by the snapshot:
 *   - required + empty                       → blocked
 *   - has enumValues + value ∉ enumValues    → blocked
 *   - maxLength known + value too long       → blocked
 *   - main_image_url / other_image_url*      → blocked if not https://… or has whitespace
 *   - any text                               → blocked if contains ®©™ (Amazon rejects)
 */
/** Fields whose snapshot-required flag applies only to child rows in a
 *  Variation listing. Amazon's parent variant is non-purchasable and
 *  doesn't carry a UPC, EAN, or price — those live on each child. The
 *  snapshot marks them as required (true for non-variation single-SKU
 *  listings) but for parent/child the validator must skip them on the
 *  parent or we generate phantom 39-product-wide blocks for what is
 *  actually correct mapper output. */
const CHILD_ONLY_REQUIRED = new Set([
  "external_product_id",
  "external_product_id_type",
]);

function checkCell(
  col: AmazonColumnDef,
  value: string,
  /** "parent" or the SKU string. Drives which required-empty checks
   *  fire. */
  scope: string = "parent",
  /** Skip ALL required-empty checks — used for PartialUpdate feeds
   *  where omitted attributes keep their existing catalog values. */
  skipRequired = false,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const trimmed = value.trim();

  if (col.required && !trimmed) {
    if (skipRequired) return issues;
    // Skip required-empty on parent rows for fields that live only on
    // children in a Variation listing.
    const isParent = scope === "parent";
    if (isParent && CHILD_ONLY_REQUIRED.has(col.name)) {
      return issues;
    }
    issues.push({
      field: col.name,
      message: `Required (${col.group ?? "general"})`,
      severity: "blocked",
    });
    // No point running other checks against empty content.
    return issues;
  }
  if (!trimmed) return issues; // optional + empty → fine

  if (col.enumValues && col.enumValues.length > 0) {
    if (!col.enumValues.includes(trimmed)) {
      issues.push({
        field: col.name,
        message: `Not in enum (${col.enumValues.slice(0, 3).join(", ")}${col.enumValues.length > 3 ? ", …" : ""})`,
        severity: "blocked",
      });
    }
  }

  if (col.maxLength != null && trimmed.length > col.maxLength) {
    issues.push({
      field: col.name,
      message: `Length ${trimmed.length} > max ${col.maxLength}`,
      severity: "blocked",
    });
  }

  // URL columns: Amazon validates fetchability and complains about
  // whitespace or non-https. Name-pattern match because the snapshot
  // doesn't tag url-ness explicitly.
  if (/(_url|image_url)$/.test(col.name)) {
    if (/\s/.test(trimmed)) {
      issues.push({ field: col.name, message: "URL contains whitespace", severity: "blocked" });
    }
    if (!/^https:\/\//i.test(trimmed)) {
      issues.push({ field: col.name, message: "URL must start with https://", severity: "blocked" });
    }
  }

  // Trademark / registered glyphs cause Amazon to flag the listing as
  // unauthorized brand use even when the brand is your own.
  if (HIGH_ASCII_RE.test(trimmed)) {
    issues.push({
      field: col.name,
      message: "Contains ® / © / ™ — Amazon rejects high-ASCII glyphs",
      severity: "blocked",
    });
  }

  return issues;
}

/**
 * Soft checks that produce warnings only — won't block a download but
 * surface in the UI so ops can decide whether to ship suboptimal copy.
 */
function checkSoftRules(parent: AmazonRow): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const title = parent.item_name ?? "";
  // Amazon's sunglasses template caps item_name at 50 chars — verified
  // in the snapshot's Data Definitions. Target the upper half of that
  // window so we're keyword-rich without truncation risk.
  if (title && title.length < 35) {
    issues.push({
      field: "item_name",
      message: `Title is only ${title.length} chars — target 40-50 for max keyword density (hard cap is 50)`,
      severity: "warning",
    });
  }
  const bullets = [1, 2, 3, 4, 5].map((i) => parent[`bullet_point${i}`] ?? "");
  const populatedBullets = bullets.filter((b) => b.trim()).length;
  if (populatedBullets < 5) {
    issues.push({
      field: "bullet_points",
      message: `${populatedBullets}/5 bullets populated — Amazon shows all 5 above the fold`,
      severity: populatedBullets < 3 ? "blocked" : "warning",
    });
  }
  if (!parent.generic_keywords?.trim()) {
    issues.push({
      field: "generic_keywords",
      message: "No search keywords — listing won't surface for category queries",
      severity: "warning",
    });
  }
  // Only main + 1 other = thin listing. 4+ images is the sweet spot.
  const imageSlots = [
    "main_image_url", "other_image_url1", "other_image_url2", "other_image_url3",
    "other_image_url4", "other_image_url5", "other_image_url6", "other_image_url7",
    "other_image_url8",
  ];
  const populatedImages = imageSlots.filter((slot) => (parent[slot] ?? "").trim()).length;
  if (populatedImages < 4) {
    issues.push({
      field: "images",
      message: `${populatedImages}/9 image slots filled — 4+ images correlate with higher conversion`,
      severity: populatedImages < 1 ? "blocked" : "warning",
    });
  }

  return issues;
}

/**
 * Validate a single product's rows. The parent row is row 0; child rows
 * are 1..N, parallel to skuIdentifiers.
 */
export function validateProductRows(
  input: ValidateInput,
  opts?: { feedMode?: "establish" | "update" },
): ProductValidationResult {
  const columns = getAmazonColumns();
  const [parentRow, ...childRows] = input.rows;

  // PartialUpdate feeds (feedMode "update") only change the attributes
  // they carry — blank required columns keep their existing catalog
  // values, so required-empty must not block the batch.
  const skipRequired = opts?.feedMode === "update"
    || (parentRow?.update_delete === "PartialUpdate");

  const productIssues: ValidationIssue[] = [];

  // Cell-level checks against every populated column on every row.
  // We only check columns that appear in the snapshot — random extra keys
  // in the row dict are silently ignored (they won't make it into the
  // output spreadsheet since the writer walks snapshot column order).
  const checkRow = (row: AmazonRow, who: string): ValidationIssue[] => {
    const out: ValidationIssue[] = [];
    for (const col of columns) {
      const value = row[col.name];
      if (value == null) continue;
      // `who` is "parent" for the parent row, or the SKU string for
      // children. checkCell uses it to decide which required-empty
      // checks fire (e.g. external_product_id is skipped on parent).
      for (const issue of checkCell(col, value, who, skipRequired)) {
        out.push({ ...issue, field: `${who}.${issue.field}` });
      }
    }
    return out;
  };

  // Parent row: check required + enum + length + URL + high-ASCII.
  productIssues.push(...checkRow(parentRow ?? {}, "parent"));
  // Plus soft rules (title, bullets, images, keywords).
  productIssues.push(...checkSoftRules(parentRow ?? {}));

  // Child rows: per-SKU drilldown.
  const skuResults: SkuValidationResult[] = childRows.map((row, idx) => {
    const ident = input.skuIdentifiers[idx] ?? { skuId: `child_${idx}`, sku: row.item_sku ?? "?" };
    const issues = checkRow(row, ident.sku);
    return {
      skuId: ident.skuId,
      sku: ident.sku,
      status: worst(issues),
      issues,
    };
  });

  // Roll child-blocked issues up so the product is blocked overall when
  // any SKU is — UI surfaces both views.
  const allIssues = [...productIssues, ...skuResults.flatMap((s) => s.issues)];

  return {
    productId: input.productId,
    productName: input.productName,
    skuPrefix: input.skuPrefix,
    status: worst(allIssues),
    issues: productIssues,
    skuResults,
  };
}

/**
 * Validate a whole batch. Convenience over validateProductRows for the
 * download endpoint, which needs the array.
 */
export function validateAmazonBatch(
  inputs: ValidateInput[],
  opts?: { feedMode?: "establish" | "update" },
): ProductValidationResult[] {
  return inputs.map((i) => validateProductRows(i, opts));
}

/** Returns true when zero products have any blocked-severity issue. */
export function isBatchReleasable(results: ProductValidationResult[]): boolean {
  return results.every((r) => r.status !== "blocked");
}
