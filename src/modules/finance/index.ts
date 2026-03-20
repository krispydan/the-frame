import type { ModuleDefinition } from "@/modules/shared/types";

export const financeModule: ModuleDefinition = {
  name: "finance",
  label: "Finance",
  description: "Settlements, P&L, and cash flow",
  routes: [{ path: "/finance", label: "Finance", icon: "💰" }, { path: "/finance/pnl", label: "P&L" }, { path: "/finance/cashflow", label: "Cash Flow" }],
  schema: [],
  mcpTools: [],
  eventHooks: {},
};
