import type { ModuleDefinition } from "@/modules/shared/types";

export const inventoryModule: ModuleDefinition = {
  name: "inventory",
  label: "Inventory",
  description: "Stock tracking and supply chain",
  routes: [{ path: "/inventory", label: "Inventory", icon: "📋" }, { path: "/inventory/purchase-orders", label: "Purchase Orders" }],
  schema: [],
  mcpTools: [],
  eventHooks: {},
};
