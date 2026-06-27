import { describe, it, expect, beforeEach, vi } from "vitest";
import { getTestDb, resetTestDb } from "../setup";
import { sqlite } from "@/lib/db";

const { shopifyGraphqlRequest, hasShopifyCredentials, notifyShopifyCostPushFailed } = vi.hoisted(() => ({
  shopifyGraphqlRequest: vi.fn(),
  hasShopifyCredentials: vi.fn(async () => true),
  notifyShopifyCostPushFailed: vi.fn(async () => {}),
}));
vi.mock("@/modules/orders/lib/shopify-api", () => ({ shopifyGraphqlRequest, hasShopifyCredentials }));
vi.mock("@/modules/integrations/lib/slack/notifications", () => ({ notifyShopifyCostPushFailed }));

import { pushLandedCostToShopify } from "@/modules/finance/lib/shopify-cost-sync";
import { createCostLayer } from "@/modules/finance/lib/fifo-engine";

function seed() {
  sqlite.prepare("INSERT INTO catalog_products (id, name) VALUES ('p1','Test')").run();
  sqlite.prepare("INSERT INTO catalog_skus (id, product_id, sku, cost_price) VALUES ('a','p1','JX1-BLK',0)").run();
}

describe("shopify cost sync", () => {
  beforeEach(() => { getTestDb(); resetTestDb(); vi.clearAllMocks(); });

  it("pushes the LATEST layer's landed cost to both stores + mirrors cost_price", async () => {
    seed();
    // older + newer layer; latest (by received_at) wins
    createCostLayer({ skuId: "a", quantity: 100, unitCost: 2.0, freightPerUnit: 0.2, dutiesPerUnit: 0.1, receivedAt: "2026-05-01T00:00:00Z" });
    createCostLayer({ skuId: "a", quantity: 100, unitCost: 2.5, freightPerUnit: 0.3, dutiesPerUnit: 0.2, receivedAt: "2026-06-01T00:00:00Z" });

    shopifyGraphqlRequest
      // dtc lookup, dtc update, wholesale lookup, wholesale update
      .mockResolvedValueOnce({ productVariants: { nodes: [{ sku: "JX1-BLK", inventoryItem: { id: "gid://shopify/InventoryItem/1" } }] } })
      .mockResolvedValueOnce({ inventoryItemUpdate: { inventoryItem: { id: "1", unitCost: { amount: "3.00" } }, userErrors: [] } })
      .mockResolvedValueOnce({ productVariants: { nodes: [{ sku: "JX1-BLK", inventoryItem: { id: "gid://shopify/InventoryItem/2" } }] } })
      .mockResolvedValueOnce({ inventoryItemUpdate: { inventoryItem: { id: "2", unitCost: { amount: "3.00" } }, userErrors: [] } });

    const r = await pushLandedCostToShopify("a");
    expect(r.landedCost).toBeCloseTo(3.0, 2); // 2.5 + 0.3 + 0.2
    expect(r.stores.dtc).toBe("updated");
    expect(r.stores.wholesale).toBe("updated");
    // mutation got the cost as a string
    const updateCall = shopifyGraphqlRequest.mock.calls[1];
    expect(updateCall[2].input).toEqual({ cost: "3.00" });
    // cost_price mirrored locally
    const cp = (sqlite.prepare("SELECT cost_price c FROM catalog_skus WHERE id='a'").get() as { c: number }).c;
    expect(cp).toBeCloseTo(3.0, 2);
  });

  it("flags userErrors via Slack and marks the store errored", async () => {
    seed();
    createCostLayer({ skuId: "a", quantity: 10, unitCost: 1.5 });
    shopifyGraphqlRequest
      .mockResolvedValueOnce({ productVariants: { nodes: [{ sku: "JX1-BLK", inventoryItem: { id: "gid://shopify/InventoryItem/1" } }] } })
      .mockResolvedValueOnce({ inventoryItemUpdate: { inventoryItem: null, userErrors: [{ field: ["cost"], message: "bad" }] } })
      .mockResolvedValueOnce({ productVariants: { nodes: [] } }); // wholesale: not found

    const r = await pushLandedCostToShopify("a");
    expect(r.stores.dtc).toBe("error");
    expect(r.stores.wholesale).toBe("not_found");
    expect(notifyShopifyCostPushFailed).toHaveBeenCalledOnce();
  });

  it("no-ops when the SKU has no cost layer", async () => {
    seed();
    const r = await pushLandedCostToShopify("a");
    expect(r.landedCost).toBeNull();
    expect(shopifyGraphqlRequest).not.toHaveBeenCalled();
  });
});
