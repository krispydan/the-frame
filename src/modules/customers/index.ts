import type { ModuleDefinition } from "@/modules/shared/types";

export const customersModule: ModuleDefinition = {
  name: "customers",
  label: "Customers",
  description: "Customer success and health",
  routes: [{ path: "/customers", label: "Customers", icon: "👥" }],
  schema: [],
  mcpTools: ["customers.list_accounts", "customers.get_account", "customers.get_health", "customers.get_reorder_predictions", "customers.update_tier"],
  eventHooks: {},
};
