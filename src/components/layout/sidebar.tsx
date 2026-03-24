"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Users,
  Kanban,
  Mail,
  Inbox,
  ShoppingCart,
  Package,
  Warehouse,
  DollarSign,
  Brain,
  Settings,
  LogOut,
  ChevronsUpDown,
  HeartHandshake,
  Megaphone,
  BarChart3,
  Bell,
  User,
  Database,
  Search,
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

const salesNav: Array<{ title: string; href: string; icon: typeof LayoutDashboard; badge?: string }> = [
  { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { title: "Prospects", href: "/prospects", icon: Users },
  { title: "Review Queue", href: "/prospects/review", icon: Search },
  { title: "Lead Sources", href: "/prospects/sources", icon: Database },
  { title: "Pipeline", href: "/pipeline", icon: Kanban },
  { title: "Campaigns", href: "/campaigns", icon: Mail },
  { title: "Inbox", href: "/campaigns/inbox", icon: Inbox },
  { title: "Customers", href: "/customers", icon: HeartHandshake },
];

const operationsNav: Array<{ title: string; href: string; icon: typeof LayoutDashboard; badge?: string }> = [
  { title: "Orders", href: "/orders", icon: ShoppingCart },
  { title: "Catalog", href: "/catalog", icon: Package },
  { title: "Inventory", href: "/inventory", icon: Warehouse },
  { title: "Finance", href: "/finance", icon: DollarSign },
];

const insightsNav: Array<{ title: string; href: string; icon: typeof LayoutDashboard; badge?: string }> = [
  { title: "Marketing", href: "/marketing", icon: Megaphone },
  { title: "Intelligence", href: "/intelligence", icon: BarChart3 },
  { title: "AI Center", href: "/ai", icon: Brain },
  { title: "Notifications", href: "/notifications", icon: Bell },
];

const bottomNav = [
  { title: "Settings", href: "/settings", icon: Settings },
];

// ── Role-based navigation filtering ──

const ROLE_ALLOWED_HREFS: Record<string, string[]> = {
  owner: ["*"],
  sales_manager: ["/dashboard", "/prospects", "/prospects/review", "/prospects/sources", "/pipeline", "/campaigns", "/campaigns/inbox", "/customers"],
  warehouse: ["/dashboard", "/orders", "/catalog", "/inventory"],
  finance: ["/dashboard", "/orders", "/finance"],
  marketing: ["/dashboard", "/marketing", "/catalog", "/campaigns"],
  support: ["/dashboard", "/orders", "/customers"],
  ai: ["/dashboard", "/ai"],
};

function filterNavByRole(
  items: typeof salesNav,
  role: string
): typeof salesNav {
  const allowed = ROLE_ALLOWED_HREFS[role];
  if (!allowed) return [];
  if (allowed.includes("*")) return items;
  return items.filter((item) => allowed.includes(item.href));
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
  const filteredInsights = filterNavByRole(insightsNav, role);

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
            <SidebarMenu>
              {filteredSales.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    render={<Link href={item.href} onClick={() => setOpenMobile(false)} />}
                    isActive={pathname === item.href || (item.href !== "/dashboard" && pathname.startsWith(item.href))}
                    tooltip={item.title}
                  >
                    <item.icon />
                    <span>{item.title}</span>
                  </SidebarMenuButton>
                  {item.badge && (
                    <SidebarMenuBadge>
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                        {item.badge}
                      </Badge>
                    </SidebarMenuBadge>
                  )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Operations</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {filteredOps.map((item) => (
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

        <SidebarGroup>
          <SidebarGroupLabel>Insights</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {filteredInsights.map((item) => (
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
