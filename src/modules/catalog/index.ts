import type { ModuleDefinition } from "@/modules/shared/types";

export const catalogModule: ModuleDefinition = {
  name: "catalog",
  label: "Catalog",
  description: "Product catalog and content management",
  routes: [{ path: "/catalog", label: "Catalog", icon: "👓" }, { path: "/catalog/products", label: "Products" }, { path: "/catalog/images", label: "Images" }],
  schema: [],
  mcpTools: [],
  eventHooks: {},
};
