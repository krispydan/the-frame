"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle, AlertCircle, Plug, ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type Shop = {
  id: string;
  shopDomain: string;
  displayName: string | null;
  channel: string;
  isActive: boolean;
  lastHealthStatus: string | null;
};

/**
 * Compact widget for the main /dashboard page.
 *
 * Shows each connected Shopify shop with a single-glance status badge.
 * Failures (auth_failed / error) get a critical-colored row so they're
 * impossible to miss next to the other dashboard stats.
 */
export function ShopifyStatusWidget() {
  const [shops, setShops] = useState<Shop[] | null>(null);

  useEffect(() => {
    fetch("/api/v1/integrations/shopify")
      .then((r) => r.json())
      .then((d) => setShops(d.shops || []))
      .catch(() => setShops([]));
  }, []);

  if (shops === null) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Plug className="h-4 w-4" />
            Shopify
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-12 animate-pulse bg-muted/40 rounded" />
        </CardContent>
      </Card>
    );
  }

  const active = shops.filter((s) => s.isActive);
  const failed = active.filter((s) => s.lastHealthStatus && s.lastHealthStatus !== "ok");

  return (
    <Card className={failed.length > 0 ? "border-red-300 dark:border-red-800" : undefined}>
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <CardTitle className="text-sm flex items-center gap-2">
          <Plug className="h-4 w-4" />
          Shopify
          {active.length > 0 && (
            <span className="text-muted-foreground font-normal">({active.length} connected)</span>
          )}
        </CardTitle>
        <Link href="/settings/integrations/shopify" className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center">
          Manage <ChevronRight className="h-3 w-3" />
        </Link>
      </CardHeader>
      <CardContent className="space-y-2">
        {active.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            No stores connected.{" "}
            <Link href="/settings/integrations/shopify" className="text-primary hover:underline">Connect one</Link>.
          </div>
        ) : (
          active.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="font-medium truncate">{s.displayName || s.shopDomain.replace(".myshopify.com", "")}</div>
                <div className="text-xs text-muted-foreground truncate">
                  {s.channel} · {s.shopDomain}
                </div>
              </div>
              {(() => {
                switch (s.lastHealthStatus) {
                  case "ok":
                    return <Badge className="bg-green-600 hover:bg-green-700 text-white"><CheckCircle className="h-3 w-3 mr-1" />Healthy</Badge>;
                  case "auth_failed":
                    return <Badge variant="destructive"><AlertCircle className="h-3 w-3 mr-1" />Auth failed</Badge>;
                  case "error":
                    return <Badge variant="destructive"><AlertCircle className="h-3 w-3 mr-1" />Error</Badge>;
                  default:
                    return <Badge variant="outline">Unchecked</Badge>;
                }
              })()}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
