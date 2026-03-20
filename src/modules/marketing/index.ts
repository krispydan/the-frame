import type { ModuleDefinition } from "@/modules/shared/types";

export const marketingModule: ModuleDefinition = {
  name: "marketing",
  label: "Marketing",
  description: "Content, social, SEO, and ads",
  routes: [{ path: "/marketing", label: "Marketing", icon: "📣" }, { path: "/marketing/calendar", label: "Calendar" }],
  schema: [],
  mcpTools: [],
  eventHooks: {},
};
