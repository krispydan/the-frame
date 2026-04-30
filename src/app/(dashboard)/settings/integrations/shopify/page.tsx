"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Plus, RefreshCw, Trash2, AlertCircle, CheckCircle, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Shop = {
  id: string;
  shopDomain: string;
  displayName: string | null;
  channel: string;
  scope: string | null;
  apiVersion: string | null;
  isActive: boolean;
  lastHealthCheckAt: string | null;
  lastHealthStatus: string | null;
  lastHealthError: string | null;
  installedAt: string | null;
  uninstalledAt: string | null;
};

function statusBadge(s: Shop) {
  if (!s.isActive) return <Badge variant="secondary">Disconnected</Badge>;
  switch (s.lastHealthStatus) {
    case "ok":
      return <Badge className="bg-green-600 hover:bg-green-700"><CheckCircle className="h-3 w-3 mr-1" />Healthy</Badge>;
    case "auth_failed":
      return <Badge variant="destructive"><AlertCircle className="h-3 w-3 mr-1" />Auth failed</Badge>;
    case "error":
      return <Badge variant="destructive"><AlertCircle className="h-3 w-3 mr-1" />Error</Badge>;
    case "uninstalled":
      return <Badge variant="secondary">Uninstalled by merchant</Badge>;
    default:
      return <Badge variant="outline">Unchecked</Badge>;
  }
}

function ShopifyIntegrationsPageInner() {
  const search = useSearchParams();
  const [shops, setShops] = useState<Shop[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [connectOpen, setConnectOpen] = useState(false);
  const [newShopDomain, setNewShopDomain] = useState("");
  const [newChannel, setNewChannel] = useState("retail");
  const [banner, setBanner] = useState<{ kind: "success" | "error"; title: string; message: string } | null>(null);

  const connectedDomain = search?.get("connected") || null;
  const errorCode = search?.get("error") || null;
  const errorMessage = search?.get("error_message") || null;

  useEffect(() => {
    if (connectedDomain) {
      setBanner({ kind: "success", title: "Connected", message: `${connectedDomain} is now connected and ready to use.` });
    } else if (errorCode) {
      setBanner({ kind: "error", title: `Connection failed (${errorCode})`, message: errorMessage || "Try again." });
    }
  }, [connectedDomain, errorCode, errorMessage]);

  async function reload() {
    setLoading(true);
    try {
      const res = await fetch("/api/v1/integrations/shopify");
      const data = await res.json();
      setShops(data.shops || []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { reload(); }, []);

  async function runHealth(shop: Shop) {
    setBusy((b) => ({ ...b, [shop.id]: true }));
    try {
      await fetch(`/api/v1/integrations/shopify/${shop.id}/health`, { method: "POST" });
      await reload();
    } finally {
      setBusy((b) => ({ ...b, [shop.id]: false }));
    }
  }

  async function disconnect(shop: Shop) {
    if (!confirm(`Disconnect ${shop.shopDomain}? You can reconnect any time. (This does NOT uninstall from Shopify.)`)) return;
    setBusy((b) => ({ ...b, [shop.id]: true }));
    try {
      await fetch(`/api/v1/integrations/shopify/${shop.id}`, { method: "DELETE" });
      await reload();
    } finally {
      setBusy((b) => ({ ...b, [shop.id]: false }));
    }
  }

  function startConnect() {
    if (!newShopDomain.trim()) return;
    let domain = newShopDomain.trim().toLowerCase();
    if (!domain.endsWith(".myshopify.com")) {
      // Allow "getjaxy" shorthand
      domain = `${domain.replace(/\.myshopify\.com$/, "")}.myshopify.com`;
    }
    const url = `/api/auth/shopify?shop=${encodeURIComponent(domain)}&channel=${encodeURIComponent(newChannel)}`;
    window.location.href = url;
  }

  const failedShops = shops.filter((s) => s.isActive && (s.lastHealthStatus === "auth_failed" || s.lastHealthStatus === "error"));

  return (
    <div className="container mx-auto p-6 max-w-6xl">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Shopify Integrations</h1>
          <p className="text-muted-foreground mt-2">
            Connect retail and wholesale Shopify stores. Tokens are stored securely and used by catalog exports, order sync, and inventory updates.
          </p>
        </div>
        <Dialog open={connectOpen} onOpenChange={setConnectOpen}>
          <Button onClick={() => setConnectOpen(true)}><Plus className="h-4 w-4 mr-2" />Connect a store</Button>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Connect a Shopify store</DialogTitle>
              <DialogDescription>
                Enter the store's <code>.myshopify.com</code> domain. You'll be sent to Shopify to approve the scopes, then bounced back here.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <Label>Store domain</Label>
                <Input value={newShopDomain} onChange={(e) => setNewShopDomain(e.target.value)} placeholder="getjaxy.myshopify.com" />
                <p className="text-xs text-muted-foreground mt-1">Or just the slug (e.g. <code>getjaxy</code>) — we'll append <code>.myshopify.com</code>.</p>
              </div>
              <div>
                <Label>Channel</Label>
                <Select value={newChannel} onValueChange={(v) => setNewChannel(v ?? "retail")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="retail">Retail (DTC)</SelectItem>
                    <SelectItem value="wholesale">Wholesale</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground mt-1">Determines which catalog/orders/sync operations target this store.</p>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConnectOpen(false)}>Cancel</Button>
              <Button onClick={startConnect}>Continue to Shopify</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {banner && (
        <Alert className="mb-6" variant={banner.kind === "error" ? "destructive" : "default"}>
          {banner.kind === "error" ? <AlertCircle className="h-4 w-4" /> : <CheckCircle className="h-4 w-4" />}
          <AlertTitle>{banner.title}</AlertTitle>
          <AlertDescription>{banner.message}</AlertDescription>
        </Alert>
      )}

      {failedShops.length > 0 && (
        <Alert className="mb-6" variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Connection issue on {failedShops.length} store{failedShops.length === 1 ? "" : "s"}</AlertTitle>
          <AlertDescription>
            {failedShops.map((s) => (
              <div key={s.id}>
                <strong>{s.shopDomain}</strong>: {s.lastHealthError || s.lastHealthStatus}
              </div>
            ))}
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Connected stores</CardTitle>
          <CardDescription>Click "Test" to validate the stored token against Shopify's API.</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : shops.length === 0 ? (
            <p className="text-sm text-muted-foreground">No stores connected yet. Click "Connect a store" above to start.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Store</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>API Version</TableHead>
                  <TableHead>Last Check</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shops.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>
                      <div className="font-medium">{s.displayName || s.shopDomain.replace(".myshopify.com", "")}</div>
                      <div className="text-xs text-muted-foreground font-mono flex items-center gap-1">
                        {s.shopDomain}
                        <a href={`https://${s.shopDomain}/admin`} target="_blank" rel="noreferrer" className="hover:text-foreground">
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </div>
                    </TableCell>
                    <TableCell><Badge variant="outline">{s.channel}</Badge></TableCell>
                    <TableCell>{statusBadge(s)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{s.apiVersion}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{s.lastHealthCheckAt ? new Date(s.lastHealthCheckAt).toLocaleString() : "—"}</TableCell>
                    <TableCell className="text-right space-x-1">
                      <Button size="sm" variant="ghost" onClick={() => runHealth(s)} disabled={busy[s.id]}>
                        <RefreshCw className={`h-3 w-3 mr-1 ${busy[s.id] ? "animate-spin" : ""}`} />
                        Test
                      </Button>
                      {s.isActive ? (
                        <Button size="sm" variant="ghost" onClick={() => {
                          window.location.href = `/api/auth/shopify?shop=${encodeURIComponent(s.shopDomain)}&channel=${encodeURIComponent(s.channel)}`;
                        }}>Reconnect</Button>
                      ) : (
                        <Button size="sm" variant="ghost" onClick={() => {
                          window.location.href = `/api/auth/shopify?shop=${encodeURIComponent(s.shopDomain)}&channel=${encodeURIComponent(s.channel)}`;
                        }}>Connect</Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => disconnect(s)} disabled={busy[s.id] || !s.isActive}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function ShopifyIntegrationsPage() {
  return (
    <Suspense fallback={<div className="p-6">Loading...</div>}>
      <ShopifyIntegrationsPageInner />
    </Suspense>
  );
}
