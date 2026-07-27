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
  | "targets"
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

/** Cards are grouped into these sections on the dashboard, in this order. */
export type CategoryId = "overview" | "sales" | "products" | "pipeline" | "marketing" | "customers" | "finance" | "activity";

export interface CategoryDef {
  id: CategoryId;
  title: string;
  /** One-line orientation shown under the section heading. */
  blurb: string;
  /** Where "see everything in this area" goes. */
  href?: string;
}

export const CATEGORIES: CategoryDef[] = [
  { id: "overview", title: "Overview", blurb: "The numbers that matter right now" },
  { id: "sales", title: "Sales & revenue", blurb: "What sold, through which channel", href: "/orders" },
  { id: "products", title: "Products & inventory", blurb: "What's moving, what needs reordering", href: "/inventory/performance" },
  { id: "pipeline", title: "Pipeline & leads", blurb: "Deals in flight and where they came from", href: "/pipeline" },
  { id: "marketing", title: "Marketing & outreach", blurb: "Calls, email and ads working the top of funnel", href: "/marketing/outreach" },
  { id: "customers", title: "Customers", blurb: "Who's healthy, who's slipping away", href: "/customers" },
  { id: "finance", title: "Finance", blurb: "Margin, COGS and overall business health", href: "/finance" },
  { id: "activity", title: "Activity", blurb: "What just happened across the frame", href: "/notifications" },
];

export interface WidgetDef {
  id: WidgetId;
  title: string;
  subtitle?: string;
  /** Which dashboard section this card belongs to. */
  category: CategoryId;
  /** Roles allowed to see this widget. "owner" is implicitly allowed everywhere. */
  roles: Role[];
  size: WidgetSize;
  /** Deep link to the page that shows this data in full. */
  href?: string;
  /** Label for the deep link ("View" by default). */
  linkLabel?: string;
}

export const WIDGETS: Record<WidgetId, WidgetDef> = {
  kpis: { id: "kpis", title: "Key metrics", category: "overview", roles: ["owner", "sales_manager", "warehouse", "finance", "marketing", "support"], size: "full" },
  targets: { id: "targets", title: "Targets", subtitle: "this month vs plan", category: "overview", roles: ["owner", "sales_manager", "finance", "marketing"], size: "lg", href: "/targets", linkLabel: "All targets" },

  "revenue-trend": { id: "revenue-trend", title: "Revenue trend", category: "sales", roles: ["owner", "sales_manager", "finance", "marketing"], size: "lg", href: "/finance", linkLabel: "Finance" },
  "channel-mix": { id: "channel-mix", title: "Sales by channel", category: "sales", roles: ["owner", "sales_manager", "finance"], size: "md", href: "/orders", linkLabel: "Orders" },

  "top-sellers": { id: "top-sellers", title: "Top sellers", subtitle: "wholesale vs retail", category: "products", roles: ["owner", "sales_manager", "warehouse", "marketing"], size: "md", href: "/inventory/performance", linkLabel: "All products" },
  movers: { id: "movers", title: "Rising & falling", subtitle: "vs prior half-period", category: "products", roles: ["owner", "sales_manager", "warehouse", "marketing"], size: "md", href: "/inventory/performance", linkLabel: "All products" },
  "inventory-health": { id: "inventory-health", title: "Inventory health", category: "products", roles: ["owner", "warehouse"], size: "md", href: "/inventory", linkLabel: "Stock" },
  "reorder-alerts": { id: "reorder-alerts", title: "Reorder now", subtitle: "critical & urgent", category: "products", roles: ["owner", "warehouse"], size: "md", href: "/inventory/reorder", linkLabel: "Reorder plan" },

  pipeline: { id: "pipeline", title: "Pipeline", category: "pipeline", roles: ["owner", "sales_manager"], size: "lg", href: "/pipeline", linkLabel: "Pipeline" },
  "meta-leads": { id: "meta-leads", title: "Facebook / Instagram leads", category: "pipeline", roles: ["owner", "marketing", "sales_manager"], size: "md", href: "/prospects/facebook-leads", linkLabel: "All leads" },

  outreach: { id: "outreach", title: "Outreach performance", category: "marketing", roles: ["owner", "sales_manager", "marketing"], size: "md", href: "/marketing/outreach", linkLabel: "Outreach" },

  customers: { id: "customers", title: "Customer health", category: "customers", roles: ["owner", "sales_manager", "finance"], size: "md", href: "/customers", linkLabel: "Customers" },

  finance: { id: "finance", title: "Finance snapshot", subtitle: "month to date", category: "finance", roles: ["owner", "finance"], size: "md", href: "/finance", linkLabel: "P&L" },
  "business-health": { id: "business-health", title: "Business health", category: "finance", roles: ["owner", "finance"], size: "md", href: "/intelligence", linkLabel: "Intelligence" },

  activity: { id: "activity", title: "Recent activity", category: "activity", roles: ["owner", "sales_manager", "warehouse", "finance", "marketing", "support"], size: "md", href: "/notifications", linkLabel: "All activity" },
};

export const ALL_WIDGET_IDS = Object.keys(WIDGETS) as WidgetId[];

/** Default ordered layout per role. Users customize from here. */
export const ROLE_DEFAULT_LAYOUT: Record<Role, WidgetId[]> = {
  owner: ["kpis", "targets", "revenue-trend", "channel-mix", "pipeline", "top-sellers", "movers", "outreach", "inventory-health", "reorder-alerts", "customers", "finance", "business-health", "meta-leads", "activity"],
  sales_manager: ["kpis", "targets", "revenue-trend", "pipeline", "channel-mix", "top-sellers", "movers", "outreach", "meta-leads", "customers", "activity"],
  warehouse: ["kpis", "inventory-health", "reorder-alerts", "top-sellers", "movers", "activity"],
  finance: ["kpis", "targets", "finance", "revenue-trend", "channel-mix", "business-health", "customers", "activity"],
  marketing: ["kpis", "targets", "outreach", "meta-leads", "revenue-trend", "top-sellers", "movers", "activity"],
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

/**
 * Group an ordered layout into category sections, preserving the user's
 * within-section order and dropping empty sections. Sections themselves render
 * in CATEGORIES order so the page always reads Overview → Sales → Products →
 * Pipeline → Marketing → Customers → Finance → Activity.
 */
export function groupByCategory(layout: WidgetId[]): Array<{ category: CategoryDef; widgets: WidgetId[] }> {
  const byCat = new Map<CategoryId, WidgetId[]>();
  for (const id of layout) {
    const def = WIDGETS[id];
    if (!def) continue;
    const list = byCat.get(def.category) ?? [];
    list.push(id);
    byCat.set(def.category, list);
  }
  return CATEGORIES.filter((c) => (byCat.get(c.id)?.length ?? 0) > 0).map((category) => ({
    category,
    widgets: byCat.get(category.id)!,
  }));
}

export const SIZE_CLASS: Record<WidgetSize, string> = {
  sm: "md:col-span-1",
  md: "md:col-span-1",
  lg: "md:col-span-2",
  full: "md:col-span-2 xl:col-span-3",
};
