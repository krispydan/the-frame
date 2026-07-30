"use client";

import { usePathname, useRouter } from "next/navigation";
import { Fragment, useEffect, useState } from "react";
import { Bell, Search } from "lucide-react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useBreadcrumbOverride } from "@/components/layout/breadcrumb-context";

/** Friendly labels for path segments (top-level modules + nested pages). */
const SEGMENT_LABELS: Record<string, string> = {
  dashboard: "Dashboard",
  prospects: "Prospects",
  pipeline: "Pipeline",
  campaigns: "Campaigns",
  customers: "Customers",
  orders: "Orders",
  catalog: "Catalog",
  inventory: "Inventory",
  finance: "Finance",
  marketing: "Marketing",
  intelligence: "Intelligence",
  ai: "AI Center",
  notifications: "Notifications",
  settings: "Settings",
  profile: "Profile",
  // Marketing sub-pages
  videos: "Videos",
  clips: "Clips",
  recipes: "Recipes",
  posts: "Posts",
  identify: "Identify products",
  calendar: "Calendar",
  email: "Email",
  prompts: "Prompts",
  "designer-queue": "Designer queue",
  plan: "Plan",
  sounds: "Trending audio",
  // Operations sub-pages. Without these, titleize() produced things like
  // "Cogs" and "Purchase Orders" that didn't match the sidebar labels — the
  // breadcrumb and the menu naming the same page differently is exactly what
  // makes navigation feel untrustworthy.
  international: "International",
  intake: "Product intake",
  export: "Catalog export",
  reorder: "Reorder plan",
  "purchase-orders": "Purchase orders",
  factories: "Factories & lead times",
  performance: "Product performance",
  colors: "Color performance",
  exports: "Warehouse exports",
  cogs: "COGS & costing",
  xero: "Xero",
  media: "Media center",
  targets: "Targets",
  segments: "Segments",
  brands: "Brand accounts",
  review: "Review queue",
  sources: "Lead sources",
  "facebook-leads": "Facebook leads",
  outreach: "Outreach",
  cron: "Scheduled jobs",
  integrations: "Integrations",
};

/**
 * The section each top-level route belongs to, mirroring the sidebar groups.
 *
 * Sidebar groups aren't route segments, so there's no path to link to — but
 * showing the group name orients you ("Inventory" alone doesn't say whether
 * you're in Sales or Operations). Rendered as plain text, not a link, because
 * inventing a /operations URL that 404s would be worse than no crumb.
 */
const SEGMENT_SECTION: Record<string, string> = {
  orders: "Operations",
  catalog: "Operations",
  inventory: "Operations",
  media: "Operations",
  finance: "Operations",
  prospects: "Sales",
  segments: "Sales",
  brands: "Sales",
  campaigns: "Sales",
  pipeline: "Sales",
  customers: "Sales",
  targets: "Sales",
  marketing: "Insights",
  intelligence: "Insights",
  ai: "Insights",
  notifications: "Insights",
};

/**
 * Some path segments aren't navigable on their own (no index route) — map
 * them to the nearest real page so the breadcrumb link doesn't 404.
 */
const SEGMENT_HREF: Record<string, string> = {
  "/marketing/videos/posts": "/marketing/videos",
};

/** A raw id (uuid / long hex) segment — friendlier than showing the id. */
const IDISH = /^[0-9a-f]{8}-[0-9a-f]{4}|^[0-9a-f]{12,}$/i;

function titleize(seg: string) {
  return seg.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function AppHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const [unreadCount, setUnreadCount] = useState(0);
  const { override } = useBreadcrumbOverride();
  const segments = pathname.split("/").filter(Boolean);
  const section = segments.length > 0 ? SEGMENT_SECTION[segments[0]] : undefined;

  useEffect(() => {
    const fetchCount = () => {
      fetch("/api/v1/notifications/count")
        .then(r => r.ok ? r.json() : { unread: 0 })
        .then(d => setUnreadCount(d.unread))
        .catch(() => {});
    };
    fetchCount();
    const interval = setInterval(fetchCount, 30000);
    return () => clearInterval(interval);
  }, []);

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 !h-4" />

      <Breadcrumb className="flex-1">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/dashboard">Home</BreadcrumbLink>
          </BreadcrumbItem>
          {section && (
            <Fragment>
              <BreadcrumbSeparator />
              <BreadcrumbItem className="hidden sm:block">
                <span className="text-muted-foreground">{section}</span>
              </BreadcrumbItem>
            </Fragment>
          )}
          {segments.map((seg, i) => {
            const isLast = i === segments.length - 1;
            const path = `/${segments.slice(0, i + 1).join("/")}`;
            const href = SEGMENT_HREF[path] ?? path;
            let label = SEGMENT_LABELS[seg] ?? titleize(seg);
            if (isLast && override) label = override;
            else if (IDISH.test(seg) && !SEGMENT_LABELS[seg]) label = "Details";
            return (
              <Fragment key={path}>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  {isLast ? (
                    <BreadcrumbPage>{label}</BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink href={href}>{label}</BreadcrumbLink>
                  )}
                </BreadcrumbItem>
              </Fragment>
            );
          })}
        </BreadcrumbList>
      </Breadcrumb>

      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" className="hidden md:flex gap-2 text-muted-foreground">
          <Search className="h-4 w-4" />
          <span className="text-xs">Search...</span>
          <kbd className="pointer-events-none ml-2 inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
            ⌘K
          </kbd>
        </Button>
        <Button variant="ghost" size="icon" className="relative" onClick={() => router.push("/notifications")}>
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </Button>
      </div>
    </header>
  );
}
