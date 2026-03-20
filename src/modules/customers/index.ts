import type { ModuleDefinition } from "@/modules/shared/types";

export const customersModule: ModuleDefinition = {
  name: "customers",
  label: "Customers",
  description: "Customer success and health",
  routes: [{ path: "/customers", label: "Customers", icon: "👥" }],
  schema: [],
  mcpTools: [],
  eventHooks: {},
};
