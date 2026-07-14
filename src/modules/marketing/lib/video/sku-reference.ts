/**
 * Catalog reference sheets for AI SKU identification.
 *
 * Builds labeled contact sheets (like the hand-made "side reference" PDF,
 * but always in sync with the catalog): one thumbnail per SKU colorway
 * with a "Product Name · JX1005-OLV" caption, tiled into a small number
 * of JPEG grids the vision model can take alongside the frame to
 * identify. Cached in media storage under images/_sku_reference/ and
 * rebuilt only when the catalog's images change (fingerprint).
 */
import { createHash } from "crypto";
import sharp from "sharp";
import { sqlite } from "@/lib/db";
import { readImage } from "@/lib/storage/local";
import { readFromR2IfPresent, saveMedia, readMedia, mediaStat } from "@/lib/storage/media";

// Grid geometry. 4 × 6 = 24 SKUs per sheet → ~5 sheets for a 115-SKU
// catalog. Cells are small but plenty for frame-shape/color matching.
const COLS = 4;
const ROWS = 6;
const CELL_W = 280;
const IMG_H = 190;
const CAPTION_H = 46;
const CELL_H = IMG_H + CAPTION_H;
const SHEET_W = COLS * CELL_W;
const SHEET_H = ROWS * CELL_H;

const META_KEY = "images/_sku_reference/meta.json";
const sheetKey = (i: number) => `images/_sku_reference/sheet-${i}.jpg`;

export interface ReferenceSku {
  skuId: string;
  sku: string;             // e.g. JX1005-OLV
  productId: string;
  productName: string;
  colorName: string | null;
  imagePath: string;       // catalog_images.file_path
}

/**
 * One best image per SKU: isBest first, then approved, then anything
 * with a local file. SKUs without a stored image are skipped (they
 * can't be visually matched).
 */
export function loadReferenceSkus(): ReferenceSku[] {
  return sqlite.prepare(`
    SELECT s.id AS skuId, s.sku, p.id AS productId, p.name AS productName,
           s.color_name AS colorName,
           (SELECT i.file_path FROM catalog_images i
             WHERE i.sku_id = s.id AND i.file_path IS NOT NULL
             ORDER BY i.is_best DESC,
                      CASE i.status WHEN 'approved' THEN 0 WHEN 'review' THEN 1 ELSE 2 END,
                      i.position ASC
             LIMIT 1) AS imagePath
    FROM catalog_skus s
    JOIN catalog_products p ON p.id = s.product_id
    WHERE s.sku IS NOT NULL
    ORDER BY p.name ASC, s.sku ASC
  `).all() as Array<ReferenceSku & { imagePath: string | null }> as ReferenceSku[];
}

/** Read catalog image bytes: local volume first, then R2 (post-migration). */
async function readImageBytes(filePath: string): Promise<Buffer | null> {
  try {
    return await readImage(filePath);
  } catch {
    return readFromR2IfPresent(`images/${filePath}`);
  }
}

/** XML-escape for the SVG caption. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function buildCell(ref: ReferenceSku): Promise<Buffer | null> {
  const bytes = await readImageBytes(ref.imagePath);
  if (!bytes) return null;
  const thumb = await sharp(bytes)
    .resize(CELL_W - 8, IMG_H - 8, { fit: "contain", background: "#ffffff" })
    .toBuffer()
    .catch(() => null);
  if (!thumb) return null;

  const caption = Buffer.from(
    `<svg width="${CELL_W}" height="${CAPTION_H}">
      <rect width="100%" height="100%" fill="#ffffff"/>
      <text x="${CELL_W / 2}" y="17" text-anchor="middle" font-family="Arial" font-size="14" fill="#111">${esc(ref.productName)}</text>
      <text x="${CELL_W / 2}" y="36" text-anchor="middle" font-family="Arial" font-size="14" font-weight="bold" fill="#c00">${esc(ref.sku)}</text>
    </svg>`,
  );

  return sharp({
    create: { width: CELL_W, height: CELL_H, channels: 3, background: "#ffffff" },
  })
    .composite([
      { input: thumb, top: 4, left: 4 },
      { input: caption, top: IMG_H, left: 0 },
    ])
    .jpeg({ quality: 82 })
    .toBuffer();
}

interface SheetMeta {
  fingerprint: string;
  sheetCount: number;
  skuCount: number;
  builtAt: string;
}

/** Fingerprint of the catalog's reference inputs — image path per SKU. */
function catalogFingerprint(refs: ReferenceSku[]): string {
  return createHash("sha256")
    .update(refs.map((r) => `${r.sku}|${r.imagePath}`).join("\n"))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Return the current reference sheets as JPEG buffers, rebuilding from
 * the catalog when stale. Also returns the SKUs included (in sheet
 * order) so the matcher can map model answers back to catalog rows.
 */
export async function getReferenceSheets(): Promise<{
  sheets: Buffer[];
  skus: ReferenceSku[];
}> {
  const refs = loadReferenceSkus().filter((r) => r.imagePath);
  if (refs.length === 0) throw new Error("No catalog images available to build SKU reference sheets");
  const fingerprint = catalogFingerprint(refs);

  // Serve the cached build when the catalog hasn't changed.
  try {
    const metaStat = await mediaStat(META_KEY);
    if (metaStat.exists) {
      const meta = JSON.parse((await readMedia(META_KEY)).toString()) as SheetMeta;
      if (meta.fingerprint === fingerprint) {
        const sheets: Buffer[] = [];
        for (let i = 0; i < meta.sheetCount; i++) sheets.push(await readMedia(sheetKey(i)));
        return { sheets, skus: refs };
      }
    }
  } catch {
    /* stale/corrupt cache → rebuild */
  }

  // Build cells (skip SKUs whose image bytes are unreadable).
  const cells: Array<{ ref: ReferenceSku; cell: Buffer }> = [];
  for (const ref of refs) {
    const cell = await buildCell(ref);
    if (cell) cells.push({ ref, cell });
  }
  if (cells.length === 0) throw new Error("Could not render any catalog reference cells");

  const perSheet = COLS * ROWS;
  const sheets: Buffer[] = [];
  for (let s = 0; s * perSheet < cells.length; s++) {
    const batch = cells.slice(s * perSheet, (s + 1) * perSheet);
    const composites = batch.map((b, i) => ({
      input: b.cell,
      top: Math.floor(i / COLS) * CELL_H,
      left: (i % COLS) * CELL_W,
    }));
    const rowsUsed = Math.ceil(batch.length / COLS);
    const sheet = await sharp({
      create: { width: SHEET_W, height: Math.min(SHEET_H, rowsUsed * CELL_H), channels: 3, background: "#ffffff" },
    })
      .composite(composites)
      .jpeg({ quality: 82 })
      .toBuffer();
    sheets.push(sheet);
  }

  // Cache sheets + meta for next time.
  for (let i = 0; i < sheets.length; i++) {
    await saveMedia(sheetKey(i), sheets[i], "image/jpeg");
  }
  const meta: SheetMeta = {
    fingerprint,
    sheetCount: sheets.length,
    skuCount: cells.length,
    builtAt: new Date().toISOString(),
  };
  await saveMedia(META_KEY, Buffer.from(JSON.stringify(meta)), "application/json");

  console.info(`[sku-ref] built ${sheets.length} reference sheets (${cells.length} SKUs)`);
  return { sheets, skus: cells.map((c) => c.ref) };
}
