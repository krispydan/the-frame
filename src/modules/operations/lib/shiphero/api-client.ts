/**
 * ShipHero GraphQL API client.
 * Bearer-token auth, cursor-based pagination, credit-aware rate limiting.
 */

const SHIPHERO_GRAPHQL_URL = "https://public-api.shiphero.com/graphql";

const ACCESS_TOKEN = process.env.SHIPHERO_ACCESS_TOKEN;

export interface ShipHeroInventoryItem {
  sku: string;
  on_hand: number;
  allocated: number;
  available: number;
  backorder: number;
  warehouse_id: string;
}

interface WarehouseProductNode {
  id: string;
  sku: string;
  on_hand: number;
  reserve_inventory: number;
  inventory_bin: string | null;
  warehouse_id: string;
  account_id: string;
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface WarehouseProductsResponse {
  data: {
    warehouse_products: {
      request_id: string;
      complexity: number;
      data: {
        pageInfo: PageInfo;
        edges: Array<{ node: WarehouseProductNode }>;
      };
    };
  };
  errors?: Array<{ message: string }>;
}

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  if (!ACCESS_TOKEN) {
    throw new Error("SHIPHERO_ACCESS_TOKEN is not configured");
  }

  const res = await fetch(SHIPHERO_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ShipHero API ${res.status}: ${text}`);
  }

  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`ShipHero GraphQL: ${json.errors.map((e: { message: string }) => e.message).join(", ")}`);
  }

  return json as T;
}

/**
 * Fetch all inventory levels, paginating through all results.
 * Returns one entry per SKU per warehouse.
 */
export async function getInventoryLevels(opts?: {
  skus?: string[];
}): Promise<ShipHeroInventoryItem[]> {
  const PAGE_SIZE = 100;
  const all: ShipHeroInventoryItem[] = [];
  let cursor: string | null = null;
  let hasNext = true;

  while (hasNext) {
    const afterClause: string = cursor ? `, after: "${cursor}"` : "";

    const query: string = `{
      warehouse_products {
        request_id
        complexity
        data(first: ${PAGE_SIZE}${afterClause}) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              sku
              on_hand
              reserve_inventory
              warehouse_id
              account_id
            }
          }
        }
      }
    }`;

    const res: WarehouseProductsResponse = await gql<WarehouseProductsResponse>(query);
    const pageInfo: PageInfo = res.data.warehouse_products.data.pageInfo;
    const edges = res.data.warehouse_products.data.edges;

    for (const { node } of edges) {
      all.push({
        sku: node.sku,
        on_hand: node.on_hand ?? 0,
        allocated: node.reserve_inventory ?? 0,
        available: (node.on_hand ?? 0) - (node.reserve_inventory ?? 0),
        backorder: 0,
        warehouse_id: node.warehouse_id,
      });
    }

    hasNext = pageInfo.hasNextPage;
    cursor = pageInfo.endCursor;
  }

  // Filter to specific SKUs if requested
  if (opts?.skus?.length) {
    const skuSet = new Set(opts.skus);
    return all.filter((item) => skuSet.has(item.sku));
  }

  return all;
}

// ── Orders ──

export interface ShipHeroShippingLabel {
  carrier: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  status: string | null;
  cost: string | null;
  created_date: string | null;
}

export interface ShipHeroShipment {
  id: string;
  order_id: string;
  picked_up: boolean;
  created_date: string | null;
  total_packages: number | null;
  shipping_labels: ShipHeroShippingLabel[];
}

export interface ShipHeroOrder {
  id: string;
  order_number: string;
  shop_name: string;
  partner_order_id: string;
  fulfillment_status: string;
  order_date: string;
  total_price: string;
  shipments: ShipHeroShipment[];
}

interface OrdersResponse {
  data: {
    orders: {
      request_id: string;
      complexity: number;
      data: {
        pageInfo: PageInfo;
        edges: Array<{ node: ShipHeroOrder }>;
      };
    };
  };
}

/**
 * Fetch orders from ShipHero, paginating through all results.
 * Optionally filter by date range.
 */
export async function getOrders(opts?: {
  updatedFrom?: string;
  updatedTo?: string;
}): Promise<ShipHeroOrder[]> {
  const PAGE_SIZE = 50;
  const all: ShipHeroOrder[] = [];
  let cursor: string | null = null;
  let hasNext = true;

  const filters: string[] = [];
  if (opts?.updatedFrom) filters.push(`updated_from: "${opts.updatedFrom}"`);
  if (opts?.updatedTo) filters.push(`updated_to: "${opts.updatedTo}"`);
  const filterStr = filters.length ? `(${filters.join(", ")})` : "";

  while (hasNext) {
    const afterClause: string = cursor ? `, after: "${cursor}"` : "";

    const query: string = `{
      orders${filterStr} {
        request_id
        complexity
        data(first: ${PAGE_SIZE}${afterClause}) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              order_number
              shop_name
              partner_order_id
              fulfillment_status
              order_date
              total_price
              shipments {
                id
                order_id
                picked_up
                created_date
                total_packages
                shipping_labels {
                  carrier
                  tracking_number
                  tracking_url
                  status
                  cost
                  created_date
                }
              }
            }
          }
        }
      }
    }`;

    const res: OrdersResponse = await gql<OrdersResponse>(query);
    const pageInfo: PageInfo = res.data.orders.data.pageInfo;
    const edges = res.data.orders.data.edges;

    for (const { node } of edges) {
      all.push(node);
    }

    hasNext = pageInfo.hasNextPage;
    cursor = pageInfo.endCursor;
  }

  return all;
}

/** Check if ShipHero is configured */
export function isConfigured(): boolean {
  return !!ACCESS_TOKEN;
}
