"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Plug, AlertCircle, CheckCircle, Loader2, Trash2, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { XeroAccountMapping } from "@/modules/integrations/components/xero-account-mapping";

type XeroStatus = {
  configured: boolean;
  connected: boolean;
  tenantName?: string;
  connectedAt?: string;
  authUrl?: string | null;
  setupInstructions?: string;
};

function XeroIntegrationsPageInner() {
  const search = useSearchParams();
  const [status, setStatus] = useState<XeroStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ kind: "success" | "error"; title: string; message: string } | null>(null);

  useEffect(() => {
    const connected = search?.get("connected");
    const errorCode = search?.get("error");
    const errorMessage = search?.get("error_message");
    if (connected) {
      setBanner({ kind: "success", title: "Connected", message: `${connected} is now connected to the-frame.` });
    } else if (errorCode) {
      setBanner({ kind: "error", title: `Connection failed (${errorCode})`, message: errorMessage || "Try again." });
    }
  }, [search]);

  async function reload() {
    const res = await fetch("/api/v1/finance/xero");
    setStatus(await res.json());
  }

  useEffect(() => { reload(); }, []);

  async function disconnect() {
    if (!confirm("Disconnect Xero? You can reconnect any time.")) return;
    setBusy(true);
    try {
      await fetch("/api/v1/finance/xero", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "disconnect" }),
      });
      await reload();
      setBanner({ kind: "success", title: "Disconnected", message: "Xero is no longer connected." });
    } finally {
      setBusy(false);
    }
  }

  function startConnect() {
    // Go through our /api/auth/xero start route (state CSRF cookie)
    window.location.href = "/api/auth/xero";
  }

  return (
    <div className="container mx-auto p-6 max-w-4xl">
      <div className="mb-6">
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <Plug className="h-7 w-7" />
          Xero
        </h1>
        <p className="text-muted-foreground mt-2">
          Sync Shopify and Faire payouts as journal entries in your Xero ledger.
        </p>
      </div>

      {banner && (
        <Alert className="mb-6" variant={banner.kind === "error" ? "destructive" : "default"}>
          {banner.kind === "error" ? <AlertCircle className="h-4 w-4" /> : <CheckCircle className="h-4 w-4" />}
          <AlertTitle>{banner.title}</AlertTitle>
          <AlertDescription>{banner.message}</AlertDescription>
        </Alert>
      )}

      {!status ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Loading...</CardContent>
        </Card>
      ) : !status.configured ? (
        <Card>
          <CardHeader>
            <CardTitle>Xero is not configured</CardTitle>
            <CardDescription>
              Set <code>XERO_CLIENT_ID</code> and <code>XERO_CLIENT_SECRET</code> in the Railway environment, then refresh this page.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {status.setupInstructions && (
              <pre className="text-xs bg-muted p-3 rounded whitespace-pre-wrap">{status.setupInstructions}</pre>
            )}
          </CardContent>
        </Card>
      ) : !status.connected ? (
        <Card>
          <CardHeader>
            <CardTitle>Connect to Xero</CardTitle>
            <CardDescription>
              You'll be redirected to Xero to approve scopes for accounting data. After approval you'll be sent back here.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={startConnect} size="lg">
              <Plug className="h-4 w-4 mr-2" />
              Connect to Xero
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>Connected</span>
              <Badge className="bg-green-600 hover:bg-green-700"><CheckCircle className="h-3 w-3 mr-1" />Healthy</Badge>
            </CardTitle>
            <CardDescription>Active Xero connection. Tokens auto-refresh before expiry.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div>
                <div className="text-muted-foreground">Organisation</div>
                <div className="font-medium flex items-center gap-1">
                  {status.tenantName || "—"}
                  <a href="https://go.xero.com" target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground">
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Connected</div>
                <div className="font-medium">{status.connectedAt ? new Date(status.connectedAt).toLocaleString() : "—"}</div>
              </div>
            </div>

            <div className="flex gap-2 pt-2 border-t">
              <Button variant="outline" onClick={startConnect} disabled={busy}>
                Reconnect
              </Button>
              <Button variant="outline" onClick={disconnect} disabled={busy}>
                <Trash2 className="h-4 w-4 mr-2" />
                Disconnect
              </Button>
            </div>

          </CardContent>
        </Card>
      )}

      {status?.connected && (
        <div className="mt-6">
          <XeroAccountMapping />
        </div>
      )}
    </div>
  );
}

export default function XeroIntegrationsPage() {
  return (
    <Suspense fallback={<div className="p-6">Loading...</div>}>
      <XeroIntegrationsPageInner />
    </Suspense>
  );
}
