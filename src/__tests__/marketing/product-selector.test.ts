/**
 * Tests for the marketing product selector — the catalog queries that
 * feed real products into email copy + image briefs.
 *
 * The shared in-memory test DB (setup.ts) carries a simplified catalog
 * schema, so beforeAll adds the few columns the selector reads (frame
 * dimensions on products, url on images). All additive + idempotent.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { getTestDb } from "../setup";
import {
  resolveProducts,
  getProductPickList,
  suggestRandomProducts,
  formatProductsForPrompt,
} from "@/modules/marketing/lib/product-selector";

const P1 = "prod-honey";
const P2 = "prod-slate";

beforeAll(() => {
  const db = getTestDb();
  // Bring the simplified test catalog tables up to the columns the
  // selector queries (no-op if already present).
  for (const stmt of [
    "ALTER TABLE catalog_products ADD COLUMN lens_width INTEGER",
    "ALTER TABLE catalog_products ADD COLUMN bridge_width INTEGER",
    "ALTER TABLE catalog_products ADD COLUMN temple_length INTEGER",
    "ALTER TABLE catalog_products ADD COLUMN frame_size TEXT",
    "ALTER TABLE catalog_images ADD COLUMN url TEXT",
  ]) {
    try { db.exec(stmt); } catch { /* already exists */ }
  }

  // Two featurable products.
  db.prepare(
    `INSERT INTO catalog_products (id, name, description, short_description, retail_price, wholesale_price, lens_width, bridge_width, temple_length, status)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(P1, "Honey Reader", "Warm amber tortoise reading glasses.", "Amber tortoise readers.", 28, 8, 51, 22, 145, "published");
  db.prepare(
    `INSERT INTO catalog_products (id, name, description, short_description, retail_price, wholesale_price, status)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(P2, "Slate Reader", "Cool slate-grey readers.", null, 26, 7, "approved");

  // SKUs (both in stock).
  db.prepare(`INSERT INTO catalog_skus (id, product_id, sku, color_name, in_stock, status) VALUES (?,?,?,?,?,?)`)
    .run("sku-honey", P1, "JX-HONEY", "Honey", 1, "approved");
  db.prepare(`INSERT INTO catalog_skus (id, product_id, sku, color_name, in_stock, status) VALUES (?,?,?,?,?,?)`)
    .run("sku-slate", P2, "JX-SLATE", "Slate", 1, "approved");

  // Images (one best per product).
  db.prepare(`INSERT INTO catalog_images (id, sku_id, file_path, is_best, position, status, alt_text) VALUES (?,?,?,?,?,?,?)`)
    .run("img-honey", "sku-honey", "marketing/honey.jpg", 1, 0, "approved", "Honey readers");
  db.prepare(`INSERT INTO catalog_images (id, sku_id, file_path, is_best, position, status, alt_text) VALUES (?,?,?,?,?,?,?)`)
    .run("img-slate", "sku-slate", "marketing/slate.jpg", 1, 0, "approved", "Slate readers");

  // Specs via tags (product 1 only).
  db.prepare(`INSERT INTO catalog_tags (id, product_id, tag_name, dimension, source) VALUES (?,?,?,?,?)`)
    .run("tag-1", P1, "round", "frame_shape", "manual");

  // Orders: P1 outsells P2 (5 vs 2 units).
  db.prepare(`INSERT INTO orders (id, order_number, channel, status) VALUES ('o1','O-1','shopify_dtc','delivered')`).run();
  db.prepare(`INSERT INTO order_items (id, order_id, product_id, sku_id, product_name, quantity, unit_price, total_price) VALUES (?,?,?,?,?,?,?,?)`)
    .run("oi1", "o1", P1, "sku-honey", "Honey Reader", 5, 28, 140);
  db.prepare(`INSERT INTO order_items (id, order_id, product_id, sku_id, product_name, quantity, unit_price, total_price) VALUES (?,?,?,?,?,?,?,?)`)
    .run("oi2", "o1", P2, "sku-slate", "Slate Reader", 2, 26, 52);
});

describe("product-selector — resolveProducts", () => {
  it("resolves ids into AI-ready summaries, preserving order", async () => {
    const out = await resolveProducts([P2, P1]);
    expect(out.map((p) => p.id)).toEqual([P2, P1]);
    const honey = out.find((p) => p.id === P1)!;
    expect(honey.name).toBe("Honey Reader");
    expect(honey.description).toBe("Amber tortoise readers."); // short description preferred
    expect(honey.priceRetail).toBe(28);
    expect(honey.imageUrl).toContain("marketing/honey.jpg");
    expect(honey.imageAlt).toBe("Honey readers");
    // Specs: curated tag + frame dimensions
    expect(honey.specs).toContain("frame shape: round");
    expect(honey.specs.some((s) => s.includes("Lens 51mm"))).toBe(true);
  });

  it("drops unknown ids and returns [] for empty input", async () => {
    expect(await resolveProducts([])).toEqual([]);
    expect(await resolveProducts(["does-not-exist"])).toEqual([]);
  });
});

describe("product-selector — pick lists", () => {
  it("top_sellers ranks by units ordered (P1 before P2)", async () => {
    const out = await getProductPickList({ mode: "top_sellers" });
    const ids = out.map((p) => p.id);
    expect(ids.indexOf(P1)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(P1)).toBeLessThan(ids.indexOf(P2));
  });

  it("in_stock returns both featurable in-stock products", async () => {
    const out = await getProductPickList({ mode: "in_stock" });
    const ids = out.map((p) => p.id);
    expect(ids).toContain(P1);
    expect(ids).toContain(P2);
  });

  it("suggestRandomProducts returns at most n", async () => {
    const out = await suggestRandomProducts(1, "in_stock");
    expect(out.length).toBe(1);
  });
});

describe("product-selector — prompt formatting", () => {
  it("renders name, price, description, specs, image into a compact block", async () => {
    const [honey] = await resolveProducts([P1]);
    const block = formatProductsForPrompt([honey]);
    expect(block).toContain("Honey Reader");
    expect(block).toContain("$28.00 retail");
    expect(block).toContain("Amber tortoise readers.");
    expect(block).toContain("frame shape: round");
    expect(block).toContain("marketing/honey.jpg");
  });

  it("returns empty string for no products", () => {
    expect(formatProductsForPrompt([])).toBe("");
  });
});
