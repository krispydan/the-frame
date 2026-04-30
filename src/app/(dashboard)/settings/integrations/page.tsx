"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plug, ChevronRight, ShoppingBag, DollarSign, CheckCircle, AlertCircle, Circle } from "lucide-react";
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

function StatusBadge({ kind, label }: { kind: "ok" | "warn" | "off"; label: string }) {
  if (kind === "ok") return <Badge className="bg-green-600 hover:bg-green-700"><CheckCircle className="h-3 w-3 mr-1" />{label}</Badge>;
  if (kind === "warn") return <Badge variant="destructive"><AlertCircle className="h-3 w-3 mr-1" />{label}</Badge>;
  return <Badge variant="outline"><Circle className="h-3 w-3 mr-1" />{label}</Badge>;
}

export default function IntegrationsIndexPage() {
  const [shopifyShops, setShopifyShops] = useState<ShopifyShop[] | null>(null);
  const [xero, setXero] = useState<XeroStatus | null>(null);

  useEffect(() => {
    fetch("/api/v1/integrations/shopify")
      .then((r) => r.json())
      .then((d) => setShopifyShops(d.shops || []))
      .catch(() => setShopifyShops([]));
    fetch("/api/v1/finance/xero")
      .then((r) => r.json())
      .then((d) => setXero(d))
      .catch(() => setXero({ configured: false, connected: false }));
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
        <Link href="/settings/integrations/shopify" className="block group">
          <Card className="transition-shadow group-hover:shadow-md">
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

        <Link href="/settings/integrations/xero" className="block group">
          <Card className="transition-shadow group-hover:shadow-md">
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
      </div>

      <p className="mt-6 text-xs text-muted-foreground">
        Other integrations (Faire, Klaviyo, Resend, Anthropic, OpenAI, etc.) are still configured under Settings via API keys. They&apos;ll move into this page over time as they&apos;re upgraded to OAuth.
      </p>
    </div>
  );
}
