import type { ModuleDefinition } from "@/modules/shared/types";

// Side-effect imports to register webhook handlers and MCP tools
import "./lib/shopify-webhooks";
import "./mcp/tools";

export const ordersModule: ModuleDefinition = {
  name: "orders",
  label: "Orders",
  description: "Unified order management across Shopify, Faire, and direct channels",
  routes: [{ path: "/orders", label: "Orders", icon: "📦" }],
  schema: [],
  mcpTools: [
    "orders.list_orders",
    "orders.get_order",
    "orders.create_order",
    "orders.update_status",
    "orders.process_return",
  ],
  eventHooks: {},
};
