"use client";

import { useState } from "react";
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
  Building,
  Megaphone,
  BarChart3,
  Bell,
  User,
  Database,
  Search,
  ChevronRight,
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

type NavItem = {
  title: string;
  href: string;
  icon: typeof LayoutDashboard;
  badge?: string;
  children?: Array<{ title: string; href: string; icon: typeof LayoutDashboard }>;
};

const salesNav: NavItem[] = [
  { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  {
    title: "Prospects", href: "/prospects", icon: Users,
    children: [
      { title: "Review Queue", href: "/prospects/review", icon: Search },
      { title: "Lead Sources", href: "/prospects/sources", icon: Database },
      { title: "Brand Accounts", href: "/brands", icon: Building },
    ],
  },
  { title: "Pipeline", href: "/pipeline", icon: Kanban },
  { title: "Campaigns", href: "/campaigns", icon: Mail },
  { title: "Inbox", href: "/campaigns/inbox", icon: Inbox },
  { title: "Customers", href: "/customers", icon: HeartHandshake },
];

const operationsNav: NavItem[] = [
  { title: "Orders", href: "/orders", icon: ShoppingCart },
  { title: "Catalog", href: "/catalog", icon: Package },
  { title: "Inventory", href: "/inventory", icon: Warehouse },
  { title: "Finance", href: "/finance", icon: DollarSign },
];

const insightsNav: NavItem[] = [
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
  sales_manager: ["/dashboard", "/prospects", "/prospects/review", "/prospects/sources", "/pipeline", "/campaigns", "/campaigns/inbox", "/customers", "/brands"],
  warehouse: ["/dashboard", "/orders", "/catalog", "/inventory"],
  finance: ["/dashboard", "/orders", "/finance"],
  marketing: ["/dashboard", "/marketing", "/catalog", "/campaigns"],
  support: ["/dashboard", "/orders", "/customers"],
  ai: ["/dashboard", "/ai"],
};

function filterNavByRole(
  items: NavItem[],
  role: string
): NavItem[] {
  const allowed = ROLE_ALLOWED_HREFS[role];
  if (!allowed) return [];
  if (allowed.includes("*")) return items;
  return items
    .filter((item) => allowed.includes(item.href) || item.children?.some((c) => allowed.includes(c.href)))
    .map((item) => ({
      ...item,
      children: item.children?.filter((c) => allowed.includes(c.href)),
    }));
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

  const prospectsExpanded = pathname.startsWith("/prospects") || pathname.startsWith("/brands");
  const [prospectsOpen, setProspectsOpen] = useState(prospectsExpanded);

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
              {filteredSales.map((item) =>
                item.children && item.children.length > 0 ? (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      render={<Link href={item.href} onClick={() => setOpenMobile(false)} />}
                      isActive={pathname === item.href}
                      tooltip={item.title}
                    >
                      <item.icon />
                      <span>{item.title}</span>
                    </SidebarMenuButton>
                    <button
                      onClick={() => setProspectsOpen(!prospectsOpen)}
                      className="absolute right-1 top-1.5 flex h-5 w-5 items-center justify-center rounded-md hover:bg-sidebar-accent"
                    >
                      <ChevronRight className={`h-3.5 w-3.5 transition-transform ${prospectsOpen ? "rotate-90" : ""}`} />
                    </button>
                    {prospectsOpen && (
                      <SidebarMenuSub>
                        {item.children.map((child) => (
                          <SidebarMenuSubItem key={child.href}>
                            <SidebarMenuSubButton
                              render={<Link href={child.href} onClick={() => setOpenMobile(false)} />}
                              isActive={pathname === child.href || pathname.startsWith(child.href)}
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
                ) : (
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
                )
              )}
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
