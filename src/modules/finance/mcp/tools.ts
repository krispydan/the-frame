import { mcpRegistry } from "@/modules/core/mcp/server";
import { z } from "zod";
import { sqlite } from "@/lib/db";
import { calculatePnl } from "@/modules/finance/lib/pnl";
import { calculateCashFlow } from "@/modules/finance/lib/cash-flow";
import { syncSettlementToXero, isXeroConfigured, getXeroSetupInstructions } from "@/modules/finance/lib/xero-client";
import { createLayersForShipment } from "@/modules/finance/lib/cogs-ingest";
import { runDailyCogsPosting } from "@/modules/finance/lib/daily-cogs";
import { runCogsBackfill } from "@/modules/finance/lib/cogs-backfill";
import { stripCogsFromOldRecognitions } from "@/modules/finance/lib/cogs-remediation";

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

  // ── finance.run_cogs_backfill ──
  // Replay the daily FIFO COGS job across a date range. dryRun reports the
  // would-post + exceptions with no writes/Xero posting. Live posts one Xero
  // journal per day. Use for go-live history once opening layers are seeded.
  mcpRegistry.register(
    "finance.run_cogs_backfill",
    "Backfill daily FIFO COGS across a date range (inclusive). dryRun=true previews units, COGS, and exceptions per day WITHOUT writing depletions or posting to Xero — always run dryRun first and review before a live run. Live posts one consolidated COGS journal per day to Xero.",
    z.object({
      from: z.string().describe("Start date YYYY-MM-DD (inclusive)"),
      to: z.string().describe("End date YYYY-MM-DD (inclusive)"),
      dryRun: z.boolean().optional().describe("Preview only — no writes, no Xero (default false)"),
      force: z.boolean().optional().describe("Re-post days already posted (default false)"),
    }),
    async (args) => {
      const result = await runCogsBackfill({ from: args.from, to: args.to, dryRun: args.dryRun, force: args.force });
      // Trim per-day exception arrays for readability; keep counts + totals.
      const summary = {
        from: result.from, to: result.to, dryRun: result.dryRun,
        totalUnits: result.totalUnits, totalCogs: result.totalCogs, totalExceptions: result.totalExceptions,
        days: result.days.map((d) => ({
          date: d.date, units: d.unitsCosted, cogs: d.totalCogs,
          exceptions: d.exceptions.length, xeroJournalId: d.xeroJournalId, skipped: d.skipped,
        })),
      };
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }
  );

  // ── finance.add_sku_alias ──
  // Map a sales/order SKU string with no catalog row (e.g. a size-variant like
  // JX4004-S-BLK) to a canonical catalog SKU, so it costs against that SKU's
  // FIFO layers instead of raising an unmapped_sku exception. Re-run the
  // affected COGS day(s) afterward (finance.run_daily_cogs force / correct).
  mcpRegistry.register(
    "finance.add_sku_alias",
    "Alias a non-catalog order SKU to a canonical catalog SKU for COGS costing. Use when an unmapped_sku exception is really a mis-formatted/size variant of an existing SKU. After adding, re-cost the affected day(s).",
    z.object({
      alias: z.string().describe("The order/sales SKU string as it appears on orders (e.g. JX4004-S-BLK)"),
      canonicalSku: z.string().describe("Existing catalog SKU to cost against (e.g. JX4004-BLK)"),
      note: z.string().optional(),
    }),
    async (args) => {
      const row = sqlite.prepare("SELECT id FROM catalog_skus WHERE sku = ? LIMIT 1").get(args.canonicalSku) as { id: string } | undefined;
      if (!row) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `canonical SKU ${args.canonicalSku} not in catalog` }) }] };
      sqlite.prepare(
        "INSERT OR REPLACE INTO catalog_sku_aliases (alias, sku_id, canonical_sku, note) VALUES (?, ?, ?, ?)",
      ).run(args.alias, row.id, args.canonicalSku, args.note ?? null);
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, alias: args.alias, canonicalSku: args.canonicalSku }) }] };
    }
  );

  // ── finance.strip_old_recognition_cogs ──
  // One-off remediation: re-post the old Stage-2 per-order recognition journals
  // revenue-only (remove the duplicated DR 5000 / CR 1400 COGS pair now handled
  // by the FIFO daily job). Idempotent. DEFAULTS TO DRY RUN — pass dryRun:false
  // to actually edit Xero. Run dryRun first and review.
  mcpRegistry.register(
    "finance.strip_old_recognition_cogs",
    "Remediation: strip the duplicated COGS pair (5000/1400) from the old Stage-2 revenue-recognition Manual Journals, re-posting each revenue-only. Defaults to dryRun (GETs only). Pass dryRun:false to edit Xero. Idempotent; zeroes cogs_amount after each strip.",
    z.object({
      dryRun: z.boolean().optional().describe("Preview only — GET journals, report what would change, no Xero edits (default TRUE)"),
      limit: z.number().optional().describe("Cap number of journals processed (for a staged first batch)"),
    }),
    async (args) => {
      const result = await stripCogsFromOldRecognitions({ dryRun: args.dryRun, limit: args.limit });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── finance.run_daily_cogs ──
  mcpRegistry.register(
    "finance.run_daily_cogs",
    "Run the daily FIFO COGS job for a single day (default yesterday UTC). dryRun=true previews without writing or posting to Xero. Posts one consolidated COGS journal on a live run.",
    z.object({
      date: z.string().optional().describe("Day to cost, YYYY-MM-DD (default yesterday UTC)"),
      dryRun: z.boolean().optional().describe("Preview only — no writes, no Xero (default false)"),
      force: z.boolean().optional().describe("Re-post even if the day is already posted (default false)"),
    }),
    async (args) => {
      const result = await runDailyCogsPosting({ date: args.date, dryRun: args.dryRun, force: args.force });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );
}
