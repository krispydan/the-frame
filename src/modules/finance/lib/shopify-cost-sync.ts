/**
 * Push landed cost to Shopify's per-variant "Cost per item" so Shopify's
 * native gross-profit reports reflect true landed COGS.
 *
 * Cost source = the SKU's LATEST cost layer's landed_cost_per_unit (decision
 * #4: latest-landed / replacement basis). Also mirrors it into
 * catalog_skus.cost_price so the-frame's own reports stay consistent.
 *
 * Pushed to both stores (retail + wholesale). Bare-unit SKUs only — pack
 * variants aren't sold as their own Shopify variant here.
 */
import { sqlite } from "@/lib/db";
import { shopifyGraphqlRequest, hasShopifyCredentials, type ShopifyStore } from "@/modules/orders/lib/shopify-api";
import { notifyShopifyCostPushFailed } from "@/modules/integrations/lib/slack/notifications";

const STORES: ShopifyStore[] = ["dtc", "wholesale"];

interface VariantLookup {
  productVariants: { nodes: Array<{ sku: string; inventoryItem: { id: string } }> };
}
interface InventoryItemUpdate {
  inventoryItemUpdate: {
    inventoryItem: { id: string; unitCost: { amount: string } | null } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
}

const VARIANT_BY_SKU = `
  query($q: String!) {
    productVariants(first: 10, query: $q) {
      nodes { sku inventoryItem { id } }
    }
  }`;

const UPDATE_COST = `
  mutation($id: ID!, $input: InventoryItemInput!) {
    inventoryItemUpdate(id: $id, input: $input) {
      inventoryItem { id unitCost { amount } }
      userErrors { field message }
    }
  }`;

export interface CostPushResult {
  sku: string | null;
  landedCost: number | null;
  stores: Record<string, "updated" | "not_found" | "skipped" | "error">;
}

/** Push the latest landed cost for one SKU to both Shopify stores. */
export async function pushLandedCostToShopify(skuId: string): Promise<CostPushResult> {
  const row = sqlite.prepare("SELECT sku FROM catalog_skus WHERE id = ?").get(skuId) as { sku: string | null } | undefined;
  const sku = row?.sku ?? null;
  const result: CostPushResult = { sku, landedCost: null, stores: {} };
  if (!sku) return result;

  const layer = sqlite.prepare(
    `SELECT landed_cost_per_unit AS cost FROM inventory_cost_layers
     WHERE sku_id = ? ORDER BY received_at DESC, created_at DESC LIMIT 1`,
  ).get(skuId) as { cost: number } | undefined;
  if (!layer || !(layer.cost > 0)) return result; // nothing to push
  result.landedCost = layer.cost;
  const costStr = layer.cost.toFixed(2);

  // Keep the-frame's own cost in sync too.
  sqlite.prepare("UPDATE catalog_skus SET cost_price = ? WHERE id = ?").run(layer.cost, skuId);

  for (const store of STORES) {
    try {
      if (!(await hasShopifyCredentials(store))) { result.stores[store] = "skipped"; continue; }

      const lookup = await shopifyGraphqlRequest<VariantLookup>(store, VARIANT_BY_SKU, { q: `sku:${sku}` });
      const node = lookup.productVariants?.nodes?.find((n) => n.sku === sku);
      if (!node?.inventoryItem?.id) { result.stores[store] = "not_found"; continue; }

      const upd = await shopifyGraphqlRequest<InventoryItemUpdate>(store, UPDATE_COST, {
        id: node.inventoryItem.id,
        input: { cost: costStr },
      });
      const errs = upd.inventoryItemUpdate?.userErrors ?? [];
      if (errs.length) {
        result.stores[store] = "error";
        await notifyShopifyCostPushFailed({ sku, store, errorMessage: errs.map((e) => e.message).join("; ") }).catch(() => {});
      } else {
        result.stores[store] = "updated";
      }
    } catch (e) {
      result.stores[store] = "error";
      await notifyShopifyCostPushFailed({ sku, store, errorMessage: String(e instanceof Error ? e.message : e) }).catch(() => {});
    }
  }

  return result;
}

/** Push landed cost for many SKUs (e.g. all lines on a received PO). */
export async function pushLandedCostForSkus(skuIds: string[]): Promise<CostPushResult[]> {
  const unique = [...new Set(skuIds)];
  const out: CostPushResult[] = [];
  for (const id of unique) out.push(await pushLandedCostToShopify(id));
  return out;
}
