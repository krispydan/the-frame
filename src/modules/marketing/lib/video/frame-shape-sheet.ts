/**
 * Product contact sheet — one image per product, numbered, tiled into a
 * grid the vision model can reference.
 *
 * The frame-shape matcher sends this sheet alongside a clip crop and asks
 * the model "which of these numbered products has the same FRAME SHAPE?".
 * Building the sheet means downloading ~one image per product and
 * compositing them, so it's cached: in-memory for the process, and in
 * storage keyed by a catalog signature so restarts don't rebuild. The
 * signature changes when products or their chosen images change, which
 * transparently invalidates both caches.
 */
import { createHash } from "crypto";
import sharp from "sharp";
import { sqlite } from "@/lib/db";
import { materializeMedia } from "@/lib/storage/media";
import { saveVideo, readVideo, videoStat, videoUrl } from "@/lib/storage/videos";

export interface SheetEntry {
  /** 1-based number burned onto the tile — what the model returns. */
  index: number;
  productId: string;
  productName: string;
  sku: string;
  skuId: string;
}

export interface ContactSheets {
  /** One or more JPEG pages (base64), each a numbered grid. */
  sheets: Array<{ base64: string; mime: "image/jpeg" }>;
  entries: SheetEntry[];
  sig: string;
}

// Grid geometry — kept so each page's long edge stays under ~1568px (the
// point where cheaper vision models downscale), so tiles stay legible.
const COLS = 6;
const TILE = 168;
const GAP = 6;
const PAD = 10;
const ROWS_PER_PAGE = 8; // 48 products per page
const SHEET_W = PAD * 2 + COLS * TILE + (COLS - 1) * GAP;

let cache: ContactSheets | null = null;

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

/** SVG overlay drawing a numbered badge on each tile. */
function numberOverlay(height: number, cells: Array<{ n: number; x: number; y: number }>): Buffer {
  const badges = cells
    .map(
      (c) => `<g transform="translate(${c.x + 3},${c.y + 3})">
        <rect width="28" height="17" rx="3" fill="rgba(0,0,0,0.72)"/>
        <text x="14" y="13" font-family="Arial, sans-serif" font-size="12" font-weight="bold" fill="#ffffff" text-anchor="middle">${c.n}</text>
      </g>`,
    )
    .join("");
  return Buffer.from(
    `<svg width="${SHEET_W}" height="${height}" xmlns="http://www.w3.org/2000/svg">${badges}</svg>`,
  );
}

const sheetKey = (sig: string, page: number) => `shape-sheets/${sig}/page-${page}.jpg`;
const manifestKey = (sig: string) => `shape-sheets/${sig}/manifest.json`;

/** Reload prebuilt sheets from storage (fast path across restarts). */
async function loadFromStorage(sig: string, entries: SheetEntry[]): Promise<ContactSheets | null> {
  const stat = await videoStat(manifestKey(sig));
  if (!stat.exists) return null;
  try {
    const manifest = JSON.parse((await readVideo(manifestKey(sig))).toString()) as { pages: number };
    const sheets: ContactSheets["sheets"] = [];
    for (let i = 0; i < manifest.pages; i++) {
      const buf = await readVideo(sheetKey(sig, i));
      sheets.push({ base64: buf.toString("base64"), mime: "image/jpeg" });
    }
    return { sheets, entries, sig };
  } catch {
    return null;
  }
}

/**
 * Build (or return cached) numbered contact sheets for the whole catalog.
 * Entry `index` is the number to map a model answer back to a product.
 */
export async function buildContactSheets(): Promise<ContactSheets> {
  const prods = loadProductImages();
  const sig = createHash("sha256")
    .update(prods.map((p) => `${p.productId}:${p.imagePath}`).join("|"))
    .digest("hex")
    .slice(0, 16);
  if (cache?.sig === sig) return cache;

  const entries: SheetEntry[] = prods.map((p, i) => ({
    index: i + 1,
    productId: p.productId,
    productName: p.productName,
    sku: p.sku,
    skuId: p.skuId,
  }));

  const stored = await loadFromStorage(sig, entries);
  if (stored) {
    cache = stored;
    return stored;
  }

  const perPage = COLS * ROWS_PER_PAGE;
  const sheets: ContactSheets["sheets"] = [];
  for (let page = 0; page * perPage < prods.length; page++) {
    const slice = prods.slice(page * perPage, page * perPage + perPage);
    const rows = Math.max(1, Math.ceil(slice.length / COLS));
    const sheetH = PAD * 2 + rows * TILE + (rows - 1) * GAP;

    const tiles = await Promise.all(slice.map((p) => tileBuffer(p.imagePath).catch(() => null)));
    const composites: sharp.OverlayOptions[] = [];
    const cells: Array<{ n: number; x: number; y: number }> = [];
    slice.forEach((_p, idx) => {
      const col = idx % COLS;
      const row = Math.floor(idx / COLS);
      const x = PAD + col * (TILE + GAP);
      const y = PAD + row * (TILE + GAP);
      const buf = tiles[idx];
      if (buf) composites.push({ input: buf, left: x, top: y });
      cells.push({ n: page * perPage + idx + 1, x, y });
    });
    composites.push({ input: numberOverlay(sheetH, cells), left: 0, top: 0 });

    const sheetBuf = await sharp({
      create: { width: SHEET_W, height: sheetH, channels: 3, background: { r: 245, g: 245, b: 245 } },
    })
      .composite(composites)
      .jpeg({ quality: 82 })
      .toBuffer();
    sheets.push({ base64: sheetBuf.toString("base64"), mime: "image/jpeg" });
    await saveVideo(sheetBuf, sheetKey(sig, page)).catch(() => {});
  }

  await saveVideo(Buffer.from(JSON.stringify({ pages: sheets.length })), manifestKey(sig)).catch(() => {});
  const result: ContactSheets = { sheets, entries, sig };
  cache = result;
  return result;
}

/**
 * Build (or reuse) the sheets and return their served URLs — so the exact
 * catalog fed to the model can be inspected in the review UI.
 */
export async function contactSheetUrls(): Promise<{ sig: string; productCount: number; pages: string[] }> {
  const s = await buildContactSheets();
  return {
    sig: s.sig,
    productCount: s.entries.length,
    pages: s.sheets.map((_, i) => videoUrl(sheetKey(s.sig, i))),
  };
}
