/**
 * FIFO Inventory Costing Engine
 *
 * Implements lot-based FIFO costing for Jaxy's sunglasses inventory:
 *   1. Cost Layer Creation — when a PO is received, create one cost layer
 *      per line item with allocated landed costs (freight + duties)
 *   2. FIFO Depletion — when units are sold, consume from the oldest
 *      cost layer first per SKU
 *   3. Weekly COGS — aggregate depletions for a period, split by
 *      product cost / freight / duties for Xero journal posting
 *
 * Cost layers are immutable once created. Remaining quantity is the only
 * mutable field (decremented on depletion). This gives a clean audit trail.
 */
import { sqlite } from "@/lib/db";

// ── Types ──

export interface CostLayer {
  id: string;
  skuId: string;
  poLineItemId: string | null;
  poId: string | null;
  poNumber: string | null;
  quantity: number;
  remainingQuantity: number;
  unitCost: number;
  freightPerUnit: number;
  dutiesPerUnit: number;
  landedCostPerUnit: number;
  shippingMethod: string | null;
  receivedAt: string;
  createdAt: string;
}

export interface CostDepletion {
  id: string;
  costLayerId: string;
  orderItemId: string | null;
  orderId: string | null;
  channel: string | null;
  quantity: number;
  unitCost: number;
  landedCostPerUnit: number;
  depletedAt: string;
}

export interface CogsCalculation {
  weekStart: string;
  weekEnd: string;
  productCost: number;
  freightCost: number;
  dutiesCost: number;
  totalCogs: number;
  unitCount: number;
  channelBreakdown: Record<string, { units: number; productCost: number; freightCost: number; dutiesCost: number; totalCogs: number }>;
  depletions: CostDepletion[];
}

export interface CreateCostLayerInput {
  skuId: string;
  poLineItemId?: string;
  poId?: string;
  poNumber?: string;
  quantity: number;
  unitCost: number;
  freightPerUnit?: number;
  dutiesPerUnit?: number;
  shippingMethod?: string;
  receivedAt?: string;
}

// ── Cost Layer Management ──

/**
 * Create a single cost layer. Called per PO line item on receipt.
 */
export function createCostLayer(input: CreateCostLayerInput): CostLayer {
  const id = crypto.randomUUID();
  const freightPerUnit = input.freightPerUnit ?? 0;
  const dutiesPerUnit = input.dutiesPerUnit ?? 0;
  const landedCostPerUnit = input.unitCost + freightPerUnit + dutiesPerUnit;
  const receivedAt = input.receivedAt || new Date().toISOString();

  sqlite.prepare(`
    INSERT INTO inventory_cost_layers
      (id, sku_id, po_line_item_id, po_id, po_number, quantity, remaining_quantity,
       unit_cost, freight_per_unit, duties_per_unit, landed_cost_per_unit,
       shipping_method, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, input.skuId, input.poLineItemId ?? null, input.poId ?? null,
    input.poNumber ?? null, input.quantity, input.quantity,
    input.unitCost, freightPerUnit, dutiesPerUnit, landedCostPerUnit,
    input.shippingMethod ?? null, receivedAt,
  );

  return {
    id, skuId: input.skuId, poLineItemId: input.poLineItemId ?? null,
    poId: input.poId ?? null, poNumber: input.poNumber ?? null,
    quantity: input.quantity, remainingQuantity: input.quantity,
    unitCost: input.unitCost, freightPerUnit, dutiesPerUnit, landedCostPerUnit,
    shippingMethod: input.shippingMethod ?? null, receivedAt,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Create cost layers from a PO receipt. Allocates the PO's shipping,
 * duties, and freight costs pro-rata across line items by quantity.
 */
export function createCostLayersFromPO(poId: string): CostLayer[] {
  const po = sqlite.prepare(`
    SELECT id, po_number, shipping_cost, duties_cost, freight_cost, total_units,
           actual_arrival_date, status
    FROM inventory_purchase_orders WHERE id = ?
  `).get(poId) as {
    id: string; po_number: string; shipping_cost: number; duties_cost: number;
    freight_cost: number; total_units: number; actual_arrival_date: string | null;
    status: string;
  } | undefined;

  if (!po) throw new Error(`PO ${poId} not found`);

  const lineItems = sqlite.prepare(`
    SELECT id, sku_id, quantity, unit_cost FROM inventory_po_line_items WHERE po_id = ?
  `).all(poId) as Array<{ id: string; sku_id: string; quantity: number; unit_cost: number }>;

  if (lineItems.length === 0) throw new Error(`PO ${poId} has no line items`);

  // Total units for pro-rata allocation
  const totalUnits = lineItems.reduce((sum, li) => sum + li.quantity, 0) || po.total_units || 1;
  const totalLandedCosts = (po.shipping_cost || 0) + (po.duties_cost || 0) + (po.freight_cost || 0);
  const shippingPerUnit = (po.shipping_cost || 0) / totalUnits;
  const dutiesPerUnit = (po.duties_cost || 0) / totalUnits;
  const freightPerUnit = ((po.freight_cost || 0) + shippingPerUnit * totalUnits === totalLandedCosts
    ? shippingPerUnit // if freight_cost is separate from shipping_cost
    : (po.freight_cost || 0) / totalUnits);

  // Combine shipping + freight into freightPerUnit for simplicity
  const combinedFreightPerUnit = ((po.shipping_cost || 0) + (po.freight_cost || 0)) / totalUnits;

  const layers: CostLayer[] = [];
  for (const li of lineItems) {
    // Check if a layer already exists for this PO line item (idempotent)
    const existing = sqlite.prepare(
      "SELECT id FROM inventory_cost_layers WHERE po_line_item_id = ?"
    ).get(li.id) as { id: string } | undefined;
    if (existing) continue;

    layers.push(createCostLayer({
      skuId: li.sku_id,
      poLineItemId: li.id,
      poId: po.id,
      poNumber: po.po_number,
      quantity: li.quantity,
      unitCost: li.unit_cost,
      freightPerUnit: combinedFreightPerUnit,
      dutiesPerUnit: dutiesPerUnit,
      receivedAt: po.actual_arrival_date || new Date().toISOString(),
    }));
  }

  return layers;
}

// ── FIFO Depletion ──

export interface DepletionResult {
  totalDepleted: number;
  totalProductCost: number;
  totalLandedCost: number;
  depletions: CostDepletion[];
  shortfall: number; // units we couldn't cover (no cost layers remaining)
}

/**
 * Deplete inventory FIFO for a given SKU. Consumes from the oldest
 * cost layer first. Returns the depletion records for COGS tracking.
 *
 * This is idempotent if the same orderItemId is passed — it checks for
 * existing depletions and skips if already recorded.
 */
export function depleteInventoryFifo(
  skuId: string,
  quantity: number,
  opts: {
    orderItemId?: string;
    orderId?: string;
    channel?: string;
    depletedAt?: string;
  } = {},
): DepletionResult {
  const depletedAt = opts.depletedAt || new Date().toISOString();
  const result: DepletionResult = {
    totalDepleted: 0,
    totalProductCost: 0,
    totalLandedCost: 0,
    depletions: [],
    shortfall: 0,
  };

  // Check for existing depletions for this order item (idempotent)
  if (opts.orderItemId) {
    const existing = sqlite.prepare(
      "SELECT SUM(quantity) as qty FROM inventory_cost_depletions WHERE order_item_id = ?"
    ).get(opts.orderItemId) as { qty: number | null };
    if (existing?.qty && existing.qty >= quantity) return result; // already depleted
  }

  let remaining = quantity;

  // Get available cost layers for this SKU, oldest first (FIFO)
  const layers = sqlite.prepare(`
    SELECT * FROM inventory_cost_layers
    WHERE sku_id = ? AND remaining_quantity > 0
    ORDER BY received_at ASC, created_at ASC
  `).all(skuId) as CostLayer[];

  for (const layer of layers) {
    if (remaining <= 0) break;

    const take = Math.min(remaining, layer.remainingQuantity);
    const depletionId = crypto.randomUUID();

    // Record depletion
    sqlite.prepare(`
      INSERT INTO inventory_cost_depletions
        (id, cost_layer_id, order_item_id, order_id, channel, quantity,
         unit_cost, landed_cost_per_unit, depleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      depletionId, layer.id, opts.orderItemId ?? null,
      opts.orderId ?? null, opts.channel ?? null,
      take, layer.unitCost, layer.landedCostPerUnit, depletedAt,
    );

    // Decrement remaining quantity on the layer
    sqlite.prepare(`
      UPDATE inventory_cost_layers SET remaining_quantity = remaining_quantity - ? WHERE id = ?
    `).run(take, layer.id);

    result.depletions.push({
      id: depletionId, costLayerId: layer.id,
      orderItemId: opts.orderItemId ?? null, orderId: opts.orderId ?? null,
      channel: opts.channel ?? null, quantity: take,
      unitCost: layer.unitCost, landedCostPerUnit: layer.landedCostPerUnit,
      depletedAt,
    });

    result.totalDepleted += take;
    result.totalProductCost += take * layer.unitCost;
    result.totalLandedCost += take * layer.landedCostPerUnit;
    remaining -= take;
  }

  result.shortfall = remaining;
  return result;
}

// ── Weekly COGS Calculation ──

/**
 * Calculate COGS for a date range by summing all cost depletions in that
 * period. Splits costs into product / freight / duties components and
 * breaks down by sales channel.
 */
export function calculateCogs(weekStart: string, weekEnd: string): CogsCalculation {
  const depletions = sqlite.prepare(`
    SELECT d.*, l.freight_per_unit, l.duties_per_unit, l.unit_cost as layer_unit_cost
    FROM inventory_cost_depletions d
    JOIN inventory_cost_layers l ON d.cost_layer_id = l.id
    WHERE d.depleted_at >= ? AND d.depleted_at < ?
    ORDER BY d.depleted_at ASC
  `).all(weekStart, weekEnd + "T23:59:59") as Array<CostDepletion & {
    freight_per_unit: number; duties_per_unit: number; layer_unit_cost: number;
  }>;

  const channelBreakdown: Record<string, { units: number; productCost: number; freightCost: number; dutiesCost: number; totalCogs: number }> = {};

  let productCost = 0;
  let freightCost = 0;
  let dutiesCost = 0;
  let unitCount = 0;

  for (const d of depletions) {
    const pc = d.quantity * d.layer_unit_cost;
    const fc = d.quantity * d.freight_per_unit;
    const dc = d.quantity * d.duties_per_unit;

    productCost += pc;
    freightCost += fc;
    dutiesCost += dc;
    unitCount += d.quantity;

    const ch = d.channel || "unknown";
    if (!channelBreakdown[ch]) {
      channelBreakdown[ch] = { units: 0, productCost: 0, freightCost: 0, dutiesCost: 0, totalCogs: 0 };
    }
    channelBreakdown[ch].units += d.quantity;
    channelBreakdown[ch].productCost += pc;
    channelBreakdown[ch].freightCost += fc;
    channelBreakdown[ch].dutiesCost += dc;
    channelBreakdown[ch].totalCogs += pc + fc + dc;
  }

  return {
    weekStart, weekEnd,
    productCost: Math.round(productCost * 100) / 100,
    freightCost: Math.round(freightCost * 100) / 100,
    dutiesCost: Math.round(dutiesCost * 100) / 100,
    totalCogs: Math.round((productCost + freightCost + dutiesCost) * 100) / 100,
    unitCount,
    channelBreakdown,
    depletions: depletions as unknown as CostDepletion[],
  };
}

/**
 * Save a COGS calculation as a draft journal for review / Xero posting.
 */
export function saveCogsJournal(calc: CogsCalculation, notes?: string): string {
  // Check for duplicate (same week range)
  const existing = sqlite.prepare(
    "SELECT id FROM cogs_journals WHERE week_start = ? AND week_end = ?"
  ).get(calc.weekStart, calc.weekEnd) as { id: string } | undefined;

  if (existing) {
    // Update existing draft
    sqlite.prepare(`
      UPDATE cogs_journals SET
        product_cost = ?, freight_cost = ?, duties_cost = ?, total_cogs = ?,
        unit_count = ?, channel_breakdown = ?, notes = ?
      WHERE id = ? AND status = 'draft'
    `).run(
      calc.productCost, calc.freightCost, calc.dutiesCost, calc.totalCogs,
      calc.unitCount, JSON.stringify(calc.channelBreakdown), notes ?? null,
      existing.id,
    );
    return existing.id;
  }

  const id = crypto.randomUUID();
  sqlite.prepare(`
    INSERT INTO cogs_journals
      (id, week_start, week_end, product_cost, freight_cost, duties_cost,
       total_cogs, unit_count, channel_breakdown, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, calc.weekStart, calc.weekEnd, calc.productCost,
    calc.freightCost, calc.dutiesCost, calc.totalCogs, calc.unitCount,
    JSON.stringify(calc.channelBreakdown), notes ?? null,
  );
  return id;
}

// ── Query Helpers ──

/**
 * Get all cost layers for a SKU, ordered oldest first.
 */
export function getCostLayersForSku(skuId: string): CostLayer[] {
  return sqlite.prepare(`
    SELECT * FROM inventory_cost_layers WHERE sku_id = ? ORDER BY received_at ASC
  `).all(skuId) as CostLayer[];
}

/**
 * Get a summary of cost layers across all SKUs — current inventory at cost.
 */
export function getCostLayerSummary(): Array<{
  skuId: string;
  sku: string | null;
  productName: string | null;
  colorName: string | null;
  totalUnits: number;
  remainingUnits: number;
  avgLandedCost: number;
  oldestLayerDate: string | null;
  layerCount: number;
}> {
  return sqlite.prepare(`
    SELECT
      cl.sku_id as skuId,
      cs.sku,
      cp.name as productName,
      cs.color_name as colorName,
      SUM(cl.quantity) as totalUnits,
      SUM(cl.remaining_quantity) as remainingUnits,
      ROUND(AVG(cl.landed_cost_per_unit), 4) as avgLandedCost,
      MIN(cl.received_at) as oldestLayerDate,
      COUNT(*) as layerCount
    FROM inventory_cost_layers cl
    LEFT JOIN catalog_skus cs ON cl.sku_id = cs.id
    LEFT JOIN catalog_products cp ON cs.product_id = cp.id
    GROUP BY cl.sku_id
    HAVING remainingUnits > 0
    ORDER BY cp.name, cs.color_name
  `).all() as Array<{
    skuId: string; sku: string | null; productName: string | null;
    colorName: string | null; totalUnits: number; remainingUnits: number;
    avgLandedCost: number; oldestLayerDate: string | null; layerCount: number;
  }>;
}

/**
 * Get all COGS journals, newest first.
 */
export function getCogsJournals(): Array<{
  id: string; weekStart: string; weekEnd: string;
  productCost: number; freightCost: number; dutiesCost: number;
  totalCogs: number; unitCount: number; channelBreakdown: string | null;
  status: string; xeroJournalId: string | null; xeroPostedAt: string | null;
  notes: string | null; createdAt: string;
}> {
  return sqlite.prepare(`
    SELECT * FROM cogs_journals ORDER BY week_start DESC
  `).all() as any[];
}

/**
 * Mark a COGS journal as posted to Xero.
 */
export function markJournalPosted(journalId: string, xeroJournalId: string): void {
  sqlite.prepare(`
    UPDATE cogs_journals
    SET status = 'posted', xero_journal_id = ?, xero_posted_at = datetime('now')
    WHERE id = ?
  `).run(xeroJournalId, journalId);
}

/**
 * Deplete orders that haven't been costed yet.
 * Finds fulfilled order items that have no depletions and runs FIFO on them.
 */
export function depleteUncostedOrders(options?: { since?: string; dryRun?: boolean }): {
  processed: number;
  depleted: number;
  shortfalls: Array<{ sku: string; skuId: string; quantity: number; shortfall: number }>;
} {
  const since = options?.since || "2020-01-01";

  // Find order items with no cost depletions
  const uncosted = sqlite.prepare(`
    SELECT oi.id as orderItemId, oi.order_id as orderId, oi.sku_id as skuId,
           oi.sku, oi.quantity, o.channel, o.shipped_at as shippedAt
    FROM order_items oi
    JOIN orders o ON oi.order_id = o.id
    LEFT JOIN inventory_cost_depletions d ON d.order_item_id = oi.id
    WHERE o.status IN ('shipped', 'delivered')
      AND o.shipped_at >= ?
      AND oi.sku_id IS NOT NULL
      AND d.id IS NULL
    ORDER BY o.shipped_at ASC
  `).all(since) as Array<{
    orderItemId: string; orderId: string; skuId: string;
    sku: string; quantity: number; channel: string; shippedAt: string;
  }>;

  let processed = 0;
  let depleted = 0;
  const shortfalls: Array<{ sku: string; skuId: string; quantity: number; shortfall: number }> = [];

  for (const item of uncosted) {
    processed++;
    if (options?.dryRun) continue;

    const result = depleteInventoryFifo(item.skuId, item.quantity, {
      orderItemId: item.orderItemId,
      orderId: item.orderId,
      channel: item.channel,
      depletedAt: item.shippedAt || new Date().toISOString(),
    });

    depleted += result.totalDepleted;
    if (result.shortfall > 0) {
      shortfalls.push({
        sku: item.sku, skuId: item.skuId,
        quantity: item.quantity, shortfall: result.shortfall,
      });
    }
  }

  return { processed, depleted, shortfalls };
}
