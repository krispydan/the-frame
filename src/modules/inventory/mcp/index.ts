import { mcpRegistry } from "@/modules/core/mcp/server";
import { z } from "zod";
import { db, sqlite } from "@/lib/db";
import { sql } from "drizzle-orm";
import { calculateSellThrough, getReorderRecommendations } from "@/modules/inventory/lib/sell-through";
import { runDemandForecast } from "@/modules/inventory/agents/demand-forecaster";

export function registerInventoryMcpTools() {
  // ── inventory.get_stock_levels ──
  mcpRegistry.register(
    "inventory.get_stock_levels",
    "Get current stock levels for all SKUs or a specific SKU. Returns quantity, reserved, reorder point, sell-through rate, days of stock remaining.",
    z.object({
      sku: z.string().optional().describe("Filter by SKU code (e.g., JX1008-BLK). Omit for all."),
      factory: z.string().optional().describe("Filter by factory code (JX1, JX2, JX3, JX4)"),
      lowStockOnly: z.boolean().optional().describe("Only return items below reorder point"),
    }),
    async (args) => {
      let query = `
        SELECT i.quantity, i.reserved_quantity, i.reorder_point, i.sell_through_weekly, i.days_of_stock, i.needs_reorder,
               s.sku, s.color_name, p.name as product_name
        FROM inventory i
        JOIN catalog_skus s ON i.sku_id = s.id
        JOIN catalog_products p ON s.product_id = p.id
        WHERE 1=1
      `;
      const params: unknown[] = [];

      if (args.sku) { query += " AND s.sku = ?"; params.push(args.sku); }
      if (args.factory) { query += " AND s.sku LIKE ?"; params.push(args.factory + "%"); }
      if (args.lowStockOnly) { query += " AND (i.quantity <= i.reorder_point OR i.quantity = 0)"; }
      query += " ORDER BY i.days_of_stock ASC";

      const rows = sqlite.prepare(query).all(...params);
      return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
    }
  );

  // ── inventory.get_sell_through ──
  mcpRegistry.register(
    "inventory.get_sell_through",
    "Calculate sell-through velocity for all SKUs. Shows weekly rate, days of stock, and velocity classification.",
    z.object({
      windowDays: z.number().optional().describe("Analysis window in days (default 30)"),
    }),
    async (args) => {
      const results = calculateSellThrough(args.windowDays || 30);
      const summary = {
        total: results.length,
        fast: results.filter(r => r.velocity === "fast").length,
        normal: results.filter(r => r.velocity === "normal").length,
        slow: results.filter(r => r.velocity === "slow").length,
        dead: results.filter(r => r.velocity === "dead").length,
        needsReorder: results.filter(r => r.needsReorder).length,
      };
      return { content: [{ type: "text" as const, text: JSON.stringify({ summary, items: results.slice(0, 20) }, null, 2) }] };
    }
  );

  // ── inventory.create_purchase_order ──
  mcpRegistry.register(
    "inventory.create_purchase_order",
    "Create a new purchase order for a factory. Provide factory code and line items with SKU and quantity.",
    z.object({
      factoryCode: z.string().describe("Factory code: JX1, JX2, JX3, or JX4"),
      items: z.array(z.object({
        sku: z.string().describe("SKU code (e.g., JX1008-BLK)"),
        quantity: z.number().describe("Quantity to order"),
      })).describe("Line items for the PO"),
      notes: z.string().optional().describe("Optional notes for the PO"),
    }),
    async (args) => {
      // Get factory
      const factory = sqlite.prepare("SELECT id FROM inventory_factories WHERE code = ?").get(args.factoryCode) as { id: string } | undefined;
      if (!factory) return { content: [{ type: "text" as const, text: `Error: Factory ${args.factoryCode} not found` }], isError: true };

      // Get last PO number
      const lastPo = sqlite.prepare("SELECT po_number FROM inventory_purchase_orders ORDER BY po_number DESC LIMIT 1").get() as { po_number: string } | undefined;
      let nextNum = 1;
      if (lastPo) {
        const match = lastPo.po_number.match(/(\d+)$/);
        if (match) nextNum = parseInt(match[1]) + 1;
      }
      const poNumber = `PO-2026-${String(nextNum).padStart(3, "0")}`;
      const poId = crypto.randomUUID();

      let totalUnits = 0;
      let totalCost = 0;
      const lineItemsCreated: Array<{ sku: string; quantity: number; unitCost: number }> = [];

      for (const item of args.items) {
        const skuRow = sqlite.prepare("SELECT id, cost_price FROM catalog_skus WHERE sku = ?").get(item.sku) as { id: string; cost_price: number } | undefined;
        if (!skuRow) continue;
        const unitCost = skuRow.cost_price || 7;
        totalUnits += item.quantity;
        totalCost += item.quantity * unitCost;

        sqlite.prepare(`INSERT INTO inventory_po_line_items (id, po_id, sku_id, quantity, unit_cost, total_cost) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(crypto.randomUUID(), poId, skuRow.id, item.quantity, unitCost, item.quantity * unitCost);
        lineItemsCreated.push({ sku: item.sku, quantity: item.quantity, unitCost });
      }

      const orderDate = new Date().toISOString().split("T")[0];
      sqlite.prepare(`INSERT INTO inventory_purchase_orders (id, po_number, factory_id, status, total_units, total_cost, order_date, notes) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?)`)
        .run(poId, poNumber, factory.id, totalUnits, totalCost, orderDate, args.notes || null);

      return { content: [{ type: "text" as const, text: JSON.stringify({ poNumber, totalUnits, totalCost, lineItems: lineItemsCreated }, null, 2) }] };
    }
  );

  // ── inventory.get_reorder_recommendations ──
  mcpRegistry.register(
    "inventory.get_reorder_recommendations",
    "Get AI-powered reorder recommendations. Returns SKUs that need reordering with suggested quantities and urgency levels.",
    z.object({
      targetStockDays: z.number().optional().describe("Target days of stock to maintain (default 90)"),
    }),
    async (args) => {
      const forecast = runDemandForecast(args.targetStockDays || 90);
      const actionable = forecast.filter(r => r.urgencyLevel !== "ok");
      return { content: [{ type: "text" as const, text: JSON.stringify({
        actionableCount: actionable.length,
        items: actionable.map(r => ({
          sku: r.sku,
          product: r.productName,
          color: r.colorName,
          factory: r.factoryCode,
          currentStock: r.currentStock,
          daysUntilStockout: r.daysUntilStockout,
          recommendedQty: r.recommendedReorderQty,
          urgency: r.urgencyLevel,
          trend: r.trendDirection,
          notes: r.notes,
        })),
      }, null, 2) }] };
    }
  );

  // ── inventory.update_stock ──
  mcpRegistry.register(
    "inventory.update_stock",
    "Update stock level for a SKU. Records an inventory movement.",
    z.object({
      sku: z.string().describe("SKU code (e.g., JX1008-BLK)"),
      quantityChange: z.number().describe("Change in quantity (positive = add, negative = subtract)"),
      reason: z.string().describe("Reason: purchase, sale, return, adjustment, transfer"),
      referenceId: z.string().optional().describe("Optional reference (order ID, PO number, etc.)"),
    }),
    async (args) => {
      const skuRow = sqlite.prepare("SELECT id FROM catalog_skus WHERE sku = ?").get(args.sku) as { id: string } | undefined;
      if (!skuRow) return { content: [{ type: "text" as const, text: `Error: SKU ${args.sku} not found` }], isError: true };

      const inv = sqlite.prepare("SELECT id, quantity FROM inventory WHERE sku_id = ?").get(skuRow.id) as { id: string; quantity: number } | undefined;
      if (!inv) return { content: [{ type: "text" as const, text: `Error: No inventory record for ${args.sku}` }], isError: true };

      const newQty = Math.max(0, inv.quantity + args.quantityChange);
      sqlite.prepare("UPDATE inventory SET quantity = ?, updated_at = datetime('now') WHERE id = ?").run(newQty, inv.id);

      // Record movement
      sqlite.prepare(`INSERT INTO inventory_movements (id, sku_id, from_location, to_location, quantity, reason, reference_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(crypto.randomUUID(), skuRow.id,
          args.quantityChange < 0 ? "warehouse" : null,
          args.quantityChange > 0 ? "warehouse" : null,
          Math.abs(args.quantityChange), args.reason, args.referenceId || null);

      return { content: [{ type: "text" as const, text: JSON.stringify({ sku: args.sku, previousQty: inv.quantity, newQty, change: args.quantityChange, reason: args.reason }) }] };
    }
  );
}
