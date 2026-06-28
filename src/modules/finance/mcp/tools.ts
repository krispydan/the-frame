import { mcpRegistry } from "@/modules/core/mcp/server";
import { z } from "zod";
import { sqlite } from "@/lib/db";
import { calculatePnl } from "@/modules/finance/lib/pnl";
import { calculateCashFlow } from "@/modules/finance/lib/cash-flow";
import { syncSettlementToXero, isXeroConfigured, getXeroSetupInstructions } from "@/modules/finance/lib/xero-client";
import { createLayersForShipment } from "@/modules/finance/lib/cogs-ingest";

export function registerFinanceMcpTools() {
  // ── finance.get_pnl ──
  mcpRegistry.register(
    "finance.get_pnl",
    "Get P&L summary with channel breakdown. Shows revenue, COGS, gross margin, fees, expenses, and net income per channel.",
    z.object({
      period: z.enum(["mtd", "qtd", "ytd", "custom"]).optional().describe("Time period (default: mtd)"),
      start: z.string().optional().describe("Custom period start (YYYY-MM-DD)"),
      end: z.string().optional().describe("Custom period end (YYYY-MM-DD)"),
    }),
    async (args) => {
      const pnl = calculatePnl(args.period || "mtd", args.start, args.end);
      return { content: [{ type: "text", text: JSON.stringify(pnl, null, 2) }] };
    }
  );

  // ── finance.list_settlements ──
  mcpRegistry.register(
    "finance.list_settlements",
    "List settlement records. Filter by channel, status, or date range.",
    z.object({
      channel: z.string().optional().describe("Filter: shopify_dtc, shopify_wholesale, faire, amazon"),
      status: z.string().optional().describe("Filter: pending, received, reconciled, synced_to_xero"),
      limit: z.number().optional().describe("Max results (default 20)"),
    }),
    async (args) => {
      let query = "SELECT * FROM settlements WHERE 1=1";
      const params: unknown[] = [];

      if (args.channel) { query += " AND channel = ?"; params.push(args.channel); }
      if (args.status) { query += " AND status = ?"; params.push(args.status); }
      query += " ORDER BY period_end DESC LIMIT ?";
      params.push(args.limit || 20);

      const results = sqlite.prepare(query).all(...params);
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }
  );

  // ── finance.get_cash_flow ──
  mcpRegistry.register(
    "finance.get_cash_flow",
    "Get cash flow summary with current position, pending inflows, expected outflows, and 30/60/90 day forecast.",
    z.object({}),
    async () => {
      const cf = calculateCashFlow();
      return { content: [{ type: "text", text: JSON.stringify(cf, null, 2) }] };
    }
  );

  // ── finance.add_expense ──
  mcpRegistry.register(
    "finance.add_expense",
    "Add a new expense. Specify description, amount, vendor, date, and optionally a category and recurring flag.",
    z.object({
      description: z.string().describe("Expense description"),
      amount: z.number().describe("Amount in USD"),
      vendor: z.string().optional().describe("Vendor name"),
      date: z.string().optional().describe("Date (YYYY-MM-DD, default today)"),
      category: z.string().optional().describe("Category name (e.g., Marketing & Advertising, Software & Tools)"),
      recurring: z.boolean().optional().describe("Is this a recurring expense?"),
      frequency: z.string().optional().describe("Frequency: weekly, monthly, quarterly, annually"),
    }),
    async (args) => {
      // Look up category by name
      let categoryId: string | null = null;
      if (args.category) {
        const cat = sqlite.prepare("SELECT id FROM expense_categories WHERE name LIKE ?").get(`%${args.category}%`) as { id: string } | undefined;
        categoryId = cat?.id || null;
      }

      const id = crypto.randomUUID();
      const date = args.date || new Date().toISOString().split("T")[0];

      sqlite.prepare(`
        INSERT INTO expenses (id, category_id, description, amount, vendor, date, recurring, frequency)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, categoryId, args.description, args.amount, args.vendor || null, date, args.recurring ? 1 : 0, args.frequency || null);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ success: true, id, message: `Expense added: ${args.description} — $${args.amount}` }),
        }],
      };
    }
  );

  // ── finance.sync_to_xero ──
  mcpRegistry.register(
    "finance.sync_to_xero",
    "Sync a settlement to Xero as a bank transaction. Requires Xero to be configured.",
    z.object({
      settlementId: z.string().describe("Settlement ID to sync"),
    }),
    async (args) => {
      if (!isXeroConfigured()) {
        return {
          content: [{ type: "text", text: getXeroSetupInstructions() }],
        };
      }
      const result = await syncSettlementToXero(args.settlementId);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── finance.create_cost_layers_from_shipment ──
  // The deterministic core of invoice ingestion. The agent parses the factory
  // CI/PL (xlsx/xls/pdf) + the KCI/DHL freight/duty totals, then calls this
  // with structured data. It validates, allocates freight/duty by value, and
  // creates guarded, idempotent FIFO cost layers (one per SKU). Pass
  // dryRun:true first to preview + reconcile before writing.
  mcpRegistry.register(
    "finance.create_cost_layers_from_shipment",
    "Create FIFO cost layers for an inbound shipment from parsed invoice data. Allocates freight + duty across SKUs by value into landed cost. Idempotent per (poNumber, sku); rejects $0 cost; validates against expectedUnits/expectedFactoryTotal when provided. Use dryRun to preview. The caller parses the invoices; this writes the layers.",
    z.object({
      mode: z.enum(["air", "ocean"]).describe("Shipping method — air lands ~2x the freight load of ocean"),
      poNumber: z.string().describe("PO number — the idempotency key with sku (e.g. JAX200)"),
      receivedAt: z.string().describe("ShipHero physical receipt date, YYYY-MM-DD (sets FIFO order)"),
      factory: z.string().optional(),
      invoiceNumber: z.string().optional(),
      freightTotal: z.number().optional().describe("Freight + shipping total for the shipment (allocated by value)"),
      brokerTotal: z.number().optional().describe("Import entry / FDA / broker fees (allocated by value)"),
      dutyTotal: z.number().optional().describe("Customs duty total (allocated by value)"),
      expectedUnits: z.number().optional().describe("Validation gate: total units expected"),
      expectedFactoryTotal: z.number().optional().describe("Validation gate: total product cost expected"),
      lines: z.array(z.object({
        sku: z.string(),
        units: z.number().describe("Individual units (already pack-normalized)"),
        unitCost: z.number().describe("Per-individual-unit product cost (FOB)"),
      })).describe("One row per SKU. For blended-priced shipments use qty × blended unit cost."),
      dryRun: z.boolean().optional().describe("Preview without writing (default false)"),
    }),
    async (args) => {
      const { dryRun, ...shipment } = args;
      const result = createLayersForShipment(shipment, { apply: !dryRun });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );
}
