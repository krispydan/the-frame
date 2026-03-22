"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
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

const moduleTitles: Record<string, string> = {
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
};

export function AppHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const [unreadCount, setUnreadCount] = useState(0);
  const { override } = useBreadcrumbOverride();
  const segments = pathname.split("/").filter(Boolean);
  const currentModule = segments[0] || "dashboard";
  const title = moduleTitles[currentModule] || currentModule;

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
          {segments.length > 0 && (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                {segments.length === 1 ? (
                  <BreadcrumbPage>{title}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink href={`/${currentModule}`}>
                    {title}
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {segments.length > 1 && (
                <>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbPage>
                      {override || segments[segments.length - 1]}
                    </BreadcrumbPage>
                  </BreadcrumbItem>
                </>
              )}
            </>
          )}
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
