import type { ModuleDefinition } from "@/modules/shared/types";

export const salesModule: ModuleDefinition = {
  name: "sales",
  label: "Sales",
  description: "Prospect management and CRM pipeline",
  routes: [{ path: "/sales", label: "Sales", icon: "💼" }, { path: "/sales/prospects", label: "Prospects" }, { path: "/sales/pipeline", label: "Pipeline" }, { path: "/sales/campaigns", label: "Campaigns" }],
  schema: [],
  mcpTools: [],
  eventHooks: {},
};
