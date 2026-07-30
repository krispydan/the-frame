/**
 * Product video coverage — grades every parent product by the footage
 * tagged to it, so the product-video programme has a real worklist.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../setup";
import { buildProductCoverage } from "@/modules/marketing/lib/video/product-coverage";

function seed() {
  const d = getTestDb();
  // Categories: one that shows the product, one that doesn't.
  d.prepare(`INSERT INTO marketing_video_clip_categories (id, slug, name, is_product_shot) VALUES ('c-show','product-showcase','product showcase',1)`).run();
  d.prepare(`INSERT INTO marketing_video_clip_categories (id, slug, name, is_product_shot) VALUES ('c-box','unboxing','unboxing',0)`).run();

  // 3 products: one well covered, one only unboxing, one with nothing.
  for (const [id, name] of [["p-ready", "Cannon"], ["p-thin", "Solstice"], ["p-none", "Wildflower"]]) {
    d.prepare(`INSERT INTO catalog_products (id, name) VALUES (?, ?)`).run(id, name);
    d.prepare(`INSERT INTO catalog_skus (id, product_id, sku) VALUES (?, ?, ?)`).run(`s-${id}`, id, `SKU-${id}`);
  }

  const clip = (cid: string, cat: string, dur: number, sku: string | null) => {
    d.prepare(
      `INSERT INTO marketing_video_clips (id, file_name, checksum, raw_path, duration_sec, status, category_id)
       VALUES (?, ?, ?, ?, ?, 'ready', ?)`,
    ).run(cid, `${cid}.mp4`, cid, `raw/${cid}.mp4`, dur, cat);
    if (sku) d.prepare(`INSERT INTO marketing_video_clip_products (id, clip_id, sku_id) VALUES (?, ?, ?)`).run(`t-${cid}`, cid, sku);
  };

  // ready: a showcase + an unboxing, 10s total
  clip("k1", "c-show", 6, "s-p-ready");
  clip("k2", "c-box", 4, "s-p-ready");
  // thin: unboxing only — never shows the frame
  clip("k3", "c-box", 8, "s-p-thin");
  clip("k4", "c-box", 5, "s-p-thin");
}

describe("buildProductCoverage", () => {
  beforeEach(() => {
    resetTestDb();
    seed();
  });

  it("grades ready / thin / no_footage from the tagging", () => {
    const rep = buildProductCoverage();
    expect(rep.totalProducts).toBe(3);
    const by = new Map(rep.products.map((p) => [p.productId, p]));

    const ready = by.get("p-ready")!;
    expect(ready.status).toBe("ready");
    expect(ready.clipCount).toBe(2);
    expect(ready.productShotCount).toBe(1);
    expect(ready.totalSec).toBe(10);
    expect(ready.gap).toBeNull();

    const thin = by.get("p-thin")!;
    expect(thin.status).toBe("thin");
    expect(thin.productShotCount).toBe(0);
    expect(thin.gap).toMatch(/shows the frame/i);

    const none = by.get("p-none")!;
    expect(none.status).toBe("no_footage");
    expect(none.clipCount).toBe(0);
    expect(none.gap).toMatch(/needs filming/i);

    expect(rep.ready).toBe(1);
    expect(rep.thin).toBe(1);
    expect(rep.noFootage).toBe(1);
  });

  it("breaks coverage down by video type", () => {
    const rep = buildProductCoverage();
    const ready = rep.products.find((p) => p.productId === "p-ready")!;
    const showcase = ready.byType.find((t) => t.slug === "product-showcase")!;
    expect(showcase.count).toBe(1);
    expect(showcase.isProductShot).toBe(true);
    expect(ready.byType.find((t) => t.slug === "unboxing")!.isProductShot).toBe(false);
  });

  it("counts a clip once even when tagged to several colorways of one product", () => {
    const d = getTestDb();
    d.prepare(`INSERT INTO catalog_skus (id, product_id, sku) VALUES ('s2-ready','p-ready','SKU-2')`).run();
    d.prepare(`INSERT INTO marketing_video_clip_products (id, clip_id, sku_id) VALUES ('t-dup','k1','s2-ready')`).run();
    const ready = buildProductCoverage().products.find((p) => p.productId === "p-ready")!;
    expect(ready.clipCount).toBe(2); // not 3
    expect(ready.totalSec).toBe(10);
  });

  it("sorts worst-covered first (it's a worklist)", () => {
    const rep = buildProductCoverage();
    expect(rep.products[0].status).toBe("no_footage");
    expect(rep.products[rep.products.length - 1].status).toBe("ready");
  });

  it("falls back to the legacy list when no category is flagged", () => {
    const d = getTestDb();
    d.prepare(`UPDATE marketing_video_clip_categories SET is_product_shot = 0`).run();
    d.prepare(`INSERT INTO marketing_video_clip_categories (id, slug, name, is_product_shot) VALUES ('c-legacy','on_model','On Model',0)`).run();
    d.prepare(`UPDATE marketing_video_clips SET category_id = 'c-legacy' WHERE id = 'k1'`).run();
    const rep = buildProductCoverage();
    expect(rep.productShotFlagMissing).toBe(true);
    // on_model is in the legacy product-showing list, so it still counts.
    expect(rep.products.find((p) => p.productId === "p-ready")!.productShotCount).toBe(1);
  });
});
