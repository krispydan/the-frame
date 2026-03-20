import type { ModuleDefinition } from "@/modules/shared/types";

export const ordersModule: ModuleDefinition = {
  name: "orders",
  label: "Orders",
  description: "Unified order management",
  routes: [{ path: "/orders", label: "Orders", icon: "📦" }],
  schema: [],
  mcpTools: [],
  eventHooks: {},
};
