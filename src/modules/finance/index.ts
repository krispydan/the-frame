import type { ModuleDefinition } from "@/modules/shared/types";

export const financeModule: ModuleDefinition = {
  name: "finance",
  label: "Finance",
  description: "Settlements, P&L, expenses, and cash flow",
  routes: [
    { path: "/finance", label: "Finance", icon: "💰" },
    { path: "/finance?tab=settlements", label: "Settlements" },
    { path: "/finance?tab=expenses", label: "Expenses" },
    { path: "/finance?tab=cashflow", label: "Cash Flow" },
  ],
  schema: [],
  mcpTools: [],
  eventHooks: {},
};
