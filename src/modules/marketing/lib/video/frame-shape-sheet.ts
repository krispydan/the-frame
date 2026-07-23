/**
 * Catalog reference for the frame-shape matcher — one labelled image per
 * product.
 *
 * Originally this composited numbered contact-sheet grids, but the number
 * badges depended on fonts the production container doesn't have (they
 * rendered as tofu), and a big grid dilutes the model's attention anyway.
 * Now each product is sent as its OWN image block preceded by a plain-text
 * label ("#12 — Solstice (JX1006)") — no compositing, no fonts, and the
 * model can attend to each product photo individually.
 *
 * Building means downloading ~one image per product, so the prepared
 * reference is cached: in-memory for the process, and as a JSON blob in
 * storage keyed by a catalog signature (products + chosen images + tile
 * version). Signature change transparently invalidates both caches.
 */
import { createHash } from "crypto";
import sharp from "sharp";
import { sqlite } from "@/lib/db";
import { materializeMedia } from "@/lib/storage/media";
import { saveVideo, readVideo, videoStat } from "@/lib/storage/videos";

export interface CatalogItem {
  /** 1-based number in the reference — what the model returns. */
  index: number;
  productId: string;
  productName: string;
  sku: string;
  skuId: string;
  /** Text label preceding the image in the prompt. */
  label: string;
  /** Tile JPEG, base64. */
  base64: string;
}

export interface CatalogReference {
  items: CatalogItem[];
  sig: string;
}

/** Bump to invalidate cached tiles when rendering changes. */
const TILE_VERSION = "v3-labeled";
/** Square tile edge — small keeps tokens cheap, big enough to judge shape. */
const TILE = 192;

let cache: CatalogReference | null = null;

type ProductImage = { productId: string; productName: string; sku: string; skuId: string; imagePath: string };

/** One representative image + SKU per product (only products WITH an image). */
function loadProductImages(): ProductImage[] {
  const rows = sqlite
    .prepare(
      `SELECT p.id AS productId, p.name AS productName,
         (SELECT s.sku FROM catalog_skus s WHERE s.product_id = p.id AND s.sku IS NOT NULL ORDER BY s.sku ASC LIMIT 1) AS sku,
         (SELECT s.id  FROM catalog_skus s WHERE s.product_id = p.id AND s.sku IS NOT NULL ORDER BY s.sku ASC LIMIT 1) AS skuId,
         (SELECT i.file_path FROM catalog_images i JOIN catalog_skus s ON s.id = i.sku_id
            WHERE s.product_id = p.id AND i.file_path IS NOT NULL
            ORDER BY i.is_best DESC,
                     CASE i.status WHEN 'approved' THEN 0 WHEN 'review' THEN 1 ELSE 2 END,
                     i.position ASC
            LIMIT 1) AS imagePath
       FROM catalog_products p
       ORDER BY p.name ASC`,
    )
    .all() as Array<{ productId: string; productName: string; sku: string | null; skuId: string | null; imagePath: string | null }>;
  return rows.filter(
    (r): r is ProductImage => Boolean(r.imagePath) && Boolean(r.sku) && Boolean(r.skuId),
  );
}

/** Resize one catalog image to a square tile on white. */
async function tileBuffer(imagePath: string): Promise<Buffer> {
  const key = `images/${imagePath.replace(/^\/*(images\/)?/, "")}`;
  const m = await materializeMedia(key);
  try {
    return await sharp(m.path)
      .resize(TILE, TILE, { fit: "contain", background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: 82 })
      .toBuffer();
  } finally {
    await m.cleanup();
  }
}

const blobKey = (sig: string) => `shape-sheets/${sig}/catalog.json`;

/**
 * Build (or return cached) the labelled catalog reference. Item `index`
 * maps a model answer back to a product.
 */
export async function buildCatalogReference(): Promise<CatalogReference> {
  const prods = loadProductImages();
  const sig = createHash("sha256")
    .update(`${TILE_VERSION}|` + prods.map((p) => `${p.productId}:${p.imagePath}`).join("|"))
    .digest("hex")
    .slice(0, 16);
  if (cache?.sig === sig) return cache;

  // Storage fast-path (across restarts).
  const stat = await videoStat(blobKey(sig));
  if (stat.exists) {
    try {
      const items = JSON.parse((await readVideo(blobKey(sig))).toString()) as CatalogItem[];
      cache = { items, sig };
      return cache;
    } catch {
      /* rebuild below */
    }
  }

  const items: CatalogItem[] = [];
  for (let i = 0; i < prods.length; i++) {
    const p = prods[i];
    try {
      const buf = await tileBuffer(p.imagePath);
      items.push({
        index: items.length + 1,
        productId: p.productId,
        productName: p.productName,
        sku: p.sku,
        skuId: p.skuId,
        label: `#${items.length + 1} — ${p.productName} (${p.sku})`,
        base64: buf.toString("base64"),
      });
    } catch {
      /* skip products whose image fails to load */
    }
  }

  await saveVideo(Buffer.from(JSON.stringify(items)), blobKey(sig)).catch(() => {});
  cache = { items, sig };
  return cache;
}

/**
 * What the AI receives, for inspection in the review UI: the label + a
 * data URL per product (exact tile bytes it sees).
 */
export async function catalogReferenceForDisplay(): Promise<{
  sig: string;
  productCount: number;
  items: Array<{ index: number; label: string; productName: string; sku: string; imageDataUrl: string }>;
}> {
  const ref = await buildCatalogReference();
  return {
    sig: ref.sig,
    productCount: ref.items.length,
    items: ref.items.map((i) => ({
      index: i.index,
      label: i.label,
      productName: i.productName,
      sku: i.sku,
      imageDataUrl: `data:image/jpeg;base64,${i.base64}`,
    })),
  };
}
