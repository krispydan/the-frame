/**
 * ShipHero cursor pagination — the loop must always terminate.
 *
 * On 2026-08-04 it didn't. ShipHero answered 200 with hasNextPage true and
 * a cursor that never moved; `while (pageInfo.hasNextPage)` refetched the
 * same page forever. The tight fetch-and-parse spin pinned the container's
 * single vCPU and grew the results array without bound, so Node's event
 * loop got no slice, every HTTP request to the app hung, and the whole site
 * returned 502 while a background inventory sync span.
 *
 * These tests drive the real loops through a stubbed fetch. Each one would
 * hang forever against the old code, so they're guarded with a page counter
 * and asserted against — a regression here fails loudly instead of wedging
 * the suite.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/modules/operations/lib/shiphero/auth", () => ({
  getAccessToken: () => "test-token",
  refreshAccessToken: vi.fn(),
  isTokenConfigured: () => true,
}));

import { getInventoryLevels, getOrders } from "@/modules/operations/lib/shiphero/api-client";

/** Guards the test itself: a runaway loop trips this instead of hanging. */
const CALL_CEILING = 2000;
let calls = 0;

function stubFetch(body: (call: number) => unknown) {
  calls = 0;
  vi.stubGlobal("fetch", async () => {
    calls++;
    if (calls > CALL_CEILING) throw new Error("runaway pagination — loop never terminated");
    return {
      ok: true,
      status: 200,
      json: async () => body(calls),
    } as unknown as Response;
  });
}

const productEdges = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    node: { id: `p${i}`, sku: `JX-${i}`, on_hand: 1, reserve_inventory: 0, warehouse_id: "w1", account_id: "a1" },
  }));

const warehouseBody = (pageInfo: { hasNextPage: boolean; endCursor: string | null }, edges: number) => ({
  data: { warehouse_products: { request_id: "r", complexity: 1, data: { pageInfo, edges: productEdges(edges) } } },
});

const ordersBody = (pageInfo: { hasNextPage: boolean; endCursor: string | null }, edges: number) => ({
  data: {
    orders: {
      request_id: "r",
      complexity: 1,
      data: { pageInfo, edges: Array.from({ length: edges }, (_, i) => ({ node: { id: `o${i}` } })) },
    },
  },
});

beforeEach(() => { calls = 0; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("getInventoryLevels pagination", () => {
  it("stops when the cursor stops advancing (the outage)", async () => {
    // The exact shape ShipHero returned: always more pages, same cursor.
    stubFetch(() => warehouseBody({ hasNextPage: true, endCursor: "STUCK" }, 100));
    const rows = await getInventoryLevels();
    // Two calls: the first page, then one more that reveals the stall.
    expect(calls).toBe(2);
    expect(rows).toHaveLength(200);
  });

  it("stops when the cursor is null despite hasNextPage", async () => {
    stubFetch(() => warehouseBody({ hasNextPage: true, endCursor: null }, 100));
    await getInventoryLevels();
    expect(calls).toBe(1);
  });

  it("stops on an empty page even if more are promised", async () => {
    stubFetch((n) =>
      warehouseBody({ hasNextPage: true, endCursor: `c${n}` }, n === 1 ? 100 : 0),
    );
    const rows = await getInventoryLevels();
    expect(calls).toBe(2);
    expect(rows).toHaveLength(100);
  });

  it("refuses to page past the ceiling when the cursor keeps moving", async () => {
    // Cursor advances every time and the server never says stop — the
    // other two guards can't catch this one.
    stubFetch((n) => warehouseBody({ hasNextPage: true, endCursor: `c${n}` }, 100));
    await getInventoryLevels();
    expect(calls).toBe(500);
  });

  it("still walks a normal multi-page pull to the end", async () => {
    stubFetch((n) => warehouseBody({ hasNextPage: n < 3, endCursor: `c${n}` }, 100));
    const rows = await getInventoryLevels();
    expect(calls).toBe(3);
    expect(rows).toHaveLength(300);
  });
});

describe("getOrders pagination", () => {
  it("stops when the cursor stops advancing", async () => {
    stubFetch(() => ordersBody({ hasNextPage: true, endCursor: "STUCK" }, 50));
    await getOrders();
    expect(calls).toBe(2);
  });

  it("still walks a normal multi-page pull to the end", async () => {
    stubFetch((n) => ordersBody({ hasNextPage: n < 2, endCursor: `c${n}` }, 50));
    const rows = await getOrders();
    expect(calls).toBe(2);
    expect(rows).toHaveLength(100);
  });
});
