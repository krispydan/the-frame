import type { ModuleDefinition } from "@/modules/shared/types";

export const coreModule: ModuleDefinition = {
  name: "core",
  label: "Core",
  description: "System infrastructure",
  routes: [{ path: "/settings", label: "Settings", icon: "⚙️" }],
  schema: [],
  mcpTools: [],
  eventHooks: {},
};
