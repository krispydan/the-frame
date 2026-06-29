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

/**
 * Minimal Zod → JSON Schema for a single field. MCP clients need each property
 * to carry a `type` (and enum/items) or they drop the value when forwarding the
 * call — which silently turned every parameterized tool into a no-arg tool.
 * Defensive: unknown types fall back to an untyped object so listing never throws.
 */
function zodFieldToJsonSchema(zt: z.ZodType): Record<string, unknown> {
  try {
    // Unwrap optional / nullable / default to the inner type.
    let inner = zt;
    while (
      inner instanceof z.ZodOptional ||
      inner instanceof z.ZodNullable ||
      inner instanceof z.ZodDefault
    ) {
      inner = (inner as unknown as { unwrap?: () => z.ZodType }).unwrap?.()
        ?? (inner as unknown as { _def: { innerType: z.ZodType } })._def.innerType;
    }
    const desc = zt.description || inner.description;
    const withDesc = (s: Record<string, unknown>) => (desc ? { ...s, description: desc } : s);

    if (inner instanceof z.ZodString) return withDesc({ type: "string" });
    if (inner instanceof z.ZodNumber) return withDesc({ type: "number" });
    if (inner instanceof z.ZodBoolean) return withDesc({ type: "boolean" });
    if (inner instanceof z.ZodEnum) return withDesc({ type: "string", enum: (inner as z.ZodEnum<never>).options });
    if (inner instanceof z.ZodArray) {
      return withDesc({ type: "array", items: zodFieldToJsonSchema((inner as z.ZodArray<z.ZodType>).element) });
    }
    if (inner instanceof z.ZodObject) {
      const shape = (inner as ZodObject<ZodRawShape>).shape;
      const properties: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(shape)) properties[k] = zodFieldToJsonSchema(v as z.ZodType);
      return withDesc({ type: "object", properties });
    }
    return withDesc({ type: "string" }); // safe default — better a typed string than untyped
  } catch {
    return { type: "string" };
  }
}

/** True when the field is required (not optional/default). */
function zodFieldRequired(zt: z.ZodType): boolean {
  return !(zt instanceof z.ZodOptional || zt instanceof z.ZodDefault);
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
    // Convert Zod to JSON Schema for tool listing. Each property MUST carry a
    // `type` — without it, MCP clients drop the argument values when forwarding
    // the call (every parameterized tool silently became a no-arg tool).
    const shape = schema.shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, val] of Object.entries(shape)) {
      const zodVal = val as z.ZodType;
      properties[key] = zodFieldToJsonSchema(zodVal);
      if (zodFieldRequired(zodVal)) required.push(key);
    }

    this.tools.set(name, {
      name,
      description,
      inputSchema: required.length
        ? { type: "object", properties, required }
        : { type: "object", properties },
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
