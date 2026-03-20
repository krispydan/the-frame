import type { ModuleDefinition } from "@/modules/shared/types";

export const intelligenceModule: ModuleDefinition = {
  name: "intelligence",
  label: "Intelligence",
  description: "Analytics, trends, and reports",
  routes: [{ path: "/intelligence", label: "Intelligence", icon: "🧠" }, { path: "/intelligence/analytics", label: "Analytics" }],
  schema: [],
  mcpTools: [],
  eventHooks: {},
};
