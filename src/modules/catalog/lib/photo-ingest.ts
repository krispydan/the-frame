/**
 * Bulk product-photo ingestion — files route THEMSELVES by their
 * canonical names (photo-kinds.ts): `JX1019-R-BLK-SIDE_SQUARE_F8F9FA.jpg`
 * lands on that SKU as kind=square, angle=side, no manual mapping.
 *
 * One implementation, two front doors (repo convention): the MCP tool
 * `catalog.images.bulk_upload` and POST /api/v1/catalog/photos/bulk
 * both call ingestRoutedPhoto. Storage semantics deliberately match the
 * existing single-image MCP upload (media facade → R2 `url`, checksum
 * dedupe per SKU, `source` = kind tag, image_type = angle) so bulk and
 * single uploads produce indistinguishable rows.
 */
import { createHash } from "crypto";
import { sqlite } from "@/lib/db";
import { catalogImageUrl } from "@/lib/storage/image-url";
import { resolveCatalogSku } from "./sku-resolve";
import {
  parsePhotoFileName, getPhotoKind, ANGLE_TO_TYPE_SLUG, PHOTO_KINDS,
} from "./photo-kinds";

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

export interface RoutedTarget {
  skuId: string;
  sku: string;
  kind: string;
  /** catalog_image_types slug for the angle (sku-scope kinds). */
  angleSlug: string | null;
  /** True when a product-scope asset was attached to a representative SKU. */
  productScope: boolean;
}

/**
 * resolveCatalogSku plus the reverse-generation fallback: Drive files
 * predate the -S-/-R- split, so a legacy name (JX4011-BLK) must still
 * find its current-generation row (JX4011-S-BLK / -R-BLK).
 */
function resolveSkuAnyGeneration(sku: string): { skuId: string; catalogSku: string } | null {
  const direct = resolveCatalogSku(sku);
  if (direct) return direct;
  for (const gen of ["S", "R"]) {
    const candidate = sku.toUpperCase().replace(/^(JX\d{4})-(?![SR]-)/, `$1-${gen}-`);
    if (candidate !== sku.toUpperCase()) {
      const r = resolveCatalogSku(candidate);
      if (r) return r;
    }
  }
  return null;
}

/**
 * Resolve a photo filename to its DB target. Product-scope assets
 * attach to the style's first SKU.
 */
export function routePhotoFileName(fileName: string): { target?: RoutedTarget; error?: string } {
  const parsed = parsePhotoFileName(fileName);
  if (!parsed) return { error: "Filename doesn't follow the canonical convention" };

  if (parsed.scope === "product" || !parsed.sku) {
    const rep = sqlite.prepare(
      `SELECT s.id, s.sku FROM catalog_skus s JOIN catalog_products p ON p.id = s.product_id
        WHERE UPPER(p.sku_prefix) = ? OR s.sku LIKE ? ORDER BY s.sku LIMIT 1`,
    ).get(parsed.styleCode, `${parsed.styleCode}-%`) as { id: string; sku: string } | undefined;
    if (!rep) return { error: `No SKUs found for style ${parsed.styleCode}` };
    return { target: { skuId: rep.id, sku: rep.sku, kind: parsed.kind, angleSlug: null, productScope: true } };
  }

  const resolved = resolveSkuAnyGeneration(parsed.sku);
  if (!resolved) return { error: `SKU ${parsed.sku} not found in the catalog (tried aliases + both generations)` };

  const angleSlug = ANGLE_TO_TYPE_SLUG[parsed.angle] ?? "front";
  return {
    target: {
      skuId: resolved.skuId,
      // Photos are per COLOURWAY: report the power-collapsed root so a
      // reader file reads as "the colourway", not one arbitrary power
      // (storage still lands on the representative power row).
      sku: photoColorwayRoot(resolved.catalogSku),
      kind: parsed.kind,
      angleSlug,
      productScope: false,
    },
  };
}

/** Angle image-type row, created on first use (types predate this file
 *  but new angles must not hard-fail a bulk run). */
function ensureAngleType(slug: string): string {
  const existing = sqlite.prepare("SELECT id FROM catalog_image_types WHERE slug = ?").get(slug) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  sqlite.prepare(
    "INSERT INTO catalog_image_types (id, slug, label, platform, active, sort_order) VALUES (?, ?, ?, 'all', 1, 99)",
  ).run(id, slug, slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()));
  return id;
}

export interface IngestPhotoInput {
  bytes: Buffer;
  fileName: string;
  /** Explicit routing overrides — when absent, the filename decides. */
  sku?: string;
  kind?: string;
  angle?: string;
  altText?: string;
  isBest?: boolean;
  position?: number;
}

export interface IngestPhotoResult {
  fileName: string;
  status: "uploaded" | "deduped" | "failed";
  sku?: string;
  kind?: string;
  angle?: string | null;
  imageId?: string;
  url?: string | null;
  error?: string;
}

export async function ingestRoutedPhoto(input: IngestPhotoInput): Promise<IngestPhotoResult> {
  const { fileName } = input;
  try {
    // ── route ──
    let target: RoutedTarget;
    if (input.sku && input.kind) {
      const resolved = resolveSkuAnyGeneration(input.sku);
      if (!resolved) return { fileName, status: "failed", error: `SKU ${input.sku} not found` };
      if (!getPhotoKind(input.kind)) return { fileName, status: "failed", error: `Unknown kind '${input.kind}'` };
      target = {
        skuId: resolved.skuId,
        sku: photoColorwayRoot(resolved.catalogSku),
        kind: input.kind,
        angleSlug: input.angle ? (ANGLE_TO_TYPE_SLUG[input.angle.toUpperCase()] ?? input.angle.toLowerCase()) : "front",
        productScope: getPhotoKind(input.kind)!.scope === "product",
      };
    } else {
      const routed = routePhotoFileName(fileName);
      if (!routed.target) return { fileName, status: "failed", error: routed.error };
      target = routed.target;
      if (input.kind) target.kind = input.kind;
      if (input.angle) target.angleSlug = ANGLE_TO_TYPE_SLUG[input.angle.toUpperCase()] ?? input.angle.toLowerCase();
    }

    // ── decode + dedupe ──
    const sharp = (await import("sharp")).default;
    const meta = await sharp(input.bytes).metadata();
    if (!meta.format) return { fileName, status: "failed", error: "Not a decodable image" };
    if (input.bytes.length > 25 * 1024 * 1024) {
      return { fileName, status: "failed", error: `Too large (${input.bytes.length} bytes, max 25MB)` };
    }
    const mime = `image/${meta.format === "jpg" ? "jpeg" : meta.format}`;
    const checksum = createHash("sha256").update(input.bytes).digest("hex");
    // Dedupe across the whole COLOURWAY, not just the exact SKU row —
    // the same reader photo arriving named -100 and -200 is one photo.
    const existing = sqlite.prepare(`
      SELECT i.id, i.url FROM catalog_images i
      JOIN catalog_skus s ON s.id = i.sku_id
      WHERE i.checksum = ?
        AND (i.sku_id = ? OR UPPER(s.sku) LIKE ?)
      LIMIT 1
    `).get(checksum, target.skuId, `${target.sku}-%`) as { id: string; url: string | null } | undefined;
    if (existing) {
      return { fileName, status: "deduped", sku: target.sku, kind: target.kind, angle: target.angleSlug, imageId: existing.id, url: existing.url };
    }

    // ── store (media facade → R2 when configured) ──
    const { saveMedia, mediaUrl } = await import("@/lib/storage/media");
    const ext = EXT_BY_MIME[mime] ?? "jpg";
    const relPath = `${target.skuId}/${target.kind}/${checksum}.${ext}`;
    const key = `images/${relPath}`;
    await saveMedia(key, input.bytes, mime);
    const url = mediaUrl(key);

    const imageTypeId = target.angleSlug && !target.productScope ? ensureAngleType(target.angleSlug) : null;

    const id = crypto.randomUUID();
    if (input.isBest) {
      sqlite.prepare("UPDATE catalog_images SET is_best = 0 WHERE sku_id = ?").run(target.skuId);
    }
    sqlite.prepare(`
      INSERT INTO catalog_images
        (id, sku_id, file_path, url, file_size, mime_type, checksum, image_type_id,
         position, alt_text, width, height, status, is_best, uploaded_by, source, pipeline_status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, 'bulk', ?, 'completed', datetime('now'))
    `).run(
      id, target.skuId, relPath, url, input.bytes.length, mime, checksum, imageTypeId,
      input.position ?? 0, input.altText ?? null, meta.width ?? 0, meta.height ?? 0,
      input.isBest ? 1 : 0, target.kind,
    );

    return { fileName, status: "uploaded", sku: target.sku, kind: target.kind, angle: target.angleSlug, imageId: id, url };
  } catch (e) {
    return { fileName, status: "failed", error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Coverage ──

/**
 * Reader SKUs carry a magnification power (JX1019-R-BLK-100 … -300) but
 * the PHOTO is per colourway — same frames at every power. This strips
 * the power so coverage (and anything else photo-shaped) treats the
 * colourway root as one target instead of nagging once per power.
 */
export function photoColorwayRoot(sku: string): string {
  return sku.toUpperCase().replace(/^(JX\d{4}-R-[A-Z][A-Z0-9]{1,5})-\d{3}$/, "$1");
}

export interface SkuCoverageRow {
  /** Representative catalog_skus.id (lowest power for readers). */
  skuId: string;
  /** Colourway root — powers collapsed (JX1019-R-BLK, not …-100). */
  sku: string;
  productId: string;
  productName: string;
  colorName: string | null;
  /** How many catalog SKUs this row covers (reader powers); 1 otherwise. */
  variantCount: number;
  /** kind slug → { count, url of newest } */
  kinds: Record<string, { count: number; url: string | null; imageId: string }>;
  missingRequired: string[];
}

/**
 * The SKU × kind matrix: which photo kinds each SKU has, which required
 * ones are missing. Product-scope kinds roll up to every SKU of the
 * product (a collage covers all colourways). Kinds outside the registry
 * (legacy tags like 'card'/'upload') appear under their own name so
 * nothing silently disappears.
 */
export function photoCoverage(opts: { productId?: string; search?: string } = {}): SkuCoverageRow[] {
  const clauses: string[] = ["s.sku IS NOT NULL"];
  const params: unknown[] = [];
  if (opts.productId) { clauses.push("p.id = ?"); params.push(opts.productId); }
  for (const term of (opts.search ?? "").split(/\s+/).filter(Boolean)) {
    clauses.push("(p.name LIKE ? OR s.sku LIKE ? OR s.color_name LIKE ?)");
    const like = `%${term}%`;
    params.push(like, like, like);
  }

  const skus = sqlite.prepare(`
    SELECT s.id AS skuId, s.sku, s.color_name AS colorName, p.id AS productId, p.name AS productName
    FROM catalog_skus s JOIN catalog_products p ON p.id = s.product_id
    WHERE ${clauses.join(" AND ")}
    ORDER BY p.name, s.sku
  `).all(...params) as Array<{ skuId: string; sku: string; colorName: string | null; productId: string; productName: string }>;
  if (!skus.length) return [];

  const ph = skus.map(() => "?").join(",");
  const images = sqlite.prepare(`
    SELECT i.sku_id AS skuId, COALESCE(i.source, 'upload') AS kind, i.id AS imageId,
           i.url, i.file_path, i.created_at
    FROM catalog_images i WHERE i.sku_id IN (${ph})
    ORDER BY i.created_at ASC
  `).all(...skus.map((s) => s.skuId)) as Array<{ skuId: string; kind: string; imageId: string; url: string | null; file_path: string | null; created_at: string }>;

  // One row per COLOURWAY: reader power variants collapse onto their
  // root (first/lowest power is the representative), and an image
  // attached to ANY power counts for the whole colourway.
  const bySku = new Map<string, SkuCoverageRow>();
  const skuIdToRow = new Map<string, SkuCoverageRow>();
  for (const s of skus) {
    const root = photoColorwayRoot(s.sku);
    let row = bySku.get(`${s.productId}:${root}`);
    if (!row) {
      row = { ...s, sku: root, variantCount: 0, kinds: {}, missingRequired: [] };
      bySku.set(`${s.productId}:${root}`, row);
    }
    row.variantCount++;
    skuIdToRow.set(s.skuId, row);
  }
  const productKinds = new Map<string, Record<string, { count: number; url: string | null; imageId: string }>>();
  for (const img of images) {
    const row = skuIdToRow.get(img.skuId);
    if (!row) continue;
    const kindDef = getPhotoKind(img.kind);
    const bucket = kindDef?.scope === "product"
      ? (productKinds.get(row.productId) ?? productKinds.set(row.productId, {}).get(row.productId)!)
      : row.kinds;
    const cur = bucket[img.kind];
    // Later rows overwrite the url (ORDER BY created_at → newest wins).
    // Both storage generations serve: R2 `url` preferred, volume path proxied.
    bucket[img.kind] = {
      count: (cur?.count ?? 0) + 1,
      url: catalogImageUrl(img.file_path, img.url),
      imageId: img.imageId,
    };
  }
  // Roll product-scope assets up to every SKU of the product.
  for (const row of bySku.values()) {
    const shared = productKinds.get(row.productId);
    if (shared) row.kinds = { ...shared, ...row.kinds };
    row.missingRequired = PHOTO_KINDS.filter((k) => k.required && !row.kinds[k.slug]).map((k) => k.slug);
  }
  return [...bySku.values()];
}
