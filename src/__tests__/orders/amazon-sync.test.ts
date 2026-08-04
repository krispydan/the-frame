/**
 * Amazon order import + double-ship guard tests.
 *
 * The guard suite at the bottom is the important half. Amazon fulfils these
 * orders itself, so anything in The Frame that acts on an order row is a
 * potential double-ship or a false alert. Each guard gets a test that would
 * fail loudly if someone removed it — the failure mode is expensive and
 * silent, which is exactly the combination worth pinning down.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../setup";
import {
  importAmazonOrders,
  mapAmazonStatus,
  deriveShippedAt,
  amazonOrderNumber,
  amazonExternalId,
  resolveCatalogSku,
} from "@/modules/orders/lib/amazon-sync";
import { findLocalOrderIdByShipHeroSignals } from "@/modules/orders/lib/activity-log";

let sqlite: ReturnType<typeof getTestDb>;

beforeEach(() => {
  sqlite = getTestDb();
  resetTestDb();
});

/** Insert a raw archive line, the importer's only input. */
function rawLine(over: Partial<Record<string, unknown>> = {}) {
  const row = {
    amazon_order_id: "111-9094194-1536224",
    sku: "JX1010-TOR-FBA",
    asin: "B0ABC",
    quantity: 1,
    item_price: 28.0,
    item_tax: 0,
    item_promotion_discount: 0,
    ship_promotion_discount: 0,
    shipping_price: 0,
    shipping_tax: 0,
    order_status: "Pending",
    item_status: "Pending",
    fulfillment_channel: "Amazon",
    sales_channel: "Amazon.com",
    currency: "USD",
    purchase_date: "2026-07-28T11:11:23-07:00",
    last_updated_date: "2026-07-28T11:11:23-07:00",
    ...over,
  };
  sqlite.prepare(`
    INSERT INTO amazon_order_rows (
      id, amazon_order_id, sku, asin, quantity, item_price, item_tax,
      item_promotion_discount, ship_promotion_discount, shipping_price, shipping_tax,
      order_status, item_status, fulfillment_channel, sales_channel, currency,
      purchase_date, last_updated_date
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(), row.amazon_order_id, row.sku, row.asin, row.quantity,
    row.item_price, row.item_tax, row.item_promotion_discount, row.ship_promotion_discount,
    row.shipping_price, row.shipping_tax, row.order_status, row.item_status,
    row.fulfillment_channel, row.sales_channel, row.currency, row.purchase_date,
    row.last_updated_date,
  );
  return row;
}

/** catalog_skus.product_id is NOT NULL, so a product row must exist first. */
function seedCatalogSku(skuId: string, sku: string) {
  const productId = `prod-${skuId}`;
  try {
    sqlite.prepare("INSERT INTO catalog_products (id, name) VALUES (?, ?)").run(productId, sku);
  } catch { /* products table shape varies; the FK is what matters */ }
  sqlite.prepare("INSERT INTO catalog_skus (id, product_id, sku) VALUES (?, ?, ?)").run(skuId, productId, sku);
}

const getOrder = () =>
  sqlite.prepare("SELECT * FROM orders WHERE channel = 'amazon' LIMIT 1").get() as Record<string, unknown>;

describe("mapAmazonStatus", () => {
  it("maps an unshipped order to pending", () => {
    expect(mapAmazonStatus(["Pending"])).toBe("pending");
  });

  it("maps a fully shipped order to shipped", () => {
    expect(mapAmazonStatus(["Shipped", "Shipped"])).toBe("shipped");
  });

  it("treats a partially shipped order as shipped, because that revenue has transferred", () => {
    expect(mapAmazonStatus(["Shipped", "Pending"])).toBe("shipped");
  });

  it("only cancels when every line is cancelled", () => {
    expect(mapAmazonStatus(["Cancelled", "Cancelled"])).toBe("cancelled");
    expect(mapAmazonStatus(["Cancelled", "Shipped"])).toBe("shipped");
  });

  it("NEVER returns confirmed — that state is what the stuck-order scan alerts on", () => {
    const inputs = [["Pending"], ["Shipped"], ["Cancelled"], ["Unshipped"], [], [null]];
    for (const i of inputs) {
      expect(["confirmed", "picking", "packed"]).not.toContain(mapAmazonStatus(i));
    }
  });

  it("falls back to pending for unknown or empty statuses", () => {
    expect(mapAmazonStatus([])).toBe("pending");
    expect(mapAmazonStatus([null, ""])).toBe("pending");
    expect(mapAmazonStatus(["SomeNewAmazonState"])).toBe("pending");
  });
});

describe("deriveShippedAt", () => {
  it("uses the earliest shipped line's update timestamp", () => {
    expect(deriveShippedAt([
      { item_status: "Shipped", last_updated_date: "2026-07-30T10:00:00Z" },
      { item_status: "Shipped", last_updated_date: "2026-07-29T10:00:00Z" },
    ])).toBe("2026-07-29T10:00:00Z");
  });

  it("ignores unshipped lines", () => {
    expect(deriveShippedAt([
      { item_status: "Pending", last_updated_date: "2026-07-28T10:00:00Z" },
      { item_status: "Shipped", last_updated_date: "2026-07-30T10:00:00Z" },
    ])).toBe("2026-07-30T10:00:00Z");
  });

  it("returns null when nothing has shipped", () => {
    expect(deriveShippedAt([{ item_status: "Pending", last_updated_date: "2026-07-28T10:00:00Z" }])).toBeNull();
  });
});

describe("importAmazonOrders", () => {
  it("creates an order with the structural safety fields set", () => {
    rawLine();
    const res = importAmazonOrders();
    expect(res.ordersCreated).toBe(1);

    const o = getOrder();
    expect(o.channel).toBe("amazon");
    expect(o.order_number).toBe("AMZ-111-9094194-1536224");
    expect(o.external_id).toBe("amazon:111-9094194-1536224");
    // Each of these disables a whole class of downstream side effect.
    expect(o.company_id).toBeNull();
    expect(o.contact_id).toBeNull();
    expect(o.shiphero_order_id).toBeNull();
    expect(o.ship_to_country).toBeNull();
    expect(o.shipped_alert_sent_at).not.toBeNull();
  });

  it("computes order money from the line rows", () => {
    rawLine({ item_price: 28.0, item_tax: 2.31, item_promotion_discount: 14.0, shipping_price: 2.99 });
    importAmazonOrders();
    const o = getOrder();
    expect(o.subtotal).toBe(28);
    expect(o.discount).toBe(14);
    expect(o.shipping).toBe(2.99);
    expect(o.tax).toBe(2.31);
    expect(o.total).toBe(round(28 - 14 + 2.99 + 2.31));
  });

  it("groups multiple SKUs into one order with several line items", () => {
    rawLine({ sku: "JX1010-TOR-FBA", item_price: 28 });
    rawLine({ sku: "JX2007-BLK-FBA", item_price: 32 });
    const res = importAmazonOrders();

    expect(res.ordersCreated).toBe(1);
    expect(res.itemsWritten).toBe(2);
    expect(getOrder().subtotal).toBe(60);
  });

  it("derives unit price from the line total and quantity", () => {
    rawLine({ quantity: 2, item_price: 56.0 });
    importAmazonOrders();
    const item = sqlite.prepare("SELECT * FROM order_items").get() as Record<string, number>;
    expect(item.quantity).toBe(2);
    expect(item.unit_price).toBe(28);
    expect(item.total_price).toBe(56);
  });

  it("is idempotent — re-importing unchanged data updates nothing", () => {
    seedCatalogSku("sku-1", "JX1010-TOR");
    rawLine();
    importAmazonOrders();
    const res = importAmazonOrders();
    expect(res).toMatchObject({ ordersCreated: 0, ordersUpdated: 0, ordersUnchanged: 1 });
    expect((sqlite.prepare("SELECT COUNT(*) n FROM orders").get() as { n: number }).n).toBe(1);
  });

  it("promotes an order to shipped and sets shipped_at when Amazon ships it", () => {
    rawLine();
    importAmazonOrders();
    expect(getOrder().status).toBe("pending");
    expect(getOrder().shipped_at).toBeNull();

    sqlite.prepare("UPDATE amazon_order_rows SET item_status='Shipped', last_updated_date=?")
      .run("2026-07-30T04:20:37-07:00");
    const res = importAmazonOrders();

    expect(res.ordersUpdated).toBe(1);
    const o = getOrder();
    expect(o.status).toBe("shipped");
    // shipped_at is what daily COGS and revenue recognition key off.
    expect(o.shipped_at).toBe("2026-07-30T04:20:37-07:00");
  });

  it("marks an order cancelled when Amazon cancels it", () => {
    rawLine();
    importAmazonOrders();
    sqlite.prepare("UPDATE amazon_order_rows SET item_status='Cancelled'").run();
    importAmazonOrders();
    expect(getOrder().status).toBe("cancelled");
  });

  it("resolves the -FBA SKU to a catalog sku id", () => {
    seedCatalogSku("sku-1", "JX1010-TOR");
    rawLine();
    importAmazonOrders();
    const item = sqlite.prepare("SELECT sku, sku_id FROM order_items").get() as Record<string, string>;
    expect(item.sku).toBe("JX1010-TOR-FBA"); // raw Amazon SKU preserved
    expect(item.sku_id).toBe("sku-1");       // resolved to our catalog
  });

  it("reports an unmapped SKU rather than silently writing a costless line", () => {
    rawLine({ sku: "JX9999-XXX-FBA" });
    const res = importAmazonOrders();
    expect(res.unmappedSkus).toContain("JX9999-XXX-FBA");
    expect((sqlite.prepare("SELECT sku_id FROM order_items").get() as { sku_id: string | null }).sku_id).toBeNull();
  });

  it("does not rewrite line items once they have been COGS-costed", () => {
    // Deleting a costed line would orphan its depletion and drop the cost
    // out of the ledger, so the importer must leave costed orders alone.
    seedCatalogSku("sku-1", "JX1010-TOR");
    rawLine();
    importAmazonOrders();

    const item = sqlite.prepare("SELECT id FROM order_items").get() as { id: string };
    sqlite.prepare(`
      INSERT INTO inventory_cost_layers (id, sku_id, quantity, remaining_quantity, unit_cost, landed_cost_per_unit, received_at)
      VALUES ('layer-1', 'sku-1', 10, 9, 5, 6, '2026-07-01')
    `).run();
    sqlite.prepare(`
      INSERT INTO inventory_cost_depletions (id, cost_layer_id, order_item_id, order_id, channel, quantity, unit_cost, landed_cost_per_unit, depleted_at)
      VALUES ('dep-1', 'layer-1', ?, (SELECT id FROM orders LIMIT 1), 'amazon', 1, 5, 6, '2026-07-30')
    `).run(item.id);

    sqlite.prepare("UPDATE amazon_order_rows SET item_status='Shipped', item_price=99").run();
    importAmazonOrders();

    const after = sqlite.prepare("SELECT id FROM order_items").get() as { id: string };
    expect(after.id).toBe(item.id); // same row, depletion still valid
  });

  it("does not churn on a SKU that genuinely has no mapping", () => {
    // Unresolvable forever is not a reason to rewrite the order every night.
    rawLine({ sku: "JX9999-XXX-FBA" });
    importAmazonOrders();
    const res = importAmazonOrders();
    expect(res.ordersUnchanged).toBe(1);
    expect(res.ordersUpdated).toBe(0);
  });

  it("re-resolves an unmapped SKU on the next import once an alias is added", () => {
    // "add the alias, re-import" is the documented fix for an unmapped SKU.
    // A plain unchanged-field check would short-circuit that and leave the
    // line permanently uncostable.
    rawLine({ sku: "JX1010-TOR-FBA" });
    expect(importAmazonOrders().unmappedSkus).toContain("JX1010-TOR-FBA");

    seedCatalogSku("sku-1", "JX1010-TOR");
    const res = importAmazonOrders();

    expect(res.ordersUnchanged).toBe(0);
    const item = sqlite.prepare("SELECT sku_id FROM order_items").get() as { sku_id: string | null };
    expect(item.sku_id).toBe("sku-1");
  });

  it("never clears shipped_at once set, so posted COGS cannot be stranded", () => {
    rawLine({ item_status: "Shipped", last_updated_date: "2026-07-30T04:00:00Z" });
    importAmazonOrders();
    expect(getOrder().shipped_at).toBe("2026-07-30T04:00:00Z");

    // Amazon restates the line back to a non-shipped state.
    sqlite.prepare("UPDATE amazon_order_rows SET item_status='Cancelled'").run();
    importAmazonOrders();

    const o = getOrder();
    expect(o.status).toBe("cancelled");
    expect(o.shipped_at).toBe("2026-07-30T04:00:00Z"); // history preserved
  });

  it("filters by purchase date window", () => {
    rawLine({ amazon_order_id: "111-old", purchase_date: "2026-06-01T00:00:00Z" });
    rawLine({ amazon_order_id: "111-new", purchase_date: "2026-07-28T00:00:00Z" });

    const res = importAmazonOrders({ since: "2026-07-01" });
    expect(res.ordersCreated).toBe(1);
    expect((sqlite.prepare("SELECT order_number FROM orders").get() as { order_number: string }).order_number)
      .toBe("AMZ-111-new");
  });

  it("keeps one bad order from aborting the whole run", () => {
    rawLine({ amazon_order_id: "111-ok" });
    rawLine({ amazon_order_id: "111-other" });
    const res = importAmazonOrders();
    expect(res.ordersCreated).toBe(2);
    expect(res.errors).toHaveLength(0);
  });
});

describe("resolveCatalogSku", () => {
  it("falls back to the alias table", () => {
    seedCatalogSku("sku-9", "JX-CANON");
    sqlite.prepare("INSERT INTO catalog_sku_aliases (alias, sku_id) VALUES (?, ?)")
      .run("JX1010-TOR", "sku-9");
    expect(resolveCatalogSku("JX1010-TOR-FBA")).toEqual({ skuId: "sku-9", internalSku: "JX1010-TOR" });
  });

  it("returns null instead of guessing", () => {
    expect(resolveCatalogSku("NOPE-FBA").skuId).toBeNull();
  });
});

// ── The guards: these are what stand between us and a double shipment ──

describe("double-ship guards", () => {
  /** Create an Amazon order plus a lookalike Shopify order for contrast. */
  function seedBoth() {
    rawLine();
    importAmazonOrders();
    sqlite.prepare(`
      INSERT INTO orders (id, order_number, channel, status, external_id, total, placed_at, created_at)
      VALUES ('shop-1', '#1001', 'shopify_dtc', 'confirmed', '5550001', 100, '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')
    `).run();
  }

  it("the ShipHero matcher cannot bind a shipment to an Amazon order by order number", () => {
    seedBoth();
    const amazonOrder = getOrder();

    // Even asking for the Amazon order by its exact number must miss: an
    // inbound ShipHero shipment matching here would mark an Amazon order
    // shipped and fire a fulfilment alert for a shipment we never made.
    expect(findLocalOrderIdByShipHeroSignals({ orderNumber: amazonOrder.order_number as string })).toBeNull();
    expect(findLocalOrderIdByShipHeroSignals({ orderNumber: "AMZ-111-9094194-1536224" })).toBeNull();
    // The Shopify order still matches — the guard is targeted, not blunt.
    expect(findLocalOrderIdByShipHeroSignals({ orderNumber: "1001" })).toBe("shop-1");
  });

  it("the ShipHero matcher cannot bind by external id either", () => {
    seedBoth();
    expect(findLocalOrderIdByShipHeroSignals({ externalId: "amazon:111-9094194-1536224" })).toBeNull();
    expect(findLocalOrderIdByShipHeroSignals({ externalId: "5550001" })).toBe("shop-1");
  });

  it("the ShipHero matcher cannot bind by shiphero_order_id", () => {
    seedBoth();
    // Force the (impossible) case where an Amazon row somehow carries one.
    sqlite.prepare("UPDATE orders SET shiphero_order_id = 'sh-999' WHERE channel = 'amazon'").run();
    expect(findLocalOrderIdByShipHeroSignals({ shipheroOrderId: "sh-999" })).toBeNull();
  });

  it("the ShipHero order sync scan skips Amazon rows", () => {
    seedBoth();
    const scanned = sqlite.prepare(
      `SELECT id FROM orders WHERE external_id IS NOT NULL AND channel != 'amazon'`,
    ).all() as Array<{ id: string }>;
    expect(scanned.map((r) => r.id)).toEqual(["shop-1"]);
  });

  it("the stuck-order scan can never see an Amazon order", () => {
    seedBoth();
    // Two independent defences: status never reaches 'confirmed', and the
    // query excludes the channel outright.
    expect(getOrder().status).not.toBe("confirmed");

    sqlite.prepare("UPDATE orders SET status='confirmed' WHERE channel='amazon'").run();
    const stuck = sqlite.prepare(`
      SELECT id FROM orders
      WHERE status = 'confirmed' AND placed_at IS NOT NULL AND placed_at < ?
        AND slack_stuck_alerted_at IS NULL AND channel != 'amazon'
    `).all("2027-01-01") as Array<{ id: string }>;
    expect(stuck.map((r) => r.id)).toEqual(["shop-1"]);
  });

  it("sell-through excludes Amazon so FBA sales cannot trip ShipHero reorder flags", () => {
    seedCatalogSku("sku-1", "JX1010-TOR");
    rawLine();
    importAmazonOrders();
    sqlite.prepare(`
      INSERT INTO orders (id, order_number, channel, status, total, placed_at, created_at)
      VALUES ('shop-2', '#1002', 'shopify_dtc', 'shipped', 50, '2026-07-28T00:00:00Z', '2026-07-28T00:00:00Z')
    `).run();
    sqlite.prepare(`
      INSERT INTO order_items (id, order_id, sku, sku_id, product_name, quantity, unit_price, total_price)
      VALUES ('oi-shop', 'shop-2', 'JX1010-TOR', 'sku-1', 'x', 3, 10, 30)
    `).run();

    const sold = sqlite.prepare(`
      SELECT SUM(oi.quantity) AS units
      FROM order_items oi JOIN orders o ON oi.order_id = o.id
      WHERE o.placed_at >= ? AND o.status NOT IN ('cancelled','returned') AND o.channel != 'amazon'
    `).get("2026-01-01") as { units: number };

    expect(sold.units).toBe(3); // Shopify's 3 only — the Amazon unit excluded
  });

  it("the fulfilled-order Slack alert can never claim an Amazon order", () => {
    rawLine();
    importAmazonOrders();
    // notify-fulfilled claims an order by transitioning shipped_alert_sent_at
    // from NULL; pre-stamping means that claim can never succeed.
    const claimed = sqlite.prepare(
      "UPDATE orders SET shipped_alert_sent_at = datetime('now') WHERE channel = 'amazon' AND shipped_alert_sent_at IS NULL",
    ).run();
    expect(claimed.changes).toBe(0);
  });

  it("Amazon orders carry no company, so customer-account and marketing scans skip them", () => {
    rawLine();
    importAmazonOrders();
    const withCompany = sqlite.prepare(
      "SELECT COUNT(*) n FROM orders WHERE channel='amazon' AND company_id IS NOT NULL",
    ).get() as { n: number };
    expect(withCompany.n).toBe(0);
  });
});

describe("prefix helpers", () => {
  it("produce the structurally-unmatchable identifiers the guards rely on", () => {
    expect(amazonOrderNumber("111-1")).toBe("AMZ-111-1");
    expect(amazonExternalId("111-1")).toBe("amazon:111-1");
  });
});

function round(n: number) {
  return Math.round(n * 100) / 100;
}
