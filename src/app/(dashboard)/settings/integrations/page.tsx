"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plug, ChevronRight, ShoppingBag, DollarSign, Warehouse, MessageSquare, Store, Package, CheckCircle, AlertCircle, Circle } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ApiKeyCard } from "./api-key-card";

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

type SlackStatus = {
  configured: boolean;
  auth: { ok: boolean; team?: string };
  routing: Array<{ topic: string; channelId: string | null }>;
};

type ShipHeroStatus = {
  configured: boolean;
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
  const [slack, setSlack] = useState<SlackStatus | null>(null);

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
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        // Older response shape included a bunch of derived fields; we only
        // need configured here. Guard so a partial response doesn't render
        // "Not configured" when the endpoint actually returned 200.
        setShiphero({ configured: !!d.configured });
      })
      .catch(() => setShiphero({ configured: false }));
    fetch("/api/v1/integrations/slack")
      .then((r) => r.json())
      .then((d) => setSlack(d))
      .catch(() => setSlack({ configured: false, auth: { ok: false }, routing: [] }));
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

  const slackRouted = slack?.routing.filter((r) => r.channelId).length ?? 0;
  const slackStatusKind: "ok" | "warn" | "off" =
    slack === null ? "off" :
    !slack.configured ? "off" :
    !slack.auth.ok ? "warn" :
    slackRouted === 0 ? "warn" :
    "ok";
  const slackLabel =
    slack === null ? "Loading" :
    !slack.configured ? "Not configured" :
    !slack.auth.ok ? "Auth failed" :
    slackRouted === 0 ? `Connected: ${slack.auth.team || "—"} (no routes)` :
    `Connected: ${slack.auth.team || "—"} (${slackRouted} routes)`;

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

        <Link href="/settings/integrations/shiphero" className="block group cursor-pointer">
          <Card className="transition-all group-hover:shadow-md group-hover:border-primary/40">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center justify-between text-base">
                <span className="flex items-center gap-2">
                  <Warehouse className="h-5 w-5" />
                  ShipHero
                </span>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </CardTitle>
              <CardDescription>3PL warehouse. Order Allocated and Shipment Update webhooks; Faire packing-slip attachment.</CardDescription>
            </CardHeader>
            <CardContent>
              <StatusBadge
                kind={shiphero === null ? "off" : shiphero.configured ? "ok" : "off"}
                label={
                  shiphero === null
                    ? "Loading"
                    : shiphero.configured
                    ? "Configured"
                    : "Not configured"
                }
              />
            </CardContent>
          </Card>
        </Link>

        <Link href="/settings/integrations/faire" className="block group cursor-pointer">
          <Card className="transition-all group-hover:shadow-md group-hover:border-primary/40">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center justify-between text-base">
                <span className="flex items-center gap-2">
                  <Store className="h-5 w-5" />
                  Faire
                </span>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </CardTitle>
              <CardDescription>Wholesale marketplace. Auto-marks US Faire orders shipped via the API; configurable postage tiers.</CardDescription>
            </CardHeader>
            <CardContent>
              <StatusBadge kind="ok" label="Env-configured" />
            </CardContent>
          </Card>
        </Link>

        <Link href="/settings/integrations/slack" className="block group cursor-pointer">
          <Card className="transition-all group-hover:shadow-md group-hover:border-primary/40">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center justify-between text-base">
                <span className="flex items-center gap-2">
                  <MessageSquare className="h-5 w-5" />
                  Slack
                </span>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </CardTitle>
              <CardDescription>Real-time alerts + daily / weekly digests posted to your Slack channels.</CardDescription>
            </CardHeader>
            <CardContent>
              <StatusBadge kind={slackStatusKind} label={slackLabel} />
            </CardContent>
          </Card>
        </Link>

        <Link href="/settings/integrations/amazon" className="block group cursor-pointer">
          <Card className="transition-all group-hover:shadow-md group-hover:border-primary/40">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center justify-between text-base">
                <span className="flex items-center gap-2">
                  <Package className="h-5 w-5" />
                  Amazon
                </span>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </CardTitle>
              <CardDescription>
                AI-generated listing copy + template-validated Seller Central upload spreadsheet.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <StatusBadge kind="ok" label="Configured" />
            </CardContent>
          </Card>
        </Link>
      </div>

      <div className="mt-10">
        <h2 className="text-lg font-semibold mb-1">API key integrations</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Integrations that haven&apos;t been upgraded to OAuth yet — just paste an API key.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ApiKeyCard
            title="Klaviyo"
            description="Email marketing and customer data platform"
            settingKey="klaviyo_api_key"
            testSlug="klaviyo"
          />
          <ApiKeyCard
            title="Instantly"
            description="Cold-email campaign automation for the sales pipeline"
            settingKey="instantly_api_key"
            testSlug="instantly"
          />
          <ApiKeyCard
            title="Outscraper"
            description="Business data enrichment — Google Maps reviews, emails, phones"
            settingKey="outscraper_api_key"
            testSlug="outscraper"
          />
        </div>
      </div>

      <p className="mt-6 text-xs text-muted-foreground">
        Anthropic, OpenAI, Resend keys are set via environment variables on Railway. Faire uses <code>FAIRE_API_TOKEN</code>.
      </p>
    </div>
  );
}
