/**
 * Publishing guards — the approve gate is the whole point, so it's tested
 * without touching Shopify. The live round-trip (staged upload →
 * productCreateMedia) needs real credentials and is verified on deploy.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { getTestDb, resetTestDb } from "../setup";
import { publishProductVideo, resolveShopifyProductId } from "@/modules/marketing/lib/video/product-video-publish";
import { listProductVideos } from "@/modules/marketing/lib/video/product-video";

// A real (tiny) master on disk so the publish path gets past materialize.
beforeAll(() => {
  const root = mkdtempSync(path.join(tmpdir(), "pv-pub-"));
  process.env.VIDEOS_PATH = root;
  mkdirSync(path.join(root, "products"), { recursive: true });
  writeFileSync(path.join(root, "products/p1.mp4"), Buffer.from("not-a-real-mp4"));
});

function seedVideo(opts: { status?: string; approved?: boolean; filePath?: string | null } = {}) {
  const d = getTestDb();
  d.prepare(`INSERT INTO catalog_products (id, name) VALUES ('p1','Cannon')`).run();
  d.prepare(`INSERT INTO catalog_skus (id, product_id, sku) VALUES ('s1','p1','JX-CAN-BLK')`).run();
  d.prepare(
    `INSERT INTO marketing_product_videos (product_id, clip_ids, status, file_path, approved_at)
     VALUES ('p1','["c1"]', ?, ?, ?)`,
  ).run(
    opts.status ?? "ready",
    opts.filePath === undefined ? "products/p1.mp4" : opts.filePath,
    opts.approved ? "2026-07-30 12:00:00" : null,
  );
}

describe("publishProductVideo guards", () => {
  beforeEach(() => {
    resetTestDb();
    listProductVideos(); // ensure the table exists
    getTestDb().exec("DELETE FROM marketing_product_videos");
  });

  it("refuses when there's no product video", async () => {
    const r = await publishProductVideo("nope");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no product video/i);
  });

  it("refuses an unrendered video", async () => {
    seedVideo({ status: "failed", filePath: null });
    const r = await publishProductVideo("p1");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/isn't rendered/i);
  });

  it("refuses a rendered video that has NOT been approved", async () => {
    seedVideo({ status: "ready", approved: false });
    const r = await publishProductVideo("p1");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not approved/i);
    // and nothing was recorded as published, on either store
    const row = getTestDb().prepare(
      `SELECT shopify_published_at AS at, shopify_retail_at AS retail, shopify_wholesale_at AS wholesale
         FROM marketing_product_videos WHERE product_id='p1'`,
    ).get() as { at: string | null; retail: string | null; wholesale: string | null };
    expect(row.at).toBeNull();
    expect(row.retail).toBeNull();
    expect(row.wholesale).toBeNull();
  });

  it("attempts BOTH Shopify stores and reports each one", async () => {
    seedVideo({ status: "ready", approved: true });
    // No store is connected in tests, so both fail — the point is that both
    // are attempted and neither failure hides the other.
    const r = await publishProductVideo("p1");
    expect(r.ok).toBe(false);
    expect(r.channels.map((c) => c.channel)).toEqual(["retail", "wholesale"]);
    expect(r.channels.every((c) => !c.ok && c.error)).toBe(true);
  });

  it("can target a single store", async () => {
    seedVideo({ status: "ready", approved: true });
    const r = await publishProductVideo("p1", ["wholesale"]);
    expect(r.channels.map((c) => c.channel)).toEqual(["wholesale"]);
  });
});

describe("resolveShopifyProductId", () => {
  beforeEach(() => {
    resetTestDb();
    getTestDb().prepare(`INSERT INTO catalog_products (id, name) VALUES ('p1','Cannon')`).run();
  });

  it("returns null when the product has no SKUs", async () => {
    const client = { graphql: async <T,>(): Promise<T> => ({}) as T };
    expect(await resolveShopifyProductId(client, "p1")).toBeNull();
  });

  it("matches a Shopify product by SKU", async () => {
    getTestDb().prepare(`INSERT INTO catalog_skus (id, product_id, sku) VALUES ('s1','p1','JX-CAN-BLK')`).run();
    const seen: string[] = [];
    const client = {
      graphql: async <T,>(_q: string, v?: Record<string, unknown>): Promise<T> => {
        seen.push(String(v?.q));
        return { productVariants: { edges: [{ node: { product: { id: "gid://shopify/Product/42" } } }] } } as T;
      },
    };
    expect(await resolveShopifyProductId(client, "p1")).toBe("gid://shopify/Product/42");
    expect(seen[0]).toContain("JX-CAN-BLK");
  });

  it("tries every SKU before giving up", async () => {
    const d = getTestDb();
    d.prepare(`INSERT INTO catalog_skus (id, product_id, sku) VALUES ('s1','p1','A')`).run();
    d.prepare(`INSERT INTO catalog_skus (id, product_id, sku) VALUES ('s2','p1','B')`).run();
    let calls = 0;
    const client = {
      graphql: async <T,>(): Promise<T> => {
        calls++;
        return { productVariants: { edges: [] } } as T;
      },
    };
    expect(await resolveShopifyProductId(client, "p1")).toBeNull();
    expect(calls).toBe(2);
  });
});
