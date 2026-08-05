"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Users,
  Layers3,
  Mail,
  ShoppingCart,
  Package,
  Warehouse,
  DollarSign,
  Brain,
  Settings,
  LogOut,
  ChevronsUpDown,
  HeartHandshake,
  MapPin,
  Building,
  Megaphone,
  Kanban,
  Truck,
  Target,
  BarChart3,
  Factory,
  Palette,
  Bell,
  User,
  Database,
  Search,
  ChevronRight,
  ImageIcon,
  Layers,
  Plug,
  ShoppingBag,
  Globe,
  Inbox,
  FileDown,
  Boxes,
  ClipboardList,
  FileSpreadsheet,
  Landmark,
  TrendingUp,
  Send,
  Sparkles,
  LayoutList,
  CalendarDays,
  Paintbrush,
  MessageSquare,
  Clapperboard,
  Film,
  PackageSearch,
  PhoneCall,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuBadge,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarMenuSubButton,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { useUser } from "@/hooks/use-user";

type NavChild = { title: string; href: string; icon: typeof LayoutDashboard };
type NavItem = {
  title: string;
  href: string;
  icon: typeof LayoutDashboard;
  badge?: string;
  children?: NavChild[];
  /**
   * Extra path prefixes that belong to this item but don't start with its href
   * (e.g. Segments and Brand Accounts live under Prospects). Used for
   * active-state and auto-expansion so navigating to a child still highlights
   * and opens its parent.
   */
  owns?: string[];
};

/* ─────────────────────────────────────────────────────────────────────────
 * MENU LAYOUT CONVENTION — follow this for every new nav section
 * ─────────────────────────────────────────────────────────────────────────
 * A top-level item is either:
 *   (a) a LEAF — a single route, no `children`:
 *         { title: "Pipeline", href: "/pipeline", icon: Kanban }
 *   (b) a SECTION — a parent with a `children` dropdown.
 *
 * Rules for a SECTION (keep every section consistent):
 *   1. The FIRST child MUST be the parent's own landing route (same `href`
 *      as the parent), given a DESCRIPTIVE label — not "Overview". Examples:
 *        Orders    → "All orders"     (/orders)
 *        Catalog   → "All products"   (/catalog)
 *        Inventory → "Stock on hand"  (/inventory)
 *        Finance   → "P&L"            (/finance)
 *        Customers → "All customers"  (/customers)
 *      This guarantees the section index is always reachable from the
 *      dropdown and never hidden behind the expand toggle.
 *   2. Remaining children are the section's sub-pages, ordered most-used first.
 *   3. Every child.href must be a REAL route (a page.tsx exists for it).
 *   4. If a child's route doesn't start with the parent's href (e.g. Segments
 *      under Prospects), add that prefix to the parent's `owns` array so
 *      active-state highlighting and auto-expand still work.
 *   5. Add every child.href to ROLE_ALLOWED_HREFS for each role allowed to see
 *      it (the parent href alone is not enough to reveal children).
 *   6. Prefer a distinct lucide icon per child; the "All X" first child may
 *      reuse the parent's icon.
 * ───────────────────────────────────────────────────────────────────────── */

const salesNav: NavItem[] = [
  { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { title: "Targets", href: "/targets", icon: Target },
  {
    title: "Prospects", href: "/prospects", icon: Users,
    owns: ["/segments", "/brands"],
    children: [
      { title: "All prospects", href: "/prospects", icon: Users },
      { title: "Review queue", href: "/prospects/review", icon: Search },
      { title: "Facebook leads", href: "/prospects/facebook-leads", icon: Megaphone },
      { title: "Lead sources", href: "/prospects/sources", icon: Database },
      { title: "Segments", href: "/segments", icon: Layers3 },
      { title: "Brand accounts", href: "/brands", icon: Building },
    ],
  },
  { title: "Pipeline", href: "/pipeline", icon: Kanban },
  {
    title: "Customers", href: "/customers", icon: HeartHandshake,
    owns: ["/customers/analytics"],
    children: [
      { title: "All customers", href: "/customers", icon: HeartHandshake },
      { title: "Analytics & Map", href: "/customers/analytics", icon: MapPin },
    ],
  },
];

/**
 * Operations, grouped by the thing being managed rather than as a flat list.
 *
 * It used to be twelve siblings with no hierarchy — six of them children of
 * /inventory shown alongside their own parent — which made the section
 * unscannable and gave no sense of where you were. Now each area is one entry
 * that expands to its own pages, so the list is five items at rest and the
 * current section is self-evident.
 *
 * Every child is a real route. Three pages that existed but were unreachable
 * from the sidebar (catalog intake, catalog export, Xero) are now linked.
 */
const operationsNav: NavItem[] = [
  {
    title: "Orders", href: "/orders", icon: ShoppingCart,
    children: [
      { title: "All orders", href: "/orders", icon: ShoppingCart },
      { title: "International", href: "/orders/international", icon: Globe },
    ],
  },
  {
    // "Media Center" sat as its own top-level Operations entry and read as a
    // sibling of the Video Remix Studio, which it isn't: it edits
    // catalog/images — product photography — while the video studio produces
    // social content from clips. Naming it "Product images" and nesting it
    // under Catalog puts it with the data it actually manages and removes the
    // overlap.
    title: "Catalog", href: "/catalog", icon: Package,
    owns: ["/media"],
    children: [
      { title: "All products", href: "/catalog", icon: Package },
      { title: "Product images", href: "/media", icon: ImageIcon },
      { title: "Product intake", href: "/catalog/intake", icon: Inbox },
      { title: "Catalog export", href: "/catalog/export", icon: FileDown },
    ],
  },
  {
    title: "Inventory", href: "/inventory", icon: Warehouse,
    children: [
      { title: "Stock on hand", href: "/inventory", icon: Boxes },
      { title: "Reorder plan", href: "/inventory/reorder", icon: Truck },
      { title: "Purchase orders", href: "/inventory/purchase-orders", icon: ClipboardList },
      { title: "Factories & lead times", href: "/inventory/factories", icon: Factory },
      { title: "Product performance", href: "/inventory/performance", icon: BarChart3 },
      { title: "Color performance", href: "/inventory/colors", icon: Palette },
      { title: "Warehouse exports", href: "/inventory/exports", icon: FileSpreadsheet },
    ],
  },
  {
    title: "Finance", href: "/finance", icon: DollarSign,
    children: [
      { title: "P&L", href: "/finance", icon: TrendingUp },
      { title: "COGS & costing", href: "/finance/cogs", icon: Layers },
      { title: "Amazon", href: "/finance/amazon", icon: ShoppingCart },
      { title: "3PL billing", href: "/finance/3pl", icon: Truck },
      { title: "Xero", href: "/finance/xero", icon: Landmark },
    ],
  },
];


/**
 * Marketing, which was scattered across three sidebar groups: Campaigns and
 * Outreach sat under Sales, the Marketing hub under Insights, and everything
 * below them — the whole email assistant, the entire video studio, both
 * calendars, the reply inbox — appeared nowhere at all. Eleven real pages were
 * unreachable except by typing the URL.
 *
 * Grouped by channel now, because that's how the work actually divides: cold
 * outreach to strangers, email marketing to people who know us, video for
 * social. The events calendar sits on its own — it feeds AI copy across all
 * three rather than belonging to any one.
 */
const marketingNav: NavItem[] = [
  { title: "Overview", href: "/marketing", icon: Megaphone },
  {
    title: "Cold outreach", href: "/campaigns", icon: Send,
    owns: ["/marketing/outreach", "/sales/outreach-roi"],
    children: [
      { title: "Campaigns", href: "/campaigns", icon: Send },
      { title: "Reply inbox", href: "/campaigns/inbox", icon: Inbox },
      { title: "Outreach analytics", href: "/marketing/outreach", icon: BarChart3 },
      { title: "Call ROI", href: "/sales/outreach-roi", icon: PhoneCall },
    ],
  },
  {
    title: "Email marketing", href: "/marketing/email", icon: Mail,
    children: [
      { title: "Email assistant", href: "/marketing/email", icon: Sparkles },
      { title: "Campaign plan", href: "/marketing/email/plan", icon: LayoutList },
      { title: "Send schedule", href: "/marketing/email/calendar", icon: CalendarDays },
      { title: "Designer queue", href: "/marketing/email/designer-queue", icon: Paintbrush },
      { title: "AI prompts", href: "/marketing/email/prompts", icon: MessageSquare },
    ],
  },
  {
    title: "Video studio", href: "/marketing/videos", icon: Clapperboard,
    children: [
      { title: "Post queue", href: "/marketing/videos", icon: Clapperboard },
      { title: "Clip library", href: "/marketing/videos/clips", icon: Film },
      { title: "Recipes", href: "/marketing/videos/recipes", icon: LayoutList },
      { title: "Identify products", href: "/marketing/videos/identify", icon: Search },
      { title: "Product coverage", href: "/marketing/videos/products", icon: PackageSearch },
    ],
  },
  { title: "Events calendar", href: "/marketing/calendar", icon: CalendarDays },
];

const insightsNav: NavItem[] = [
  { title: "Intelligence", href: "/intelligence", icon: BarChart3 },
  { title: "AI Center", href: "/ai", icon: Brain },
  { title: "Notifications", href: "/notifications", icon: Bell },
  { title: "Scheduled Jobs", href: "/settings/cron", icon: Database },
  {
    title: "Integrations", href: "/settings/integrations", icon: Plug,
    children: [
      { title: "Shopify", href: "/settings/integrations/shopify", icon: ShoppingBag },
      { title: "Xero", href: "/settings/integrations/xero", icon: DollarSign },
      { title: "Slack", href: "/settings/integrations/slack", icon: Mail },
    ],
  },
];

const bottomNav = [
  { title: "Settings", href: "/settings", icon: Settings },
];

// ── Role-based navigation filtering ──

const ROLE_ALLOWED_HREFS: Record<string, string[]> = {
  owner: ["*"],
  sales_manager: ["/dashboard", "/targets", "/prospects", "/prospects/review", "/prospects/sources", "/prospects/facebook-leads", "/segments", "/campaigns", "/campaigns/inbox", "/marketing/outreach", "/pipeline", "/customers", "/customers/analytics", "/brands", "/catalog", "/inventory/performance", "/inventory/colors"],
  warehouse: ["/dashboard", "/orders", "/orders/international", "/catalog", "/catalog/intake", "/media", "/inventory", "/inventory/performance", "/inventory/colors", "/inventory/factories", "/inventory/reorder", "/inventory/purchase-orders", "/inventory/exports"],
  finance: ["/dashboard", "/orders", "/finance", "/finance/cogs", "/finance/amazon", "/finance/3pl", "/finance/xero", "/sales/outreach-roi", "/inventory/performance", "/inventory/colors", "/inventory/factories"],
  marketing: ["/dashboard", "/marketing", "/marketing/outreach", "/marketing/email", "/marketing/email/plan", "/marketing/email/calendar", "/marketing/email/designer-queue", "/marketing/email/prompts", "/marketing/videos", "/marketing/videos/clips", "/marketing/videos/recipes", "/marketing/videos/identify", "/marketing/videos/products", "/marketing/calendar", "/catalog", "/catalog/export", "/media", "/campaigns", "/campaigns/inbox", "/prospects/facebook-leads", "/inventory/performance", "/inventory/colors"],
  support: ["/dashboard", "/orders", "/customers", "/customers/analytics"],
  ai: ["/dashboard", "/ai"],
};

/**
 * Drop anything a role can't reach, and repoint a parent whose own index page
 * is off-limits at its first allowed child.
 *
 * Without that last step a role like finance — allowed /inventory/performance
 * but not /inventory itself — would get an "Inventory" entry linking to a page
 * that bounces them, which reads as a broken app rather than a permission.
 */
function filterNavByRole(items: NavItem[], role: string): NavItem[] {
  const allowed = ROLE_ALLOWED_HREFS[role];
  if (!allowed) return [];
  if (allowed.includes("*")) return items;

  const out: NavItem[] = [];
  for (const item of items) {
    const parentAllowed = allowed.includes(item.href);
    const children = item.children?.filter((c) => allowed.includes(c.href));
    if (!parentAllowed && !children?.length) continue;
    out.push({
      ...item,
      href: parentAllowed ? item.href : children![0].href,
      children,
    });
  }
  return out;
}

/** Does the current path belong to this item (its href, a child, or an owned prefix)? */
function isInSection(pathname: string, item: NavItem): boolean {
  const under = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  if (item.href !== "/dashboard" && under(item.href)) return true;
  if (item.owns?.some(under)) return true;
  return !!item.children?.some((c) => under(c.href));
}

/**
 * A child is active on an exact match, or on a deeper path that no *other*
 * sibling claims more specifically. That keeps "Stock on hand" (/inventory)
 * from lighting up while you're on /inventory/reorder, without needing the
 * per-route exclusion list this used to carry.
 */
function isChildActive(pathname: string, child: NavChild, siblings: NavChild[]): boolean {
  if (pathname === child.href) return true;
  if (!pathname.startsWith(`${child.href}/`)) return false;
  return !siblings.some(
    (s) => s.href !== child.href && s.href.length > child.href.length && pathname.startsWith(s.href),
  );
}

export function AppSidebar() {
  const pathname = usePathname();
  const { user } = useUser();
  const { setOpenMobile } = useSidebar();
  const role = user?.role || "support";
  const initials = user?.name
    ?.split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase() || "?";

  const filteredSales = filterNavByRole(salesNav, role);
  const filteredOps = filterNavByRole(operationsNav, role);
  const filteredMarketing = filterNavByRole(marketingNav, role);
  const filteredInsights = filterNavByRole(insightsNav, role);

  // Sections auto-expand when you're inside them; a manual toggle overrides
  // that for the rest of the session. Derived rather than synced in an effect,
  // so navigation opens the right section without a render-then-correct flash.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const isOpen = (item: NavItem) => toggled[item.href] ?? isInSection(pathname, item);
  const toggle = (item: NavItem) =>
    setToggled((prev) => ({ ...prev, [item.href]: !(prev[item.href] ?? isInSection(pathname, item)) }));

  /** One renderer for every group — the hierarchy used to exist only in Sales. */
  const renderItems = (items: NavItem[]) =>
    items.map((item) => {
      const inSection = isInSection(pathname, item);
      const open = isOpen(item);
      const hasChildren = !!item.children?.length;
      return (
        <SidebarMenuItem key={item.href}>
          <SidebarMenuButton
            render={<Link href={item.href} onClick={() => setOpenMobile(false)} />}
            // A parent stays highlighted anywhere in its subtree, so you can
            // always see which area you're in — even on a detail page that
            // matches no menu entry.
            isActive={pathname === item.href || inSection}
            tooltip={item.title}
          >
            <item.icon />
            <span>{item.title}</span>
          </SidebarMenuButton>

          {hasChildren && (
            <button
              onClick={() => toggle(item)}
              aria-label={`${open ? "Collapse" : "Expand"} ${item.title}`}
              aria-expanded={open}
              className="absolute right-1 top-1.5 flex h-5 w-5 items-center justify-center rounded-md hover:bg-sidebar-accent group-data-[collapsible=icon]:hidden"
            >
              <ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
            </button>
          )}

          {item.badge && (
            <SidebarMenuBadge>
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{item.badge}</Badge>
            </SidebarMenuBadge>
          )}

          {hasChildren && open && (
            <SidebarMenuSub>
              {item.children!.map((child) => (
                <SidebarMenuSubItem key={child.href}>
                  <SidebarMenuSubButton
                    render={<Link href={child.href} onClick={() => setOpenMobile(false)} />}
                    isActive={isChildActive(pathname, child, item.children!)}
                    size="sm"
                  >
                    <child.icon className="h-3.5 w-3.5" />
                    <span>{child.title}</span>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              ))}
            </SidebarMenuSub>
          )}
        </SidebarMenuItem>
      );
    });


  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              render={<Link href="/dashboard" onClick={() => setOpenMobile(false)} />}
            >
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold text-sm">
                TF
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">The Frame</span>
                <span className="truncate text-xs text-muted-foreground">
                  Wholesale CRM
                </span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Sales</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>{renderItems(filteredSales)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Operations</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>{renderItems(filteredOps)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {filteredMarketing.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>Marketing</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>{renderItems(filteredMarketing)}</SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        <SidebarGroup>
          <SidebarGroupLabel>Insights</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>{renderItems(filteredInsights)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="mt-auto">
          <SidebarGroupContent>
            <SidebarMenu>
              {bottomNav.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    render={<Link href={item.href} onClick={() => setOpenMobile(false)} />}
                    isActive={pathname.startsWith(item.href)}
                    tooltip={item.title}
                  >
                    <item.icon />
                    <span>{item.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger className="w-full">
                <div className="flex items-center gap-2 rounded-md p-2 text-left text-sm hover:bg-sidebar-accent hover:text-sidebar-accent-foreground">
                  <Avatar className="h-8 w-8 rounded-lg">
                    <AvatarFallback className="rounded-lg text-xs">
                      {initials}
                    </AvatarFallback>
                  </Avatar>
                  <div className="grid flex-1 leading-tight">
                    <span className="truncate font-semibold">
                      {user?.name || "User"}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {role}
                    </span>
                  </div>
                  <ChevronsUpDown className="ml-auto size-4" />
                </div>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg"
                side="bottom"
                align="end"
                sideOffset={4}
              >
                <DropdownMenuItem onClick={() => window.location.href = "/profile"}>
                  <User className="mr-2 h-4 w-4" />
                  Profile
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => window.location.href = "/settings"}>
                  <Settings className="mr-2 h-4 w-4" />
                  Settings
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={async () => {
                    await fetch("/api/v1/auth/logout", { method: "POST" });
                    window.location.href = "/login";
                  }}
                >
                  <LogOut className="mr-2 h-4 w-4" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
