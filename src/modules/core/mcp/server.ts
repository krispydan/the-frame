import { sqlite } from "@/lib/db";
import { z, ZodObject, ZodRawShape } from "zod";

/**
 * MCP Tool definition for The Frame.
 * Lightweight wrapper — we handle JSON-RPC routing ourselves since
 * the MCP SDK's StreamableHTTPServerTransport needs Node http primitives.
 */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<McpToolResult>;
}

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

class McpToolRegistry {
  private tools = new Map<string, McpTool>();

  /**
   * Register a tool with a Zod schema for input validation.
   */
  register<T extends ZodRawShape>(
    name: string,
    description: string,
    schema: ZodObject<T>,
    handler: (args: z.infer<ZodObject<T>>) => Promise<McpToolResult>
  ): void {
    // Convert Zod to JSON Schema-like for tool listing
    const shape = schema.shape;
    const properties: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(shape)) {
      const zodVal = val as z.ZodType;
      properties[key] = { description: zodVal.description || key };
    }

    this.tools.set(name, {
      name,
      description,
      inputSchema: { type: "object", properties },
      handler: async (args) => {
        const parsed = schema.parse(args);
        return handler(parsed);
      },
    });
  }

  /**
   * List all registered tools.
   */
  list(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  /**
   * Call a tool by name.
   */
  async call(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Tool not found: ${name}` }],
        isError: true,
      };
    }
    return tool.handler(args);
  }
}

// ── Singleton registry ──
export const mcpRegistry = new McpToolRegistry();

// ── Lazy tool registration (avoids circular imports at module scope) ──
let _toolsRegistered = false;
export function ensureAllToolsRegistered() {
  if (_toolsRegistered) return;
  _toolsRegistered = true;
  
  // These are dynamically required to avoid circular deps during build
  try {
    const inv = require("@/modules/inventory/mcp");
    inv.registerInventoryMcpTools();
  } catch {}
  try {
    const fin = require("@/modules/finance/mcp/tools");
    fin.registerFinanceMcpTools();
  } catch {}
  try {
    const mkt = require("@/modules/marketing/mcp/tools");
    for (const tool of mkt.marketingMcpTools) mcpRegistry["tools"].set(tool.name, tool);
  } catch {}
  try {
    const intel = require("@/modules/intelligence/mcp/tools");
    for (const tool of intel.intelligenceMcpTools) mcpRegistry["tools"].set(tool.name, tool);
  } catch {}
  // Side-effect registrations
  try { require("@/modules/sales/mcp/tools"); } catch {}
  try { require("@/modules/catalog/mcp/tools"); } catch {}
  try { require("@/modules/catalog/mcp/image-tools"); } catch {}
  try { require("@/modules/customers/mcp/tools"); } catch {}
  try { require("@/modules/orders/mcp/tools"); } catch {}
}

// ── Register Phase 0 system tools ──

mcpRegistry.register(
  "system.health",
  "Returns system health status",
  z.object({}),
  async () => {
    let dbOk = true;
    try {
      sqlite.prepare("SELECT 1").get();
    } catch {
      dbOk = false;
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: dbOk ? "healthy" : "degraded",
            database: dbOk ? "connected" : "error",
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
          }, null, 2),
        },
      ],
    };
  }
);

mcpRegistry.register(
  "system.modules",
  "Lists all registered modules and their status",
  z.object({}),
  async () => {
    const moduleList = [
      { name: "core", label: "Core", description: "System management" },
      { name: "sales", label: "Sales", description: "Prospect & deal management" },
      { name: "catalog", label: "Catalog", description: "Product catalog" },
      { name: "orders", label: "Orders", description: "Order processing" },
      { name: "inventory", label: "Inventory", description: "Stock & POs" },
      { name: "finance", label: "Finance", description: "Financial operations" },
      { name: "customers", label: "Customers", description: "Customer success" },
      { name: "marketing", label: "Marketing", description: "Marketing hub" },
      { name: "intelligence", label: "Intelligence", description: "Business intelligence" },
    ];

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(moduleList, null, 2),
        },
      ],
    };
  }
);

mcpRegistry.register(
  "system.query",
  "Execute a raw SQL query (admin/debug only)",
  z.object({
    sql: z.string().describe("SQL query to execute"),
  }),
  async ({ sql: query }) => {
    try {
      const isSelect = query.trim().toUpperCase().startsWith("SELECT");
      const result = isSelect
        ? sqlite.prepare(query).all()
        : sqlite.prepare(query).run();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `SQL Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);
