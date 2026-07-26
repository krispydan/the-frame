/**
 * Dashboard widget registry — the single source of truth shared by the metrics
 * API (which computes only the datasets a role may see) and the client page
 * (which renders + lets users reorder/hide widgets).
 *
 * Each widget declares the roles allowed to see it and a grid size. Role
 * default layouts below decide what a fresh user of each role lands on; users
 * can then customize (persisted per user), but never beyond what their role
 * allows — the API enforces that server-side.
 */

export type Role = "owner" | "sales_manager" | "warehouse" | "finance" | "marketing" | "support" | "ai";

export type WidgetId =
  | "kpis"
  | "revenue-trend"
  | "channel-mix"
  | "top-sellers"
  | "movers"
  | "inventory-health"
  | "reorder-alerts"
  | "outreach"
  | "meta-leads"
  | "pipeline"
  | "customers"
  | "finance"
  | "business-health"
  | "activity";

export type WidgetSize = "sm" | "md" | "lg" | "full";

export interface WidgetDef {
  id: WidgetId;
  title: string;
  subtitle?: string;
  domain: "sales" | "inventory" | "marketing" | "pipeline" | "customers" | "finance" | "ops";
  /** Roles allowed to see this widget. "owner" is implicitly allowed everywhere. */
  roles: Role[];
  size: WidgetSize;
  /** Deep link to the full page for this domain. */
  href?: string;
}

export const WIDGETS: Record<WidgetId, WidgetDef> = {
  kpis: { id: "kpis", title: "Key metrics", domain: "sales", roles: ["owner", "sales_manager", "warehouse", "finance", "marketing", "support"], size: "full" },
  "revenue-trend": { id: "revenue-trend", title: "Revenue trend", domain: "sales", roles: ["owner", "sales_manager", "finance", "marketing"], size: "lg", href: "/finance" },
  "channel-mix": { id: "channel-mix", title: "Sales by channel", domain: "sales", roles: ["owner", "sales_manager", "finance"], size: "md", href: "/orders" },
  "top-sellers": { id: "top-sellers", title: "Top sellers", subtitle: "wholesale vs retail", domain: "sales", roles: ["owner", "sales_manager", "warehouse", "marketing"], size: "md", href: "/inventory/performance" },
  movers: { id: "movers", title: "Rising & falling", subtitle: "vs prior half-period", domain: "sales", roles: ["owner", "sales_manager", "warehouse", "marketing"], size: "md", href: "/inventory/performance" },
  "inventory-health": { id: "inventory-health", title: "Inventory health", domain: "inventory", roles: ["owner", "warehouse"], size: "md", href: "/inventory" },
  "reorder-alerts": { id: "reorder-alerts", title: "Reorder now", subtitle: "critical & urgent", domain: "inventory", roles: ["owner", "warehouse"], size: "md", href: "/inventory" },
  outreach: { id: "outreach", title: "Outreach performance", domain: "marketing", roles: ["owner", "sales_manager", "marketing"], size: "md", href: "/campaigns" },
  "meta-leads": { id: "meta-leads", title: "Facebook / Instagram leads", domain: "marketing", roles: ["owner", "marketing", "sales_manager"], size: "md", href: "/prospects" },
  pipeline: { id: "pipeline", title: "Pipeline", domain: "pipeline", roles: ["owner", "sales_manager"], size: "lg", href: "/prospects" },
  customers: { id: "customers", title: "Customer health", domain: "customers", roles: ["owner", "sales_manager", "finance"], size: "md", href: "/customers" },
  finance: { id: "finance", title: "Finance snapshot", subtitle: "month to date", domain: "finance", roles: ["owner", "finance"], size: "md", href: "/finance" },
  "business-health": { id: "business-health", title: "Business health", domain: "finance", roles: ["owner", "finance"], size: "md", href: "/intelligence" },
  activity: { id: "activity", title: "Recent activity", domain: "ops", roles: ["owner", "sales_manager", "warehouse", "finance", "marketing", "support"], size: "md", href: "/notifications" },
};

export const ALL_WIDGET_IDS = Object.keys(WIDGETS) as WidgetId[];

/** Default ordered layout per role. Users customize from here. */
export const ROLE_DEFAULT_LAYOUT: Record<Role, WidgetId[]> = {
  owner: ["kpis", "revenue-trend", "channel-mix", "pipeline", "top-sellers", "movers", "outreach", "inventory-health", "reorder-alerts", "customers", "finance", "business-health", "meta-leads", "activity"],
  sales_manager: ["kpis", "revenue-trend", "pipeline", "channel-mix", "top-sellers", "movers", "outreach", "meta-leads", "customers", "activity"],
  warehouse: ["kpis", "inventory-health", "reorder-alerts", "top-sellers", "movers", "activity"],
  finance: ["kpis", "finance", "revenue-trend", "channel-mix", "business-health", "customers", "activity"],
  marketing: ["kpis", "outreach", "meta-leads", "revenue-trend", "top-sellers", "movers", "activity"],
  support: ["kpis", "activity"],
  ai: ["kpis"],
};

function normalizeRole(role: string): Role {
  return (["owner", "sales_manager", "warehouse", "finance", "marketing", "support", "ai"] as string[]).includes(role)
    ? (role as Role)
    : "support";
}

/** Whether a role may see a widget (owner sees all). */
export function canSeeWidget(role: string, id: WidgetId): boolean {
  const r = normalizeRole(role);
  if (r === "owner") return true;
  return WIDGETS[id].roles.includes(r);
}

/** Widget ids a role is allowed to see, in registry order. */
export function allowedWidgetIds(role: string): WidgetId[] {
  return ALL_WIDGET_IDS.filter((id) => canSeeWidget(role, id));
}

/** The default layout for a role, filtered to what's allowed. */
export function defaultLayout(role: string): WidgetId[] {
  const r = normalizeRole(role);
  return (ROLE_DEFAULT_LAYOUT[r] ?? ROLE_DEFAULT_LAYOUT.support).filter((id) => canSeeWidget(r, id));
}

/** Sanitize a stored/user layout: keep only allowed ids, dedupe. */
export function sanitizeLayout(role: string, ids: string[]): WidgetId[] {
  const seen = new Set<string>();
  const out: WidgetId[] = [];
  for (const id of ids) {
    if (ALL_WIDGET_IDS.includes(id as WidgetId) && canSeeWidget(role, id as WidgetId) && !seen.has(id)) {
      seen.add(id);
      out.push(id as WidgetId);
    }
  }
  return out;
}

export const SIZE_CLASS: Record<WidgetSize, string> = {
  sm: "md:col-span-1",
  md: "md:col-span-1",
  lg: "md:col-span-2",
  full: "md:col-span-2 xl:col-span-3",
};
