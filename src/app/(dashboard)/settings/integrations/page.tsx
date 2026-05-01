"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plug, ChevronRight, ShoppingBag, DollarSign, Warehouse, CheckCircle, AlertCircle, Circle } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type ShopifyShop = {
  id: string;
  shopDomain: string;
  channel: string;
  isActive: boolean;
  lastHealthStatus: string | null;
};

type XeroStatus = {
  configured: boolean;
  connected: boolean;
  tenantName?: string;
};

type ShipHeroStatus = {
  configured: boolean;
  health: "ok" | "warn" | "off";
  inventory: { lastSyncedAt: string | null; skuCount: number; skusWithStock: number };
  orders: { lastSyncedAt: string | null; matchedOrders: number; shipmentCount: number };
  recentJobs: Array<{ type: string; status: string; error: string | null; completedAt: string | null }>;
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function StatusBadge({ kind, label }: { kind: "ok" | "warn" | "off"; label: string }) {
  if (kind === "ok") return <Badge className="bg-green-600 hover:bg-green-700"><CheckCircle className="h-3 w-3 mr-1" />{label}</Badge>;
  if (kind === "warn") return <Badge variant="destructive"><AlertCircle className="h-3 w-3 mr-1" />{label}</Badge>;
  return <Badge variant="outline"><Circle className="h-3 w-3 mr-1" />{label}</Badge>;
}

export default function IntegrationsIndexPage() {
  const [shopifyShops, setShopifyShops] = useState<ShopifyShop[] | null>(null);
  const [xero, setXero] = useState<XeroStatus | null>(null);
  const [shiphero, setShiphero] = useState<ShipHeroStatus | null>(null);

  useEffect(() => {
    fetch("/api/v1/integrations/shopify")
      .then((r) => r.json())
      .then((d) => setShopifyShops(d.shops || []))
      .catch(() => setShopifyShops([]));
    fetch("/api/v1/finance/xero")
      .then((r) => r.json())
      .then((d) => setXero(d))
      .catch(() => setXero({ configured: false, connected: false }));
    fetch("/api/v1/integrations/shiphero")
      .then((r) => r.json())
      .then((d) => setShiphero(d))
      .catch(() => setShiphero(null));
  }, []);

  const shopifyActive = shopifyShops?.filter((s) => s.isActive) ?? [];
  const shopifyFailed = shopifyActive.filter((s) => s.lastHealthStatus && s.lastHealthStatus !== "ok");
  const shopifyStatusKind: "ok" | "warn" | "off" =
    shopifyShops === null ? "off" :
    shopifyActive.length === 0 ? "off" :
    shopifyFailed.length > 0 ? "warn" : "ok";
  const shopifyLabel =
    shopifyShops === null ? "Loading" :
    shopifyActive.length === 0 ? "Not connected" :
    shopifyFailed.length > 0 ? `${shopifyFailed.length} failing` :
    `${shopifyActive.length} connected`;

  const xeroStatusKind: "ok" | "warn" | "off" =
    xero === null ? "off" :
    !xero.configured ? "off" :
    !xero.connected ? "off" :
    "ok";
  const xeroLabel =
    xero === null ? "Loading" :
    !xero.configured ? "Not configured" :
    !xero.connected ? "Not connected" :
    `Connected: ${xero.tenantName || "Xero"}`;

  return (
    <div className="container mx-auto p-6 max-w-5xl">
      <div className="mb-6">
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <Plug className="h-7 w-7" />
          Integrations
        </h1>
        <p className="text-muted-foreground mt-2">
          External services the-frame talks to. Add or manage credentials per integration.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Link href="/settings/integrations/shopify" className="block group cursor-pointer">
          <Card className="transition-all group-hover:shadow-md group-hover:border-primary/40">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center justify-between text-base">
                <span className="flex items-center gap-2">
                  <ShoppingBag className="h-5 w-5" />
                  Shopify
                </span>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </CardTitle>
              <CardDescription>Retail and wholesale Shopify stores. OAuth tokens, webhooks, order sync.</CardDescription>
            </CardHeader>
            <CardContent>
              <StatusBadge kind={shopifyStatusKind} label={shopifyLabel} />
              {shopifyActive.length > 0 && (
                <div className="mt-3 text-sm text-muted-foreground">
                  {shopifyActive.map((s) => s.shopDomain.replace(".myshopify.com", "")).join(" · ")}
                </div>
              )}
            </CardContent>
          </Card>
        </Link>

        <Link href="/settings/integrations/xero" className="block group cursor-pointer">
          <Card className="transition-all group-hover:shadow-md group-hover:border-primary/40">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center justify-between text-base">
                <span className="flex items-center gap-2">
                  <DollarSign className="h-5 w-5" />
                  Xero
                </span>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </CardTitle>
              <CardDescription>Per-payout journal entries for Shopify and Faire. Account mapping, sync history.</CardDescription>
            </CardHeader>
            <CardContent>
              <StatusBadge kind={xeroStatusKind} label={xeroLabel} />
            </CardContent>
          </Card>
        </Link>

        {/* ShipHero */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center justify-between text-base">
              <span className="flex items-center gap-2">
                <Warehouse className="h-5 w-5" />
                ShipHero
              </span>
            </CardTitle>
            <CardDescription>Warehouse inventory levels and order fulfillment tracking. Syncs hourly during PST business hours.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <StatusBadge
              kind={shiphero?.health ?? "off"}
              label={
                shiphero === null ? "Loading" :
                !shiphero.configured ? "Not configured" :
                shiphero.health === "ok" ? "Syncing" :
                shiphero.health === "warn" ? "Sync issue" :
                "Inactive"
              }
            />
            {shiphero?.configured && (
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Inventory SKUs</span>
                  <span className="font-medium">{shiphero.inventory.skuCount} ({shiphero.inventory.skusWithStock} in stock)</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Orders matched</span>
                  <span className="font-medium">{shiphero.orders.matchedOrders}</span>
                </div>
                {shiphero.inventory.lastSyncedAt && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Last inventory sync</span>
                    <span className="font-medium">{timeAgo(shiphero.inventory.lastSyncedAt)}</span>
                  </div>
                )}
                {shiphero.orders.lastSyncedAt && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Last order sync</span>
                    <span className="font-medium">{timeAgo(shiphero.orders.lastSyncedAt)}</span>
                  </div>
                )}
                {shiphero.recentJobs.length > 0 && (
                  <div className="pt-2 border-t">
                    <p className="text-xs text-muted-foreground mb-1">Recent jobs</p>
                    <div className="space-y-1">
                      {shiphero.recentJobs.slice(0, 4).map((j, i) => (
                        <div key={i} className="flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">{j.type.replace("sync-", "")}</span>
                          <span className="flex items-center gap-1.5">
                            {j.status === "completed" && <CheckCircle className="h-3 w-3 text-green-500" />}
                            {j.status === "failed" && <AlertCircle className="h-3 w-3 text-red-500" />}
                            {j.status === "pending" && <Circle className="h-3 w-3 text-muted-foreground" />}
                            {j.status === "running" && <Circle className="h-3 w-3 text-blue-500" />}
                            {j.completedAt ? timeAgo(j.completedAt) : j.status}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <p className="mt-6 text-xs text-muted-foreground">
        Other integrations (Faire, Klaviyo, Resend, Anthropic, OpenAI, etc.) are still configured under Settings via API keys. They&apos;ll move into this page over time as they&apos;re upgraded to OAuth.
      </p>
    </div>
  );
}
